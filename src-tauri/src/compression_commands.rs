use std::panic::AssertUnwindSafe;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use arc_recall_core::{
    CancellationToken, CompressionError, CompressionFormat, CompressionJob, CompressionPhase,
    CompressionUpdate, compress_archive, path_for_display, prepare_compression,
};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::engine_commands::require_seven_zip;
use crate::logging::LogLevel;
use crate::task_coordination::TaskStartReservation;
use crate::{
    AppState, current_time_ms, ensure_no_active_archive_task, panic_payload_message, write_log,
};

static COMPRESSION_TASK_SEQUENCE: AtomicU64 = AtomicU64::new(1);
const COMPRESSION_PASSWORD_KEYRING_SERVICE: &str = "ArcRecall Archive Password";
const COMPRESSION_PASSWORD_KEYRING_ACCOUNT: &str = "permanent";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CompressionStartRequest {
    sources: Vec<String>,
    output_directory: Option<String>,
    base_name: String,
    #[serde(default)]
    format: CompressionFormat,
    #[serde(default = "default_compression_level")]
    level: u8,
    password: Option<String>,
    #[serde(default)]
    use_permanent_password: bool,
    #[serde(default)]
    encrypt_file_names: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CompressionTaskStatus {
    task_id: String,
    phase: CompressionPhase,
    running: bool,
    completed: bool,
    success: bool,
    cancelled: bool,
    message: String,
    processed_source_count: u64,
    total_source_count: u64,
    started_at_ms: u64,
    elapsed_ms: u64,
    output_path: String,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CompressionPasswordStatus {
    has_password: bool,
}

pub(crate) struct CompressionTaskHandle {
    id: String,
    cancellation: CancellationToken,
    status: Arc<Mutex<CompressionTaskStatus>>,
}

impl CompressionTaskHandle {
    pub(crate) fn is_running(&self) -> Result<bool, String> {
        self.status
            .lock()
            .map(|status| status.running)
            .map_err(|error| error.to_string())
    }
}

const fn default_compression_level() -> u8 {
    5
}

#[tauri::command]
pub(crate) fn compression_password_status() -> Result<CompressionPasswordStatus, String> {
    Ok(CompressionPasswordStatus {
        has_password: get_permanent_compression_password()?.is_some(),
    })
}

#[tauri::command]
pub(crate) fn compression_password_save(
    state: State<'_, AppState>,
    password: String,
) -> Result<CompressionPasswordStatus, String> {
    set_permanent_compression_password(&password)?;
    write_log(
        &state.logger,
        LogLevel::Info,
        "compression",
        "compression.password_saved",
        "归档永久密码已保存到系统凭据库。",
        std::iter::empty(),
    );
    Ok(CompressionPasswordStatus { has_password: true })
}

#[tauri::command]
pub(crate) fn compression_password_delete(
    state: State<'_, AppState>,
) -> Result<CompressionPasswordStatus, String> {
    delete_permanent_compression_password()?;
    write_log(
        &state.logger,
        LogLevel::Info,
        "compression",
        "compression.password_deleted",
        "归档永久密码已从系统凭据库删除。",
        std::iter::empty(),
    );
    Ok(CompressionPasswordStatus {
        has_password: false,
    })
}

#[tauri::command]
pub(crate) async fn compression_start(
    state: State<'_, AppState>,
    request: CompressionStartRequest,
) -> Result<CompressionTaskStatus, String> {
    let task_lease = state.lifecycle.begin()?;
    let cancellation = task_lease.cancellation.clone();
    let start_reservation = TaskStartReservation::acquire(
        &state.archive_task_starting,
        "另一个归档任务正在启动，请勿重复提交。",
    )?;
    ensure_no_active_archive_task(&state)?;

    let seven_zip = require_seven_zip(&state).await?;
    if cancellation.is_cancelled() {
        return Err("压缩任务已取消。".into());
    }

    let task_id = next_compression_task_id();
    let password = resolve_compression_password(
        request.password,
        request.use_permanent_password,
        get_permanent_compression_password,
    )?;
    let job = CompressionJob {
        sources: request.sources.into_iter().map(PathBuf::from).collect(),
        output_directory: request
            .output_directory
            .as_deref()
            .filter(|path| !path.trim().is_empty())
            .map(PathBuf::from),
        base_name: request.base_name,
        format: request.format,
        level: request.level,
        password,
        encrypt_file_names: request.encrypt_file_names,
        work_id: task_id.clone(),
    };
    let prepared = tauri::async_runtime::spawn_blocking(move || prepare_compression(job))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;
    if cancellation.is_cancelled() {
        return Err("压缩任务已取消。".into());
    }
    let started_at_ms = current_time_ms();
    let initial = CompressionTaskStatus {
        task_id: task_id.clone(),
        phase: CompressionPhase::Preparing,
        running: true,
        completed: false,
        success: false,
        cancelled: false,
        message: format!(
            "已准备 {} 个来源，等待 7-Zip 启动。",
            prepared.source_count()
        ),
        processed_source_count: 0,
        total_source_count: prepared.source_count(),
        started_at_ms,
        elapsed_ms: 0,
        output_path: path_for_display(prepared.output_path()),
    };
    let status = Arc::new(Mutex::new(initial.clone()));
    {
        let mut current = state
            .compression_task
            .lock()
            .map_err(|error| error.to_string())?;
        *current = Some(CompressionTaskHandle {
            id: task_id.clone(),
            cancellation: cancellation.clone(),
            status: Arc::clone(&status),
        });
    }

    write_log(
        &state.logger,
        LogLevel::Info,
        "compression",
        "compression.started",
        "压缩任务已启动。",
        [
            ("task_id".into(), task_id.clone()),
            (
                "source_count".into(),
                initial.total_source_count.to_string(),
            ),
            (
                "format".into(),
                format!("{:?}", request.format).to_lowercase(),
            ),
        ],
    );

    let status_for_updates = Arc::clone(&status);
    let status_for_result = Arc::clone(&status);
    let logger = Arc::clone(&state.logger);
    std::thread::spawn(move || {
        let _task_lease = task_lease;
        let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
            compress_archive(
                prepared,
                &seven_zip,
                &cancellation,
                |update: CompressionUpdate| {
                    if let Ok(mut task_status) = status_for_updates.lock() {
                        task_status.phase = update.phase;
                        task_status.message = update.message;
                        task_status.processed_source_count = update.processed_source_count;
                        task_status.total_source_count = update.total_source_count;
                    }
                },
            )
        }));
        if let Ok(mut task_status) = status_for_result.lock() {
            task_status.running = false;
            task_status.completed = true;
            task_status.elapsed_ms = current_time_ms().saturating_sub(task_status.started_at_ms);
            match result {
                Ok(Ok(result)) => {
                    task_status.phase = CompressionPhase::Completed;
                    task_status.success = true;
                    task_status.message = "压缩完成。".into();
                    task_status.processed_source_count = result.source_count;
                    task_status.output_path = path_for_display(&result.output_path);
                    drop(task_status);
                    write_log(
                        &logger,
                        LogLevel::Info,
                        "compression",
                        "compression.completed",
                        "压缩任务已完成。",
                        [
                            ("task_id".into(), task_id.clone()),
                            ("source_count".into(), result.source_count.to_string()),
                        ],
                    );
                }
                Ok(Err(CompressionError::Cancelled)) => {
                    task_status.phase = CompressionPhase::Cancelled;
                    task_status.cancelled = true;
                    task_status.message = "压缩任务已取消，临时归档已清理。".into();
                    drop(task_status);
                    write_log(
                        &logger,
                        LogLevel::Warn,
                        "compression",
                        "compression.cancelled",
                        "压缩任务已取消。",
                        [("task_id".into(), task_id.clone())],
                    );
                }
                Ok(Err(error)) => {
                    task_status.phase = CompressionPhase::Failed;
                    task_status.message = error.to_string();
                    drop(task_status);
                    write_log(
                        &logger,
                        LogLevel::Error,
                        "compression",
                        "compression.failed",
                        "压缩任务执行失败。",
                        [("task_id".into(), task_id.clone())],
                    );
                }
                Err(payload) => {
                    task_status.phase = CompressionPhase::Failed;
                    task_status.message = format!(
                        "压缩后台任务异常终止：{}",
                        panic_payload_message(payload.as_ref())
                    );
                    drop(task_status);
                    write_log(
                        &logger,
                        LogLevel::Error,
                        "compression",
                        "compression.panicked",
                        "压缩后台任务异常终止。",
                        [("task_id".into(), task_id.clone())],
                    );
                }
            }
        }
    });

    start_reservation.release();

    Ok(initial)
}

#[tauri::command]
pub(crate) fn compression_status(
    state: State<'_, AppState>,
    task_id: Option<String>,
) -> Result<Option<CompressionTaskStatus>, String> {
    let current = state
        .compression_task
        .lock()
        .map_err(|error| error.to_string())?;
    let Some(task) = current.as_ref() else {
        return Ok(None);
    };
    if task_id.as_deref().is_some_and(|id| id != task.id) {
        return Ok(None);
    }
    let mut status = task
        .status
        .lock()
        .map_err(|error| error.to_string())?
        .clone();
    if status.running {
        status.elapsed_ms = current_time_ms().saturating_sub(status.started_at_ms);
    }
    Ok(Some(status))
}

#[tauri::command]
pub(crate) fn compression_cancel(
    state: State<'_, AppState>,
    task_id: String,
) -> Result<bool, String> {
    let current = state
        .compression_task
        .lock()
        .map_err(|error| error.to_string())?;
    let Some(task) = current.as_ref().filter(|task| task.id == task_id) else {
        return Ok(false);
    };
    let status = task.status.lock().map_err(|error| error.to_string())?;
    if !status.running {
        return Ok(false);
    }
    drop(status);
    task.cancellation.cancel();
    if let Ok(mut status) = task.status.lock() {
        status.message = "正在停止 7-Zip 并清理临时归档…".into();
    }
    write_log(
        &state.logger,
        LogLevel::Warn,
        "compression",
        "compression.cancel_requested",
        "已请求停止压缩任务。",
        [("task_id".into(), task_id)],
    );
    Ok(true)
}

fn compression_password_keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(
        COMPRESSION_PASSWORD_KEYRING_SERVICE,
        COMPRESSION_PASSWORD_KEYRING_ACCOUNT,
    )
    .map_err(|error| format!("无法访问系统凭据存储：{error}"))
}

fn get_permanent_compression_password() -> Result<Option<String>, String> {
    match compression_password_keyring_entry()?.get_password() {
        Ok(value) if value.is_empty() => Ok(None),
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("无法读取系统凭据存储：{error}")),
    }
}

fn set_permanent_compression_password(password: &str) -> Result<(), String> {
    let password = validate_permanent_compression_password(password)?;
    compression_password_keyring_entry()?
        .set_password(password)
        .map_err(|error| format!("无法写入系统凭据存储：{error}"))
}

fn delete_permanent_compression_password() -> Result<(), String> {
    match compression_password_keyring_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("无法删除系统凭据：{error}")),
    }
}

fn resolve_compression_password(
    supplied_password: Option<String>,
    use_permanent_password: bool,
    load_permanent_password: impl FnOnce() -> Result<Option<String>, String>,
) -> Result<Option<String>, String> {
    let supplied_password = supplied_password.filter(|password| !password.is_empty());
    if supplied_password.is_some() || !use_permanent_password {
        return Ok(supplied_password);
    }
    load_permanent_password()?
        .filter(|password| !password.is_empty())
        .map(Some)
        .ok_or_else(|| "已保存的永久密码不存在，请重新保存密码或关闭本次使用后重试。".into())
}

fn validate_permanent_compression_password(password: &str) -> Result<&str, String> {
    if password.is_empty() {
        return Err("永久密码不能为空。".into());
    }
    Ok(password)
}

fn next_compression_task_id() -> String {
    let timestamp = current_time_ms();
    let sequence = COMPRESSION_TASK_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("compression-{timestamp}-{sequence}")
}

#[cfg(test)]
mod tests {
    use super::{resolve_compression_password, validate_permanent_compression_password};

    #[test]
    fn supplied_compression_password_overrides_the_permanent_password() {
        let resolved = resolve_compression_password(Some("本次密码".into()), true, || {
            Ok(Some("永久密码".into()))
        })
        .expect("resolve password");

        assert_eq!(resolved.as_deref(), Some("本次密码"));
    }

    #[test]
    fn permanent_compression_password_is_reused_when_no_password_is_supplied() {
        let resolved = resolve_compression_password(None, true, || Ok(Some("永久密码".into())))
            .expect("resolve password");

        assert_eq!(resolved.as_deref(), Some("永久密码"));
    }

    #[test]
    fn empty_permanent_compression_password_is_rejected() {
        let error = validate_permanent_compression_password("").expect_err("empty password");

        assert_eq!(error, "永久密码不能为空。");
    }

    #[test]
    fn selected_permanent_password_must_still_exist() {
        for password in [None, Some(String::new())] {
            assert!(resolve_compression_password(None, true, || Ok(password)).is_err());
        }
        assert_eq!(
            resolve_compression_password(None, true, || Err("unavailable".into())),
            Err("unavailable".into())
        );
        assert_eq!(
            resolve_compression_password(None, true, || Ok(Some(" ".into()))).unwrap(),
            Some(" ".into())
        );
    }

    #[test]
    fn explicit_or_unencrypted_jobs_do_not_load_saved_credentials() {
        assert_eq!(
            resolve_compression_password(Some("temporary".into()), true, || panic!("unused"))
                .unwrap(),
            Some("temporary".into())
        );
        assert_eq!(
            resolve_compression_password(None, false, || panic!("unused")).unwrap(),
            None
        );
    }
}
