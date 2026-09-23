mod ai_commands;
mod clipboard_security;
mod compression_commands;
mod credential_protection;
mod data_commands;
mod engine_commands;
mod history_commands;
mod history_support;
mod logging;
mod recovery_commands;
mod task_coordination;
mod task_lifecycle;
mod update_commands;

use std::any::Any;
use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use ai_commands::{
    ai_connection_test, ai_generate_archive_name, ai_models_list, ai_profile_delete,
    ai_profile_upsert, ai_profiles_list, ai_settings_update,
};
use arc_recall_core::{
    APP_DATA_FOLDER_NAME, AppLogLevel, AppPaths, DictionaryCandidateStore, LoggingSettings,
    RecoveryHistoryStore, SERVICE_NAME, SettingsStore, health_status,
};
use clipboard_security::clipboard_clear_if_matches;
use compression_commands::{
    CompressionTaskHandle, compression_cancel, compression_password_delete,
    compression_password_save, compression_password_status, compression_start, compression_status,
};
use data_commands::{
    database_backup, database_info, database_restore_apply, database_restore_discard,
    database_restore_preview, dictionary_add, dictionary_count, dictionary_delete, dictionary_list,
    settings_get, settings_update,
};
use engine_commands::{
    recovery_capabilities, tool_full_bundle_install, tool_full_bundle_status,
    tool_hashcat_download, tool_hashcat_status, tool_john_perl_status, tool_set_john_perl,
    tool_set_tools_directory,
};
use history_commands::{history_clear, history_delete, history_list, history_reveal_password};
use history_support::migrate_legacy_history_passwords;
use logging::{LogExportResult, LogLevel, LogListResult, LogQuery, LogStore};
use recovery_commands::{
    RecoveryTaskHandle, archive_analyze, archive_repair_copy, recovery_cancel, recovery_start,
    recovery_status,
};
use serde::{Deserialize, Serialize};
use task_lifecycle::{RecoverySession, TaskLifecycle};
use tauri::{AppHandle, Manager, State};
use update_commands::{
    AppUpdater, app_update_check, app_update_download, app_update_install, app_update_status,
};

const MIB_BYTES: u64 = 1024 * 1024;

struct AppState {
    paths: AppPaths,
    resource_dir: PathBuf,
    dictionary: Arc<Mutex<DictionaryCandidateStore>>,
    prepared_restore: Mutex<Option<data_commands::PreparedDatabaseRestore>>,
    history: Arc<Mutex<RecoveryHistoryStore>>,
    settings: Mutex<SettingsStore>,
    logger: Arc<LogStore>,
    recovery_task: Mutex<Option<RecoveryTaskHandle>>,
    compression_task: Mutex<Option<CompressionTaskHandle>>,
    archive_task_starting: AtomicBool,
    lifecycle: Arc<TaskLifecycle>,
    recovery_session: RecoverySession,
    exit_ready: AtomicBool,
    seven_zip_cache: Arc<Mutex<Option<engine_commands::CachedSevenZip>>>,
}

fn ensure_no_active_archive_task(state: &AppState) -> Result<(), String> {
    {
        let current = state
            .compression_task
            .lock()
            .map_err(|error| error.to_string())?;
        if let Some(task) = current.as_ref()
            && task.is_running()?
        {
            return Err("已有压缩任务正在运行，请先等待完成或取消。".into());
        }
    }
    {
        let current = state
            .recovery_task
            .lock()
            .map_err(|error| error.to_string())?;
        if let Some(task) = current.as_ref()
            && task.is_running()?
        {
            return Err("已有密码恢复任务正在运行，请先等待完成或取消。".into());
        }
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    service: &'static str,
    status: &'static str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientLogRequest {
    level: LogLevel,
    event: String,
    message: String,
    #[serde(default)]
    context: BTreeMap<String, String>,
}

fn configured_log_level(level: AppLogLevel) -> LogLevel {
    match level {
        AppLogLevel::Error => LogLevel::Error,
        AppLogLevel::Warn => LogLevel::Warn,
        AppLogLevel::Info => LogLevel::Info,
        AppLogLevel::Debug => LogLevel::Debug,
    }
}

fn apply_logging_settings(logger: &LogStore, settings: &LoggingSettings) -> Result<(), String> {
    logger.set_max_level(configured_log_level(settings.level));
    logger.set_max_total_bytes(u64::from(settings.max_disk_mib) * MIB_BYTES)
}

fn write_log(
    logger: &LogStore,
    level: LogLevel,
    source: &str,
    event: &str,
    message: &str,
    context: impl IntoIterator<Item = (String, String)>,
) {
    let _ = logger.write(level, source, event, message, context.into_iter().collect());
}

fn install_panic_logger(logger: Arc<LogStore>) {
    let previous_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic_info| {
        let panic_message = panic_payload_message(panic_info.payload());
        let location = panic_info
            .location()
            .map(|location| {
                format!(
                    "{}:{}:{}",
                    location.file(),
                    location.line(),
                    location.column()
                )
            })
            .unwrap_or_else(|| "unknown".into());
        let thread = std::thread::current()
            .name()
            .map(str::to_owned)
            .unwrap_or_else(|| "unnamed".into());
        write_log(
            &logger,
            LogLevel::Error,
            "desktop",
            "app.panic",
            "应用发生未处理异常。",
            [
                ("panic".into(), panic_message),
                ("location".into(), location),
                ("thread".into(), thread),
            ],
        );
        previous_hook(panic_info);
    }));
}

fn panic_payload_message(payload: &(dyn Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|value| (*value).to_owned())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "未知 panic 载荷".into())
}

#[tauri::command]
fn health() -> HealthResponse {
    HealthResponse {
        service: SERVICE_NAME,
        status: health_status(),
    }
}

#[tauri::command]
async fn log_write(state: State<'_, AppState>, request: ClientLogRequest) -> Result<(), String> {
    let logger = Arc::clone(&state.logger);
    tauri::async_runtime::spawn_blocking(move || {
        logger
            .write(
                request.level,
                "frontend",
                &request.event,
                &request.message,
                request.context,
            )
            .map(|_| ())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn log_list(state: State<'_, AppState>, query: LogQuery) -> Result<LogListResult, String> {
    let logger = Arc::clone(&state.logger);
    tauri::async_runtime::spawn_blocking(move || logger.list(&query))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn log_export(state: State<'_, AppState>) -> Result<LogExportResult, String> {
    let logger = Arc::clone(&state.logger);
    let exports = state.paths.exports.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = logger.export(&exports);
        match &result {
            Ok(export) => write_log(
                &logger,
                LogLevel::Info,
                "logs",
                "logs.exported",
                "日志已导出。",
                [
                    ("entry_count".into(), export.entry_count.to_string()),
                    ("byte_count".into(), export.byte_count.to_string()),
                ],
            ),
            Err(_) => write_log(
                &logger,
                LogLevel::Error,
                "logs",
                "logs.export_failed",
                "日志导出失败。",
                std::iter::empty(),
            ),
        }
        result
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn log_clear(state: State<'_, AppState>) -> Result<usize, String> {
    let logger = Arc::clone(&state.logger);
    tauri::async_runtime::spawn_blocking(move || {
        let removed = logger.clear()?;
        write_log(
            &logger,
            LogLevel::Info,
            "logs",
            "logs.cleared",
            "历史日志已清空。",
            [("removed_file_count".into(), removed.to_string())],
        );
        Ok(removed)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn log_open_directory(state: State<'_, AppState>) -> Result<(), String> {
    open_directory(state.logger.directory())
}

#[tauri::command]
fn open_output_directory(path: String) -> Result<(), String> {
    let directory = PathBuf::from(path);
    if !directory.is_dir() {
        return Err("输出目录不存在。".into());
    }
    open_directory(&directory)
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    if !path.exists() {
        return Err("路径不存在。".into());
    }
    if path.is_dir() {
        return open_directory(&path);
    }
    #[cfg(windows)]
    {
        std::process::Command::new("explorer.exe")
            .arg("/select,")
            .arg(path)
            .spawn()
            .map_err(|error| format!("无法在资源管理器中定位文件：{error}"))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err("当前平台暂不支持自动定位文件。".into())
    }
}

fn open_directory(directory: &Path) -> Result<(), String> {
    if !directory.is_dir() {
        return Err("目录不存在。".into());
    }
    #[cfg(windows)]
    {
        std::process::Command::new("explorer.exe")
            .arg(directory)
            .spawn()
            .map_err(|error| format!("无法打开输出目录：{error}"))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = directory;
        Err("当前平台暂不支持自动打开输出目录。".into())
    }
}

fn current_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

/// Data root: `{LocalAppData}/ArcRecall` (not the reverse-domain identifier).
fn resolve_app_paths(app: &AppHandle) -> Result<AppPaths, String> {
    // Native development tests need an isolated store before setup opens any data.
    // Release builds always use the platform's normal application data directory.
    #[cfg(debug_assertions)]
    let test_root = std::env::var_os("ARC_RECALL_TEST_DATA_ROOT").map(PathBuf::from);
    #[cfg(not(debug_assertions))]
    let test_root: Option<PathBuf> = None;

    let root = if let Some(root) = test_root {
        if !root.is_absolute() {
            return Err("开发测试数据目录必须为绝对路径。".into());
        }
        root
    } else {
        app.path()
            .local_data_dir()
            .map_err(|e| format!("resolve local data dir: {e}"))?
            .join(APP_DATA_FOLDER_NAME)
    };
    let paths = AppPaths::from_root(root);
    paths
        .ensure_dirs()
        .map_err(|e| format!("create app data dirs: {e}"))?;
    Ok(paths)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppUpdater::default())
        .setup(|app| {
            let paths = resolve_app_paths(app.handle())?;
            let recovery_session = RecoverySession::create(&paths.temp)?;
            let resource_dir = app
                .path()
                .resource_dir()
                .map_err(|e| format!("resolve resource dir: {e}"))?;
            let dictionary = DictionaryCandidateStore::open(&paths.database)
                .map_err(|e| format!("open dictionary store: {e}"))?;
            let history = RecoveryHistoryStore::open(&paths.database)
                .map_err(|e| format!("open recovery history store: {e}"))?;
            let settings = SettingsStore::open(&paths.settings)
                .map_err(|e| format!("open settings store: {e}"))?;
            let loaded_settings = settings.load().map_err(|e| format!("load settings: {e}"))?;
            let logger =
                Arc::new(LogStore::new(&paths.logs).map_err(|e| format!("open log store: {e}"))?);
            apply_logging_settings(&logger, &loaded_settings.logging)
                .map_err(|e| format!("configure log store: {e}"))?;
            install_panic_logger(Arc::clone(&logger));
            match migrate_legacy_history_passwords(&history) {
                Ok(report) if report.migrated_count > 0 || report.failed_count > 0 => write_log(
                    &logger,
                    if report.failed_count > 0 {
                        LogLevel::Warn
                    } else {
                        LogLevel::Info
                    },
                    "history",
                    "history.password_migration_finished",
                    "本机历史密码保护迁移已完成。",
                    [
                        ("migrated_count".into(), report.migrated_count.to_string()),
                        ("failed_count".into(), report.failed_count.to_string()),
                    ],
                ),
                Ok(_) => {}
                Err(error) => write_log(
                    &logger,
                    LogLevel::Warn,
                    "history",
                    "history.password_migration_failed",
                    "无法检查本机历史密码保护迁移。",
                    [("error".into(), error)],
                ),
            }
            write_log(
                &logger,
                LogLevel::Info,
                "desktop",
                "app.started",
                "ArcRecall 桌面应用已启动。",
                [
                    ("version".into(), env!("CARGO_PKG_VERSION").into()),
                    ("platform".into(), std::env::consts::OS.into()),
                ],
            );
            app.manage(AppState {
                paths,
                prepared_restore: Mutex::new(None),
                resource_dir,
                dictionary: Arc::new(Mutex::new(dictionary)),
                history: Arc::new(Mutex::new(history)),
                settings: Mutex::new(settings),
                logger,
                recovery_task: Mutex::new(None),
                compression_task: Mutex::new(None),
                archive_task_starting: AtomicBool::new(false),
                lifecycle: Arc::new(TaskLifecycle::default()),
                recovery_session,
                exit_ready: AtomicBool::new(false),
                seven_zip_cache: Arc::new(Mutex::new(None)),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_update_status,
            app_update_check,
            app_update_download,
            app_update_install,
            health,
            clipboard_clear_if_matches,
            log_write,
            log_list,
            log_export,
            log_clear,
            log_open_directory,
            database_backup,
            database_restore_preview,
            database_restore_apply,
            database_restore_discard,
            dictionary_list,
            dictionary_count,
            dictionary_add,
            dictionary_delete,
            history_list,
            history_reveal_password,
            history_delete,
            history_clear,
            database_info,
            settings_get,
            settings_update,
            ai_profiles_list,
            ai_profile_upsert,
            ai_profile_delete,
            ai_settings_update,
            ai_models_list,
            ai_connection_test,
            ai_generate_archive_name,
            tool_full_bundle_status,
            recovery_capabilities,
            tool_full_bundle_install,
            tool_hashcat_status,
            tool_hashcat_download,
            tool_set_tools_directory,
            tool_john_perl_status,
            tool_set_john_perl,
            archive_analyze,
            archive_repair_copy,
            compression_password_status,
            compression_password_save,
            compression_password_delete,
            compression_start,
            compression_status,
            compression_cancel,
            recovery_start,
            recovery_status,
            recovery_cancel,
            open_output_directory,
            open_path,
        ])
        .on_window_event(|window, event| {
            if window.label() == "main"
                && let tauri::WindowEvent::CloseRequested { api, .. } = event
                && request_app_shutdown(window.app_handle())
            {
                api.prevent_close();
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build ArcRecall")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event
                && request_app_shutdown(app)
            {
                api.prevent_exit();
            }
        });
}

fn request_app_shutdown(app: &AppHandle) -> bool {
    let state = app.state::<AppState>();
    if state.exit_ready.load(Ordering::Acquire) {
        return false;
    }
    if state.lifecycle.request_shutdown() {
        let app = app.clone();
        std::thread::spawn(move || {
            let state = app.state::<AppState>();
            state.lifecycle.wait_until_finished();
            if state.recovery_session.cleanup().is_err() {
                write_log(
                    &state.logger,
                    LogLevel::Warn,
                    "desktop",
                    "app.cleanup_failed",
                    "部分临时文件将在下次启动时重试清理。",
                    std::iter::empty(),
                );
            }
            state.exit_ready.store(true, Ordering::Release);
            app.exit(0);
        });
    }
    true
}
