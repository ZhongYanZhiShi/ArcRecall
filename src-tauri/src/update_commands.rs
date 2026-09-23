use std::sync::{Mutex, atomic::AtomicBool};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::{AppState, current_time_ms, task_coordination::TaskStartReservation};

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateStatus {
    current_version: String,
    configured: bool,
    auto_update: bool,
    phase: &'static str,
    version: Option<String>,
    notes: Option<String>,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    last_checked: Option<u64>,
    error: Option<String>,
}

#[derive(Default)]
struct PendingUpdate {
    status: UpdateStatus,
    update: Option<Update>,
    bytes: Option<Vec<u8>>,
}

#[derive(Default)]
pub(crate) struct AppUpdater {
    busy: AtomicBool,
    pending: Mutex<PendingUpdate>,
}

impl AppUpdater {
    fn change(&self, change: impl FnOnce(&mut PendingUpdate)) {
        change(&mut self.pending.lock().unwrap_or_else(|e| e.into_inner()));
    }

    fn fail(&self, error: String) {
        self.change(|pending| {
            pending.status.phase = if pending.bytes.is_some() {
                "ready"
            } else if pending.update.is_some() {
                "available"
            } else {
                "error"
            };
            pending.status.error = Some(error);
        });
    }
}

fn configured(app: &AppHandle) -> bool {
    cfg!(all(target_os = "windows", target_arch = "x86_64"))
        && app
            .config()
            .plugins
            .0
            .get("updater")
            .and_then(|config| config.get("pubkey"))
            .and_then(|key| key.as_str())
            .is_some_and(|key| !key.trim().is_empty())
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum UpdateCheckReason {
    Manual,
    Startup,
    Scheduled,
}

impl UpdateCheckReason {
    fn should_check(self, auto_update: bool) -> bool {
        self != Self::Scheduled || auto_update
    }

    fn should_download(self, auto_update: bool) -> bool {
        self != Self::Manual && auto_update
    }
}

#[tauri::command]
pub(crate) fn app_update_status(
    app: AppHandle,
    state: State<'_, AppState>,
    updater: State<'_, AppUpdater>,
) -> Result<UpdateStatus, String> {
    let mut status = updater
        .pending
        .lock()
        .map_err(|e| e.to_string())?
        .status
        .clone();
    status.current_version = app.package_info().version.to_string();
    status.configured = configured(&app);
    status.auto_update = state
        .settings
        .lock()
        .map_err(|e| e.to_string())?
        .load()
        .map_err(|e| e.to_string())?
        .auto_update;
    if status.phase.is_empty() {
        status.phase = "idle";
    }
    Ok(status)
}

#[tauri::command]
pub(crate) async fn app_update_check(
    app: AppHandle,
    state: State<'_, AppState>,
    updater: State<'_, AppUpdater>,
    reason: UpdateCheckReason,
) -> Result<(), String> {
    if reason != UpdateCheckReason::Manual {
        let enabled = state
            .settings
            .lock()
            .map_err(|e| e.to_string())?
            .load()
            .map_err(|e| e.to_string())?
            .auto_update;
        if !reason.should_check(enabled) || !configured(&app) {
            return Ok(());
        }
    }
    let _reservation = TaskStartReservation::acquire(&updater.busy, "正在处理更新，请稍候。")?;
    // Preserve the verified download until the user installs it or quits.
    if updater
        .pending
        .lock()
        .map_err(|e| e.to_string())?
        .bytes
        .is_some()
    {
        return Ok(());
    }
    if !configured(&app) {
        return Err("此构建尚未配置更新签名，或当前平台没有可用的更新通道。".into());
    }
    updater.change(|pending| {
        pending.status.phase = "checking";
        pending.status.error = None;
    });
    let result = async {
        let update = app
            .updater_builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?
            .check()
            .await
            .map_err(|e| format!("检查更新失败，请检查网络后重试：{e}"))?;
        updater.change(|pending| {
            pending.status.phase = if update.is_some() {
                "available"
            } else {
                "current"
            };
            pending.status.version = update.as_ref().map(|item| item.version.clone());
            pending.status.notes = update.as_ref().and_then(|item| item.body.clone());
            pending.status.last_checked = Some(current_time_ms());
            pending.update = update;
        });
        // Re-read the preference: disabling automatic updates during a check prevents download.
        let auto_download = reason.should_download(
            state
                .settings
                .lock()
                .map_err(|e| e.to_string())?
                .load()
                .map_err(|e| e.to_string())?
                .auto_update,
        );
        if auto_download
            && updater
                .pending
                .lock()
                .map_err(|e| e.to_string())?
                .update
                .is_some()
        {
            download(&updater).await?;
        }
        Ok::<_, String>(())
    }
    .await;
    if let Err(error) = &result {
        updater.fail(error.clone());
    }
    result
}

async fn download(updater: &AppUpdater) -> Result<(), String> {
    let mut update = updater
        .pending
        .lock()
        .map_err(|e| e.to_string())?
        .update
        .clone()
        .ok_or("请先检查更新。")?;
    // Full installers include recovery engines and can take a while to transfer.
    update.timeout = Some(Duration::from_secs(60 * 60));
    updater.change(|pending| {
        pending.status.phase = "downloading";
        pending.status.error = None;
        pending.status.downloaded_bytes = 0;
        pending.status.total_bytes = None;
    });
    let bytes = update
        .download(
            |chunk, total| {
                updater.change(|pending| {
                    pending.status.downloaded_bytes += chunk as u64;
                    pending.status.total_bytes = total;
                })
            },
            || {},
        )
        .await
        .map_err(|e| format!("下载或签名校验失败，请重试：{e}"))?;
    updater.change(|pending| {
        pending.bytes = Some(bytes);
        pending.status.phase = "ready";
    });
    Ok(())
}

#[tauri::command]
pub(crate) async fn app_update_download(updater: State<'_, AppUpdater>) -> Result<(), String> {
    let _reservation = TaskStartReservation::acquire(&updater.busy, "正在处理更新，请稍候。")?;
    if updater
        .pending
        .lock()
        .map_err(|e| e.to_string())?
        .bytes
        .is_some()
    {
        return Ok(());
    }
    let result = download(&updater).await;
    if let Err(error) = &result {
        updater.fail(error.clone());
    }
    result
}

#[tauri::command]
pub(crate) async fn app_update_install(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let updater = app.state::<AppUpdater>();
        let _reservation = TaskStartReservation::acquire(&updater.busy, "正在处理更新，请稍候。")?;
        let state = app.state::<AppState>();
        let _idle = state.lifecycle.reserve_update()?;
        let mut pending = updater.pending.lock().map_err(|e| e.to_string())?;
        let update = pending.update.clone().ok_or("请先检查更新。")?;
        let bytes = pending.bytes.as_ref().ok_or("请先下载更新。")?;
        // install() launches the Windows installer and exits this process on success.
        // The lifecycle reservation prevents new archive tasks racing this call.
        if let Err(error) = update.install(bytes) {
            pending.status.error = Some(format!("安装更新失败：{error}"));
            return Err(format!("安装更新失败：{error}"));
        }
        state
            .exit_ready
            .store(true, std::sync::atomic::Ordering::Release);
        app.restart();
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::UpdateCheckReason;

    #[test]
    fn startup_always_checks_but_download_and_scheduled_checks_follow_preference() {
        for enabled in [false, true] {
            assert!(UpdateCheckReason::Startup.should_check(enabled));
            assert_eq!(UpdateCheckReason::Startup.should_download(enabled), enabled);
            assert_eq!(UpdateCheckReason::Scheduled.should_check(enabled), enabled);
            assert_eq!(
                UpdateCheckReason::Scheduled.should_download(enabled),
                enabled
            );
            assert!(UpdateCheckReason::Manual.should_check(enabled));
            assert!(!UpdateCheckReason::Manual.should_download(enabled));
        }
    }
}
