use crate::AppState;
use arc_recall_core::backup_management::{BackupEntry, BackupManager, BackupPolicy, BackupStatus};
use tauri::{Manager, State};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackupOverview {
    status: BackupStatus,
    entries: Vec<BackupEntry>,
}

fn overview(state: &AppState) -> Result<BackupOverview, String> {
    let manager = BackupManager::open(&state.paths.root)?;
    let mut entries = manager.list()?;
    for item in std::fs::read_dir(&state.paths.exports).map_err(|e| e.to_string())? {
        let item = item.map_err(|e| e.to_string())?;
        let path = item.path();
        let name = item.file_name().to_string_lossy().into_owned();
        if !name.starts_with("arcrecall-database-")
            || !name.ends_with(".arcrecall")
            || !item.file_type().map_err(|e| e.to_string())?.is_file()
        {
            continue;
        }
        let metadata = item.metadata().map_err(|e| e.to_string())?;
        let created_at_ms = metadata
            .modified()
            .ok()
            .and_then(|v| v.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |v| v.as_millis() as u64);
        entries.push(BackupEntry {
            path,
            created_at_ms,
            byte_count: metadata.len(),
            automatic: false,
            exists: true,
        });
    }
    entries.sort_by_key(|v| std::cmp::Reverse(v.created_at_ms));
    Ok(BackupOverview {
        status: manager.status()?,
        entries,
    })
}

#[tauri::command]
pub(crate) async fn backup_management_get(app: tauri::AppHandle) -> Result<BackupOverview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _guard = state.data_maintenance.lock().map_err(|e| e.to_string())?;
        overview(&state)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub(crate) async fn backup_policy_save(
    app: tauri::AppHandle,
    policy: BackupPolicy,
) -> Result<BackupOverview, String> {
    let lease = app.state::<AppState>().lifecycle.begin()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _lease = lease;
        let state = app.state::<AppState>();
        let _guard = state.data_maintenance.lock().map_err(|e| e.to_string())?;
        BackupManager::open(&state.paths.root)?.configure(policy)?;
        overview(&state)
    })
    .await
    .map_err(|e| e.to_string())?
}

// An exclusive idle lease excludes imports, archive work, shutdown and updates throughout the worker.
fn run(state: &AppState, force: bool) -> Result<bool, String> {
    let _lease = match state.lifecycle.reserve_idle_maintenance() {
        Ok(lease) => lease,
        Err(error) if force => return Err(error),
        Err(_) => return Ok(false),
    };
    let _reservation = crate::task_coordination::TaskStartReservation::acquire(
        &state.archive_task_starting,
        "请等待归档任务完成后再备份。",
    )?;
    crate::ensure_no_active_archive_task(state)?;
    let _guard = state.data_maintenance.lock().map_err(|e| e.to_string())?;
    let manager = BackupManager::open(&state.paths.root)?;
    if !force && !manager.status()?.due(crate::current_time_ms()) {
        return Ok(false);
    }
    let dictionary = state.dictionary.lock().map_err(|e| e.to_string())?;
    let _history = state.history.lock().map_err(|e| e.to_string())?;
    let settings = state.settings.lock().map_err(|e| e.to_string())?;
    manager.run(
        &state.paths,
        &dictionary,
        &settings,
        crate::current_time_ms(),
        force,
    )
}
#[tauri::command]
pub(crate) async fn backup_run_now(app: tauri::AppHandle) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || run(&app.state::<AppState>(), true))
        .await
        .map_err(|e| e.to_string())?
}
pub(crate) fn start(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        loop {
            let state: State<'_, AppState> = app.state();
            if state.exit_ready.load(std::sync::atomic::Ordering::Acquire) {
                break;
            }
            if let Err(error) = run(&state, false) {
                crate::write_log(
                    &state.logger,
                    crate::logging::LogLevel::Warn,
                    "backup",
                    "backup.automatic_failed",
                    "自动备份未完成。",
                    [("error".into(), error)],
                );
            }
            std::thread::sleep(std::time::Duration::from_secs(60));
        }
    });
}
