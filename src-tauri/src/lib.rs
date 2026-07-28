mod logging;

use std::collections::{BTreeMap, VecDeque};
use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use arc_recall_core::{
    APP_DATA_FOLDER_NAME, AppLogLevel, AppPaths, AppSettings, ArchiveAnalysis, ArchiveFormat,
    CancellationToken, DEFAULT_RECURSIVE_MAX_ARCHIVES, DEFAULT_RECURSIVE_MAX_DEPTH, DatabaseInfo,
    DictionaryCandidateAddSummary, DictionaryCandidateQuery, DictionaryCandidateStore,
    DictionaryListResult, FullEngineBundleInstallResult, FullEngineBundleManager,
    FullEngineBundleStatus, HashcatInstallResult, HashcatStatus, HashcatToolDownloader,
    JohnPerlStatus, LoggingSettings, MAX_LOG_MAX_DISK_MIB, MIN_LOG_MAX_DISK_MIB,
    RecoveryDictionary, RecoveryError, RecoveryHistoryListResult, RecoveryHistoryQuery,
    RecoveryHistoryRecord, RecoveryHistoryStore, RecoveryJob, RecoveryPhase, RecoveryToolPaths,
    RecoveryUpdate, RecursiveRecoveryOptions, SERVICE_NAME, SettingsStore, analyze_archive,
    fingerprint_file_sha256, health_status, path_for_display, probe_john_perl,
    recover_and_extract_recursive_lazy, resolve_tools_directory,
};
use logging::{LogExportResult, LogLevel, LogListResult, LogQuery, LogStore};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

static RECOVERY_TASK_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static DATABASE_BACKUP_SEQUENCE: AtomicU64 = AtomicU64::new(1);
const MIB_BYTES: u64 = 1024 * 1024;
const RECOVERY_EVENT_LIMIT: usize = 80;

struct AppState {
    paths: AppPaths,
    resource_dir: PathBuf,
    dictionary: Mutex<DictionaryCandidateStore>,
    history: Mutex<RecoveryHistoryStore>,
    settings: Mutex<SettingsStore>,
    logger: Arc<LogStore>,
    engine_install: Arc<Mutex<()>>,
    recovery_task: Mutex<Option<RecoveryTaskHandle>>,
}

struct RecoveryTaskHandle {
    id: String,
    cancellation: CancellationToken,
    status: Arc<Mutex<RecoveryTaskStatus>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    service: &'static str,
    status: &'static str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryStartRequest {
    archive_path: String,
    fingerprint_sha256: Option<String>,
    output_directory: Option<String>,
    known_password: Option<String>,
    #[serde(default)]
    avoid_output_collision: bool,
    #[serde(default = "default_recursive_recovery")]
    recursive: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveAnalysisResponse {
    #[serde(flatten)]
    analysis: ArchiveAnalysis,
    fingerprint_sha256: String,
    history_matched: bool,
    has_saved_password: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryTaskEvent {
    sequence: u64,
    elapsed_ms: u64,
    phase: RecoveryPhase,
    engine: Option<String>,
    message: String,
    archive_path: Option<String>,
    recursive_depth: u32,
    attempted_count: Option<u64>,
    total_count: Option<u64>,
    scanned_file_count: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryTaskStatus {
    task_id: String,
    phase: RecoveryPhase,
    running: bool,
    completed: bool,
    success: bool,
    cancelled: bool,
    archive_path: String,
    archive_format: ArchiveFormat,
    archive_format_label: String,
    engine: Option<String>,
    message: String,
    candidate_count: u64,
    attempted_count: u64,
    started_at_ms: u64,
    elapsed_ms: u64,
    recovered_password: Option<String>,
    output_directory: String,
    recursive_enabled: bool,
    recursive_depth: u32,
    current_archive_path: Option<String>,
    nested_archive_count: u32,
    extracted_nested_archive_count: u32,
    skipped_nested_archive_count: u32,
    scanned_file_count: u64,
    depth_limit_reached: bool,
    count_limit_reached: bool,
    events: VecDeque<RecoveryTaskEvent>,
}

fn default_recursive_recovery() -> bool {
    true
}

fn append_recovery_update_event(status: &mut RecoveryTaskStatus, update: &RecoveryUpdate) {
    let archive_path = update
        .current_archive_path
        .as_deref()
        .or(status.current_archive_path.as_deref())
        .map(|path| path_for_display(Path::new(path)));
    push_recovery_event(
        status,
        update.phase,
        update.engine.clone(),
        update.message.clone(),
        archive_path,
        update.recursive_depth.unwrap_or(status.recursive_depth),
        update.attempted_count,
        update.total_count,
        update.scanned_file_count,
    );
}

fn append_current_recovery_event(status: &mut RecoveryTaskStatus) {
    let phase = status.phase;
    let engine = status.engine.clone();
    let message = status.message.clone();
    let archive_path = status.current_archive_path.clone();
    let recursive_depth = status.recursive_depth;
    let attempted_count = (status.attempted_count > 0).then_some(status.attempted_count);
    let total_count = (status.candidate_count > 0).then_some(status.candidate_count);
    let scanned_file_count = (status.scanned_file_count > 0).then_some(status.scanned_file_count);
    push_recovery_event(
        status,
        phase,
        engine,
        message,
        archive_path,
        recursive_depth,
        attempted_count,
        total_count,
        scanned_file_count,
    );
}

#[allow(clippy::too_many_arguments)]
fn push_recovery_event(
    status: &mut RecoveryTaskStatus,
    phase: RecoveryPhase,
    engine: Option<String>,
    message: String,
    archive_path: Option<String>,
    recursive_depth: u32,
    attempted_count: Option<u64>,
    total_count: Option<u64>,
    scanned_file_count: Option<u64>,
) {
    if let Some(latest) = status.events.front()
        && latest.phase == phase
        && latest.engine == engine
        && latest.archive_path == archive_path
        && latest.recursive_depth == recursive_depth
    {
        if let (Some(attempted), Some(total), Some(previous_attempted), Some(previous_total)) = (
            attempted_count,
            total_count,
            latest.attempted_count,
            latest.total_count,
        ) {
            let bucket = recovery_progress_bucket(attempted, total);
            let previous_bucket = recovery_progress_bucket(previous_attempted, previous_total);
            if bucket == previous_bucket && attempted < total {
                return;
            }
        } else if latest.message == message && latest.scanned_file_count == scanned_file_count {
            return;
        }
    }

    let sequence = status
        .events
        .front()
        .map(|event| event.sequence.saturating_add(1))
        .unwrap_or(1);
    status.events.push_front(RecoveryTaskEvent {
        sequence,
        elapsed_ms: current_time_ms().saturating_sub(status.started_at_ms),
        phase,
        engine,
        message,
        archive_path,
        recursive_depth,
        attempted_count,
        total_count,
        scanned_file_count,
    });
    if status.events.len() > RECOVERY_EVENT_LIMIT {
        status.events.pop_back();
    }
}

fn recovery_progress_bucket(attempted: u64, total: u64) -> u64 {
    if total == 0 {
        attempted
    } else {
        attempted.saturating_mul(20) / total
    }
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DatabaseBackupResult {
    path: String,
    byte_count: u64,
    created_at_ms: u64,
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
        write_log(
            &logger,
            LogLevel::Error,
            "desktop",
            "app.panic",
            "应用发生未处理异常。",
            std::iter::empty(),
        );
        previous_hook(panic_info);
    }));
}

#[tauri::command]
fn health() -> HealthResponse {
    HealthResponse {
        service: SERVICE_NAME,
        status: health_status(),
    }
}

#[tauri::command]
fn log_write(state: State<'_, AppState>, request: ClientLogRequest) -> Result<(), String> {
    state
        .logger
        .write(
            request.level,
            "frontend",
            &request.event,
            &request.message,
            request.context,
        )
        .map(|_| ())
}

#[tauri::command]
fn log_list(state: State<'_, AppState>, query: LogQuery) -> Result<LogListResult, String> {
    state.logger.list(&query)
}

#[tauri::command]
fn log_export(state: State<'_, AppState>) -> Result<LogExportResult, String> {
    let result = state.logger.export(&state.paths.exports);
    match &result {
        Ok(export) => write_log(
            &state.logger,
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
            &state.logger,
            LogLevel::Error,
            "logs",
            "logs.export_failed",
            "日志导出失败。",
            std::iter::empty(),
        ),
    }
    result
}

#[tauri::command]
fn log_clear(state: State<'_, AppState>) -> Result<usize, String> {
    let removed = state.logger.clear()?;
    write_log(
        &state.logger,
        LogLevel::Info,
        "logs",
        "logs.cleared",
        "历史日志已清空。",
        [("removed_file_count".into(), removed.to_string())],
    );
    Ok(removed)
}

#[tauri::command]
fn log_open_directory(state: State<'_, AppState>) -> Result<(), String> {
    open_directory(state.logger.directory())
}

#[tauri::command]
fn database_backup(state: State<'_, AppState>) -> Result<DatabaseBackupResult, String> {
    let created_at_ms = current_time_ms();
    let destination = unique_database_backup_path(&state.paths.exports, created_at_ms)?;
    let result = {
        let store = state.dictionary.lock().map_err(|error| error.to_string())?;
        store
            .backup(&destination)
            .map_err(|error| error.to_string())
    };
    match result {
        Ok(byte_count) => {
            write_log(
                &state.logger,
                LogLevel::Info,
                "database",
                "database.backup_completed",
                "SQLite 备份已创建。",
                [("byte_count".into(), byte_count.to_string())],
            );
            Ok(DatabaseBackupResult {
                path: destination.display().to_string(),
                byte_count,
                created_at_ms,
            })
        }
        Err(error) => {
            write_log(
                &state.logger,
                LogLevel::Error,
                "database",
                "database.backup_failed",
                "SQLite 备份创建失败。",
                std::iter::empty(),
            );
            Err(error)
        }
    }
}

#[tauri::command]
fn dictionary_list(
    state: State<'_, AppState>,
    query: DictionaryCandidateQuery,
) -> Result<DictionaryListResult, String> {
    let store = state.dictionary.lock().map_err(|e| e.to_string())?;
    store.list(&query).map_err(|e| e.to_string())
}

#[tauri::command]
fn dictionary_count(state: State<'_, AppState>) -> Result<u64, String> {
    let store = state.dictionary.lock().map_err(|e| e.to_string())?;
    store.count().map_err(|e| e.to_string())
}

#[tauri::command]
fn dictionary_add(
    state: State<'_, AppState>,
    candidates: Vec<String>,
) -> Result<DictionaryCandidateAddSummary, String> {
    let result = {
        let store = state.dictionary.lock().map_err(|e| e.to_string())?;
        store.add_candidates(candidates).map_err(|e| e.to_string())
    };
    match &result {
        Ok(summary) => write_log(
            &state.logger,
            LogLevel::Info,
            "dictionary",
            "dictionary.candidates_added",
            "候选字典已更新。",
            [
                (
                    "submitted_count".into(),
                    summary.submitted_count.to_string(),
                ),
                ("added_count".into(), summary.added_count.to_string()),
                (
                    "duplicate_count".into(),
                    summary.duplicate_count.to_string(),
                ),
                ("invalid_count".into(), summary.invalid_count.to_string()),
            ],
        ),
        Err(_) => write_log(
            &state.logger,
            LogLevel::Error,
            "dictionary",
            "dictionary.add_failed",
            "候选字典更新失败。",
            std::iter::empty(),
        ),
    }
    result
}

#[tauri::command]
fn dictionary_import_file(
    state: State<'_, AppState>,
    path: String,
) -> Result<DictionaryCandidateAddSummary, String> {
    let result = {
        let store = state.dictionary.lock().map_err(|e| e.to_string())?;
        store.import_file(path).map_err(|e| e.to_string())
    };
    match &result {
        Ok(summary) => write_log(
            &state.logger,
            LogLevel::Info,
            "dictionary",
            "dictionary.file_imported",
            "字典文件已导入。",
            [
                (
                    "submitted_count".into(),
                    summary.submitted_count.to_string(),
                ),
                ("added_count".into(), summary.added_count.to_string()),
                ("invalid_count".into(), summary.invalid_count.to_string()),
            ],
        ),
        Err(_) => write_log(
            &state.logger,
            LogLevel::Error,
            "dictionary",
            "dictionary.import_failed",
            "字典文件导入失败。",
            std::iter::empty(),
        ),
    }
    result
}

#[tauri::command]
fn dictionary_delete(state: State<'_, AppState>, ids: Vec<i64>) -> Result<u64, String> {
    let requested_count = ids.len();
    let result = {
        let store = state.dictionary.lock().map_err(|e| e.to_string())?;
        store.delete(&ids).map_err(|e| e.to_string())
    };
    match &result {
        Ok(deleted_count) => write_log(
            &state.logger,
            LogLevel::Info,
            "dictionary",
            "dictionary.candidates_deleted",
            "候选字典条目已删除。",
            [
                ("requested_count".into(), requested_count.to_string()),
                ("deleted_count".into(), deleted_count.to_string()),
            ],
        ),
        Err(_) => write_log(
            &state.logger,
            LogLevel::Error,
            "dictionary",
            "dictionary.delete_failed",
            "候选字典删除失败。",
            std::iter::empty(),
        ),
    }
    result
}

#[tauri::command]
fn history_list(
    state: State<'_, AppState>,
    query: RecoveryHistoryQuery,
) -> Result<RecoveryHistoryListResult, String> {
    let store = state.history.lock().map_err(|error| error.to_string())?;
    store.list(&query).map_err(|error| error.to_string())
}

#[tauri::command]
fn history_reveal_password(state: State<'_, AppState>, id: i64) -> Result<Option<String>, String> {
    let result = {
        let store = state.history.lock().map_err(|error| error.to_string())?;
        store.password_by_id(id).map_err(|error| error.to_string())
    };
    if result.as_ref().is_ok_and(Option::is_some) {
        write_log(
            &state.logger,
            LogLevel::Info,
            "history",
            "history.password_revealed",
            "用户查看了一条本机历史密码。",
            std::iter::empty(),
        );
    }
    result
}

#[tauri::command]
fn history_delete(state: State<'_, AppState>, id: i64) -> Result<bool, String> {
    let result = {
        let store = state.history.lock().map_err(|error| error.to_string())?;
        store.delete(id).map_err(|error| error.to_string())
    };
    if result.as_ref().is_ok_and(|deleted| *deleted) {
        write_log(
            &state.logger,
            LogLevel::Info,
            "history",
            "history.entry_deleted",
            "一条恢复历史已删除。",
            std::iter::empty(),
        );
    }
    result
}

#[tauri::command]
fn history_clear(state: State<'_, AppState>) -> Result<u64, String> {
    let result = {
        let store = state.history.lock().map_err(|error| error.to_string())?;
        store.clear().map_err(|error| error.to_string())
    };
    if let Ok(removed_count) = &result {
        write_log(
            &state.logger,
            LogLevel::Info,
            "history",
            "history.cleared",
            "恢复历史已清空。",
            [("removed_count".into(), removed_count.to_string())],
        );
    }
    result
}

#[tauri::command]
fn database_info(state: State<'_, AppState>) -> Result<DatabaseInfo, String> {
    let store = state.dictionary.lock().map_err(|e| e.to_string())?;
    let count = store.count().map_err(|e| e.to_string())?;
    Ok(DatabaseInfo {
        path: state.paths.database.display().to_string(),
        exists: state.paths.database_exists(),
        candidate_count: count,
        settings_path: state.paths.settings.display().to_string(),
        root_path: state.paths.root.display().to_string(),
        logs_path: state.paths.logs.display().to_string(),
        tools_path: state.paths.tools.display().to_string(),
    })
}

#[tauri::command]
fn settings_get(state: State<'_, AppState>) -> Result<AppSettings, String> {
    let settings = state.settings.lock().map_err(|e| e.to_string())?;
    settings.load().map_err(|e| e.to_string())
}

#[tauri::command]
fn settings_set(state: State<'_, AppState>, settings: AppSettings) -> Result<AppSettings, String> {
    if !settings.logging.has_valid_disk_limit() {
        return Err(format!(
            "日志最大占用必须在 {MIN_LOG_MAX_DISK_MIB}–{MAX_LOG_MAX_DISK_MIB} MiB 之间。"
        ));
    }
    let logging = settings.logging.clone();
    let result = {
        let store = state.settings.lock().map_err(|e| e.to_string())?;
        store.save(&settings).map_err(|e| e.to_string())?;
        store.load().map_err(|e| e.to_string())
    };
    match &result {
        Ok(_) => {
            apply_logging_settings(&state.logger, &logging)?;
            write_log(
                &state.logger,
                LogLevel::Info,
                "settings",
                "settings.saved",
                "应用设置已保存。",
                [
                    (
                        "log_level".into(),
                        format!("{:?}", logging.level).to_lowercase(),
                    ),
                    ("log_max_disk_mib".into(), logging.max_disk_mib.to_string()),
                ],
            );
        }
        Err(_) => write_log(
            &state.logger,
            LogLevel::Error,
            "settings",
            "settings.save_failed",
            "应用设置保存失败。",
            std::iter::empty(),
        ),
    }
    result
}

fn hashcat_downloader(state: &AppState) -> Result<HashcatToolDownloader, String> {
    let settings = state.settings.lock().map_err(|e| e.to_string())?;
    let loaded = settings.load().map_err(|e| e.to_string())?;
    let tools = resolve_tools_directory(&state.paths.tools, &loaded.engine.tools_directory);
    Ok(HashcatToolDownloader::new(
        tools,
        state.paths.tools.clone(),
        loaded.engine.tools_directory.clone(),
        state.paths.temp.clone(),
    ))
}

fn full_bundle_manager(state: &AppState) -> Result<FullEngineBundleManager, String> {
    let settings = state.settings.lock().map_err(|e| e.to_string())?;
    let loaded = settings.load().map_err(|e| e.to_string())?;
    let tools = resolve_tools_directory(&state.paths.tools, &loaded.engine.tools_directory);
    Ok(FullEngineBundleManager::new(
        state.resource_dir.clone(),
        tools,
    ))
}

#[tauri::command]
async fn tool_full_bundle_status(
    state: State<'_, AppState>,
) -> Result<FullEngineBundleStatus, String> {
    let manager = full_bundle_manager(&state)?;
    tauri::async_runtime::spawn_blocking(move || manager.status())
        .await
        .map_err(|error| format!("完整引擎探测任务失败：{error}"))
}

#[tauri::command]
async fn tool_full_bundle_install(
    state: State<'_, AppState>,
) -> Result<FullEngineBundleInstallResult, String> {
    write_log(
        &state.logger,
        LogLevel::Info,
        "engine",
        "engine.bundle_install_started",
        "完整引擎部署已开始。",
        std::iter::empty(),
    );
    let manager = full_bundle_manager(&state)?;
    let install_lock = Arc::clone(&state.engine_install);
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _guard = install_lock
            .lock()
            .map_err(|error| format!("完整引擎安装锁异常：{error}"))?;
        manager.install().map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("完整引擎安装任务失败：{error}"))??;

    if result.success {
        let store = state.settings.lock().map_err(|e| e.to_string())?;
        let mut settings = store.load().map_err(|e| e.to_string())?;
        settings.engine.hashcat_path = result.hashcat_path.clone();
        settings.engine.john_tools_directory = result.john_tools_directory.clone();
        settings.engine.perl_path = result.perl_path.clone();
        store.save(&settings).map_err(|e| e.to_string())?;
    }
    write_log(
        &state.logger,
        if result.success {
            LogLevel::Info
        } else {
            LogLevel::Warn
        },
        "engine",
        if result.success {
            "engine.bundle_install_completed"
        } else {
            "engine.bundle_install_incomplete"
        },
        if result.success {
            "完整引擎部署已完成。"
        } else {
            "完整引擎部署未完成。"
        },
        std::iter::empty(),
    );
    Ok(result)
}

#[tauri::command]
fn tool_hashcat_status(state: State<'_, AppState>) -> Result<HashcatStatus, String> {
    let configured = {
        let settings = state.settings.lock().map_err(|e| e.to_string())?;
        settings
            .load()
            .map_err(|e| e.to_string())?
            .engine
            .hashcat_path
    };
    Ok(hashcat_downloader(&state)?.status(&configured))
}

#[tauri::command]
fn tool_hashcat_download(state: State<'_, AppState>) -> Result<HashcatInstallResult, String> {
    write_log(
        &state.logger,
        LogLevel::Info,
        "engine",
        "engine.hashcat_install_started",
        "Hashcat 安装已开始。",
        std::iter::empty(),
    );
    let downloader = hashcat_downloader(&state)?;
    let result = downloader.install().map_err(|e| e.to_string())?;
    if result.success && !result.executable_path.is_empty() {
        let settings = state.settings.lock().map_err(|e| e.to_string())?;
        settings
            .save_hashcat_path(&result.executable_path)
            .map_err(|e| e.to_string())?;
    }
    write_log(
        &state.logger,
        if result.success {
            LogLevel::Info
        } else {
            LogLevel::Warn
        },
        "engine",
        if result.success {
            "engine.hashcat_install_completed"
        } else {
            "engine.hashcat_install_incomplete"
        },
        if result.success {
            "Hashcat 安装已完成。"
        } else {
            "Hashcat 安装未完成。"
        },
        std::iter::empty(),
    );
    Ok(result)
}

#[tauri::command]
fn tool_set_tools_directory(
    state: State<'_, AppState>,
    path: String,
) -> Result<AppSettings, String> {
    let trimmed = path.trim();
    if !trimmed.is_empty() {
        let p = std::path::Path::new(trimmed);
        // Reject obvious relative traversal; require absolute path for custom root.
        if trimmed.contains("..") {
            return Err("工具目录路径不能包含 \"..\"".into());
        }
        if !p.is_absolute() {
            return Err("请填写绝对路径作为公共工具目录".into());
        }
        std::fs::create_dir_all(p).map_err(|e| format!("无法创建工具目录：{e}"))?;
    }
    let settings = state.settings.lock().map_err(|e| e.to_string())?;
    settings
        .save_tools_directory(trimmed)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn tool_john_perl_status(state: State<'_, AppState>) -> Result<JohnPerlStatus, String> {
    let settings = state.settings.lock().map_err(|e| e.to_string())?;
    let loaded = settings.load().map_err(|e| e.to_string())?;
    Ok(probe_john_perl(
        &loaded.engine.john_tools_directory,
        &loaded.engine.perl_path,
    ))
}

#[tauri::command]
fn tool_set_john_perl(
    state: State<'_, AppState>,
    john_tools_directory: String,
    perl_path: String,
) -> Result<JohnPerlStatus, String> {
    let john = john_tools_directory.trim();
    let perl = perl_path.trim();
    if !john.is_empty() {
        if john.contains("..") {
            return Err("John 工具目录不能包含 \"..\"".into());
        }
        let p = std::path::Path::new(john);
        if !p.is_absolute() {
            return Err("John 工具目录请使用绝对路径".into());
        }
    }
    if !perl.is_empty() {
        if perl.contains("..") {
            return Err("perl 路径不能包含 \"..\"".into());
        }
        let p = std::path::Path::new(perl);
        if !p.is_absolute() {
            return Err("perl 路径请使用绝对路径".into());
        }
    }
    let settings = state.settings.lock().map_err(|e| e.to_string())?;
    settings
        .save_john_perl(john, perl)
        .map_err(|e| e.to_string())?;
    Ok(probe_john_perl(john, perl))
}

#[tauri::command]
async fn archive_analyze(
    state: State<'_, AppState>,
    path: String,
) -> Result<ArchiveAnalysisResponse, String> {
    let analyzed = tauri::async_runtime::spawn_blocking(move || {
        let analysis = analyze_archive(path).map_err(|error| error.to_string())?;
        let fingerprint_sha256 =
            fingerprint_file_sha256(&analysis.archive_path).map_err(|error| error.to_string())?;
        Ok::<_, String>((analysis, fingerprint_sha256))
    })
    .await
    .map_err(|error| error.to_string())
    .and_then(|result| result);
    let result = analyzed.and_then(|(analysis, fingerprint_sha256)| {
        let (history_matched, has_saved_password) = {
            let store = state.history.lock().map_err(|error| error.to_string())?;
            let matched = store
                .contains(&fingerprint_sha256)
                .map_err(|error| error.to_string())?;
            let has_password = store
                .password_by_fingerprint(&fingerprint_sha256)
                .map_err(|error| error.to_string())?
                .is_some();
            (matched, has_password)
        };
        Ok(ArchiveAnalysisResponse {
            analysis,
            fingerprint_sha256,
            history_matched,
            has_saved_password,
        })
    });
    match &result {
        Ok(response) => write_log(
            &state.logger,
            LogLevel::Debug,
            "recovery",
            "archive.analyzed",
            "归档分析已完成。",
            [
                ("format".into(), response.analysis.format_label.clone()),
                (
                    "history_matched".into(),
                    response.history_matched.to_string(),
                ),
            ],
        ),
        Err(_) => write_log(
            &state.logger,
            LogLevel::Warn,
            "recovery",
            "archive.analysis_failed",
            "归档分析失败。",
            std::iter::empty(),
        ),
    }
    result
}

#[tauri::command]
async fn recovery_start(
    state: State<'_, AppState>,
    request: RecoveryStartRequest,
) -> Result<RecoveryTaskStatus, String> {
    write_log(
        &state.logger,
        LogLevel::Debug,
        "recovery",
        "recovery.requested",
        "收到恢复任务请求。",
        [(
            "mode".into(),
            if request.known_password.is_some() {
                "known".into()
            } else {
                "dictionary".into()
            },
        )],
    );
    {
        let current = state
            .recovery_task
            .lock()
            .map_err(|error| error.to_string())?;
        if let Some(task) = current.as_ref() {
            let status = task.status.lock().map_err(|error| error.to_string())?;
            if status.running {
                return Err("已有密码恢复任务正在运行，请先等待完成或取消。".into());
            }
        }
    }

    let archive_path = std::fs::canonicalize(PathBuf::from(&request.archive_path))
        .map_err(|error| format!("无法解析归档路径：{error}"))?;
    let analysis = analyze_archive(&archive_path).map_err(|error| error.to_string())?;
    let fingerprint_sha256 = request
        .fingerprint_sha256
        .as_deref()
        .filter(|value| is_sha256_fingerprint(value))
        .map(|value| value.to_ascii_lowercase())
        .map(Ok)
        .unwrap_or_else(|| {
            fingerprint_file_sha256(&archive_path).map_err(|error| error.to_string())
        })?;
    let manual_password = request
        .known_password
        .as_deref()
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let history_password = if manual_password.is_none() {
        let store = state.history.lock().map_err(|error| error.to_string())?;
        store
            .password_by_fingerprint(&fingerprint_sha256)
            .map_err(|error| error.to_string())?
    } else {
        None
    };
    let preferred_password = manual_password.or(history_password);
    let mut output_directory = request
        .output_directory
        .as_deref()
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(&analysis.suggested_output_directory));
    if !output_directory.is_absolute() {
        return Err("输出目录必须使用绝对路径。".into());
    }
    if request.avoid_output_collision {
        output_directory = resolve_available_output_directory(&output_directory);
    }
    if output_directory.is_file() {
        return Err("输出位置已存在且不是目录。".into());
    }

    let manager = full_bundle_manager(&state)?;
    let bundle_status = manager.status();
    // Empty / known-password paths only need 7-Zip. Dictionary recovery validates
    // Hashcat / John / *2john later inside recover_and_extract.
    if !bundle_status.seven_zip.runnable {
        if bundle_status.bundled {
            return Err(
                "7-Zip 尚未部署，请先在“设置 → 外部引擎”中安装完整包（至少部署 7-Zip）。".into(),
            );
        }
        return Err("当前构建未提供 7-Zip 资源，请使用完整发行构建并安装引擎包。".into());
    }
    let tools = RecoveryToolPaths {
        seven_zip: manager.seven_zip_executable(),
        hashcat: manager.hashcat_executable(),
        john_tools_directory: manager.john_tools_directory(),
        perl: manager.perl_executable(),
    };

    let task_id = next_recovery_task_id();
    let work_directory = state.paths.temp.join("recovery").join(&task_id);
    let dictionary_path = work_directory.join("dictionary.txt");
    let started_at_ms = current_time_ms();
    let initial_message = "恢复任务已启动，正在优先检查免密与手动密码。".to_owned();
    let initial_events = VecDeque::from([RecoveryTaskEvent {
        sequence: 1,
        elapsed_ms: 0,
        phase: RecoveryPhase::Preparing,
        engine: None,
        message: initial_message.clone(),
        archive_path: Some(analysis.archive_path.clone()),
        recursive_depth: 0,
        attempted_count: None,
        total_count: None,
        scanned_file_count: None,
    }]);

    let status = Arc::new(Mutex::new(RecoveryTaskStatus {
        task_id: task_id.clone(),
        phase: RecoveryPhase::Preparing,
        running: true,
        completed: false,
        success: false,
        cancelled: false,
        archive_path: analysis.archive_path.clone(),
        archive_format: analysis.format,
        archive_format_label: analysis.format_label.clone(),
        engine: None,
        message: initial_message,
        candidate_count: 0,
        attempted_count: 0,
        started_at_ms,
        elapsed_ms: 0,
        recovered_password: None,
        output_directory: path_for_display(&output_directory),
        recursive_enabled: request.recursive,
        recursive_depth: 0,
        current_archive_path: Some(analysis.archive_path.clone()),
        nested_archive_count: 0,
        extracted_nested_archive_count: 0,
        skipped_nested_archive_count: 0,
        scanned_file_count: 0,
        depth_limit_reached: false,
        count_limit_reached: false,
        events: initial_events,
    }));
    let cancellation = CancellationToken::default();
    {
        let mut current = state
            .recovery_task
            .lock()
            .map_err(|error| error.to_string())?;
        *current = Some(RecoveryTaskHandle {
            id: task_id,
            cancellation: cancellation.clone(),
            status: Arc::clone(&status),
        });
    }

    let initial = status.lock().map_err(|error| error.to_string())?.clone();
    write_log(
        &state.logger,
        LogLevel::Info,
        "recovery",
        "recovery.started",
        "恢复任务已启动。",
        [
            ("task_id".into(), initial.task_id.clone()),
            (
                "archive_format".into(),
                initial.archive_format_label.clone(),
            ),
            (
                "candidate_count".into(),
                initial.candidate_count.to_string(),
            ),
        ],
    );
    let job = RecoveryJob {
        archive_path,
        output_directory,
        dictionary_path: dictionary_path.clone(),
        dictionary_count: 0,
        known_password: preferred_password,
        work_directory: work_directory.clone(),
    };
    let status_for_worker = Arc::clone(&status);
    let status_for_dictionary = Arc::clone(&status);
    let dictionary_database_path = state.paths.database.clone();
    let dictionary_cancellation = cancellation.clone();
    let success_database_path = state.paths.database.clone();
    let logger_for_worker = Arc::clone(&state.logger);
    let worker_task_id = initial.task_id.clone();
    std::thread::spawn(move || {
        let mut last_logged_phase = None;
        let outcome = recover_and_extract_recursive_lazy(
            &job,
            &tools,
            &cancellation,
            RecursiveRecoveryOptions {
                enabled: initial.recursive_enabled,
                max_depth: DEFAULT_RECURSIVE_MAX_DEPTH,
                max_nested_archives: DEFAULT_RECURSIVE_MAX_ARCHIVES,
            },
            move || {
                if dictionary_cancellation.is_cancelled() {
                    return Err(RecoveryError::Cancelled);
                }
                let store =
                    DictionaryCandidateStore::open(dictionary_database_path).map_err(|error| {
                        RecoveryError::Message(format!("打开全局字典失败：{error}"))
                    })?;
                let candidate_count = store.export_wordlist(&dictionary_path).map_err(|error| {
                    RecoveryError::Message(format!("准备恢复字典失败：{error}"))
                })?;
                if let Ok(mut task_status) = status_for_dictionary.lock() {
                    task_status.candidate_count = candidate_count;
                }
                Ok(RecoveryDictionary {
                    path: dictionary_path,
                    candidate_count,
                })
            },
            |update| {
                let event_update = update.clone();
                if last_logged_phase != Some(update.phase) {
                    write_log(
                        &logger_for_worker,
                        LogLevel::Debug,
                        "recovery",
                        "recovery.phase_changed",
                        "恢复任务阶段已切换。",
                        [
                            ("task_id".into(), worker_task_id.clone()),
                            ("phase".into(), format!("{:?}", update.phase).to_lowercase()),
                            ("engine".into(), update.engine.clone().unwrap_or_default()),
                        ],
                    );
                    last_logged_phase = Some(update.phase);
                }
                if let Ok(mut task_status) = status_for_worker.lock() {
                    task_status.phase = update.phase;
                    task_status.engine = update.engine;
                    task_status.message = update.message;
                    if let Some(attempted_count) = update.attempted_count {
                        task_status.attempted_count = attempted_count;
                    }
                    if let Some(total_count) = update.total_count {
                        task_status.candidate_count = total_count;
                    }
                    if let Some(recursive_depth) = update.recursive_depth {
                        task_status.recursive_depth = recursive_depth;
                    }
                    if let Some(current_archive_path) = update.current_archive_path {
                        task_status.current_archive_path = Some(current_archive_path);
                    }
                    if let Some(nested_archive_count) = update.nested_archive_count {
                        task_status.nested_archive_count = nested_archive_count;
                    }
                    if let Some(extracted_count) = update.extracted_nested_archive_count {
                        task_status.extracted_nested_archive_count = extracted_count;
                    }
                    if let Some(skipped_count) = update.skipped_nested_archive_count {
                        task_status.skipped_nested_archive_count = skipped_count;
                    }
                    if let Some(scanned_file_count) = update.scanned_file_count {
                        task_status.scanned_file_count = scanned_file_count;
                    }
                    append_recovery_update_event(&mut task_status, &event_update);
                }
            },
        );
        if let Ok(mut task_status) = status_for_worker.lock() {
            task_status.running = false;
            task_status.completed = true;
            task_status.elapsed_ms = current_time_ms().saturating_sub(task_status.started_at_ms);
            match outcome {
                Ok(result) => {
                    let history_saved_count = if result.root.success {
                        RecoveryHistoryStore::open(&success_database_path)
                            .ok()
                            .map(|store| {
                                let verified_at_ms = current_time_ms();
                                result
                                    .recovered_archives
                                    .iter()
                                    .filter(|archive| {
                                        store
                                            .upsert(&RecoveryHistoryRecord {
                                                fingerprint_sha256: archive
                                                    .fingerprint_sha256
                                                    .clone(),
                                                archive_format: archive
                                                    .archive_format
                                                    .label()
                                                    .into(),
                                                file_size: archive.file_size,
                                                volume_count: archive.volume_count,
                                                verified_at_ms,
                                                password: archive.password.clone(),
                                            })
                                            .is_ok()
                                    })
                                    .count()
                            })
                            .unwrap_or_default()
                    } else {
                        0
                    };
                    task_status.success = result.root.success;
                    task_status.cancelled = result.root.cancelled;
                    task_status.phase = if result.root.cancelled {
                        RecoveryPhase::Cancelled
                    } else if result.root.success {
                        RecoveryPhase::Completed
                    } else {
                        RecoveryPhase::Exhausted
                    };
                    task_status.engine = result.root.engine.clone();
                    task_status.message = result.root.message;
                    task_status.recovered_password = result
                        .root
                        .password
                        .clone()
                        .or_else(|| result.recovered_passwords.first().cloned());
                    task_status.output_directory = path_for_display(&result.root.output_directory);
                    task_status.nested_archive_count = result.discovered_nested_archives;
                    task_status.extracted_nested_archive_count = result.extracted_nested_archives;
                    task_status.skipped_nested_archive_count = result.skipped_nested_archives;
                    task_status.scanned_file_count = result.scanned_files;
                    task_status.depth_limit_reached = result.depth_limit_reached;
                    task_status.count_limit_reached = result.count_limit_reached;
                    task_status.current_archive_path = None;
                    task_status.recursive_depth = 0;
                    append_current_recovery_event(&mut task_status);
                    if result.root.success
                        && let Ok(store) = DictionaryCandidateStore::open(&success_database_path)
                    {
                        for password in &result.recovered_passwords {
                            let _ = store.increment_success(password);
                        }
                    }
                    write_log(
                        &logger_for_worker,
                        if result.root.success {
                            LogLevel::Info
                        } else if result.root.cancelled {
                            LogLevel::Warn
                        } else {
                            LogLevel::Warn
                        },
                        "recovery",
                        if result.root.success {
                            "recovery.completed"
                        } else if result.root.cancelled {
                            "recovery.cancelled"
                        } else {
                            "recovery.unsuccessful"
                        },
                        if result.root.success {
                            "恢复任务已完成。"
                        } else if result.root.cancelled {
                            "恢复任务已取消。"
                        } else {
                            "恢复任务已结束，但当前候选未找到可用密码。"
                        },
                        [
                            ("task_id".into(), worker_task_id.clone()),
                            (
                                "engine".into(),
                                result.root.engine.clone().unwrap_or_default(),
                            ),
                            (
                                "nested_extracted".into(),
                                result.extracted_nested_archives.to_string(),
                            ),
                            (
                                "nested_skipped".into(),
                                result.skipped_nested_archives.to_string(),
                            ),
                            ("history_saved".into(), history_saved_count.to_string()),
                        ],
                    );
                }
                Err(arc_recall_core::RecoveryError::Cancelled) => {
                    task_status.cancelled = true;
                    task_status.phase = RecoveryPhase::Cancelled;
                    task_status.message = "密码恢复任务已取消。".into();
                    append_current_recovery_event(&mut task_status);
                    write_log(
                        &logger_for_worker,
                        LogLevel::Warn,
                        "recovery",
                        "recovery.cancelled",
                        "恢复任务已取消。",
                        [("task_id".into(), worker_task_id.clone())],
                    );
                }
                Err(error) => {
                    task_status.phase = RecoveryPhase::Failed;
                    task_status.message = error.to_string();
                    append_current_recovery_event(&mut task_status);
                    write_log(
                        &logger_for_worker,
                        LogLevel::Error,
                        "recovery",
                        "recovery.failed",
                        "恢复任务执行失败。",
                        [("task_id".into(), worker_task_id.clone())],
                    );
                }
            }
        }
        let _ = std::fs::remove_dir_all(work_directory);
    });

    Ok(initial)
}

#[tauri::command]
fn recovery_status(
    state: State<'_, AppState>,
    task_id: Option<String>,
) -> Result<Option<RecoveryTaskStatus>, String> {
    let current = state
        .recovery_task
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
fn recovery_cancel(state: State<'_, AppState>, task_id: String) -> Result<bool, String> {
    let current = state
        .recovery_task
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
        status.message = "正在停止外部引擎…".into();
    }
    write_log(
        &state.logger,
        LogLevel::Warn,
        "recovery",
        "recovery.cancel_requested",
        "已请求停止恢复任务。",
        [("task_id".into(), task_id)],
    );
    Ok(true)
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

fn unique_database_backup_path(
    exports_directory: &Path,
    created_at_ms: u64,
) -> Result<PathBuf, String> {
    std::fs::create_dir_all(exports_directory).map_err(|error| error.to_string())?;
    for _ in 0..100 {
        let sequence = DATABASE_BACKUP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path =
            exports_directory.join(format!("arcrecall-database-{created_at_ms}-{sequence}.db"));
        if !path.exists() {
            return Ok(path);
        }
    }
    Err("无法创建唯一的数据库备份文件。".into())
}

fn resolve_available_output_directory(preferred: &Path) -> PathBuf {
    if !preferred.exists() {
        return preferred.to_path_buf();
    }

    let Some(parent) = preferred.parent() else {
        return preferred.join(format!("ArcRecall 输出-{}", current_time_ms()));
    };
    let base_name = preferred
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("ArcRecall 输出");
    for suffix in 2..=9_999 {
        let candidate = parent.join(format!("{base_name} ({suffix})"));
        if !candidate.exists() {
            return candidate;
        }
    }
    parent.join(format!("{base_name}-{}", current_time_ms()))
}

fn current_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn is_sha256_fingerprint(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn next_recovery_task_id() -> String {
    let timestamp = current_time_ms();
    let sequence = RECOVERY_TASK_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("recovery-{timestamp}-{sequence}")
}

/// Data root: `{LocalAppData}/ArcRecall` (not the reverse-domain identifier).
fn resolve_app_paths(app: &AppHandle) -> Result<AppPaths, String> {
    let local = app
        .path()
        .local_data_dir()
        .map_err(|e| format!("resolve local data dir: {e}"))?;
    let paths = AppPaths::from_root(local.join(APP_DATA_FOLDER_NAME));
    paths
        .ensure_dirs()
        .map_err(|e| format!("create app data dirs: {e}"))?;
    Ok(paths)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let paths = resolve_app_paths(app.handle())?;
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
                resource_dir,
                dictionary: Mutex::new(dictionary),
                history: Mutex::new(history),
                settings: Mutex::new(settings),
                logger,
                engine_install: Arc::new(Mutex::new(())),
                recovery_task: Mutex::new(None),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            health,
            log_write,
            log_list,
            log_export,
            log_clear,
            log_open_directory,
            database_backup,
            dictionary_list,
            dictionary_count,
            dictionary_add,
            dictionary_import_file,
            dictionary_delete,
            history_list,
            history_reveal_password,
            history_delete,
            history_clear,
            database_info,
            settings_get,
            settings_set,
            tool_full_bundle_status,
            tool_full_bundle_install,
            tool_hashcat_status,
            tool_hashcat_download,
            tool_set_tools_directory,
            tool_john_perl_status,
            tool_set_john_perl,
            archive_analyze,
            recovery_start,
            recovery_status,
            recovery_cancel,
            open_output_directory,
            open_path,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run ArcRecall");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_collision_uses_next_available_sibling_directory() {
        let directory = tempfile::tempdir().expect("tempdir");
        let preferred = directory.path().join("archive");
        let second = directory.path().join("archive (2)");
        std::fs::create_dir_all(&preferred).expect("preferred");
        std::fs::create_dir_all(&second).expect("second");

        assert_eq!(
            resolve_available_output_directory(&preferred),
            directory.path().join("archive (3)")
        );
    }

    #[test]
    fn output_without_collision_keeps_preferred_directory() {
        let directory = tempfile::tempdir().expect("tempdir");
        let preferred = directory.path().join("archive");

        assert_eq!(resolve_available_output_directory(&preferred), preferred);
    }

    #[test]
    fn recovery_event_history_is_bounded_and_latest_first() {
        let mut status = test_recovery_status();
        for index in 0..100 {
            push_recovery_event(
                &mut status,
                RecoveryPhase::Preparing,
                None,
                format!("event-{index}"),
                None,
                0,
                None,
                None,
                None,
            );
        }

        assert_eq!(status.events.len(), RECOVERY_EVENT_LIMIT);
        assert_eq!(
            status.events.front().map(|event| event.message.as_str()),
            Some("event-99")
        );
        assert_eq!(
            status.events.back().map(|event| event.message.as_str()),
            Some("event-20")
        );
    }

    #[test]
    fn recovery_candidate_events_are_recorded_in_five_percent_buckets() {
        let mut status = test_recovery_status();
        for attempted in [1, 2, 4, 5, 6, 9, 10] {
            push_recovery_event(
                &mut status,
                RecoveryPhase::Internal,
                Some("7-Zip CPU".into()),
                format!("attempted {attempted}"),
                Some("archive.7z".into()),
                0,
                Some(attempted),
                Some(100),
                None,
            );
        }

        assert_eq!(status.events.len(), 3);
        assert_eq!(
            status
                .events
                .iter()
                .map(|event| event.attempted_count)
                .collect::<Vec<_>>(),
            vec![Some(10), Some(5), Some(1)]
        );
    }

    fn test_recovery_status() -> RecoveryTaskStatus {
        RecoveryTaskStatus {
            task_id: "test".into(),
            phase: RecoveryPhase::Preparing,
            running: true,
            completed: false,
            success: false,
            cancelled: false,
            archive_path: "archive.7z".into(),
            archive_format: ArchiveFormat::SevenZip,
            archive_format_label: "7z".into(),
            engine: None,
            message: "test".into(),
            candidate_count: 0,
            attempted_count: 0,
            started_at_ms: current_time_ms(),
            elapsed_ms: 0,
            recovered_password: None,
            output_directory: "output".into(),
            recursive_enabled: true,
            recursive_depth: 0,
            current_archive_path: Some("archive.7z".into()),
            nested_archive_count: 0,
            extracted_nested_archive_count: 0,
            skipped_nested_archive_count: 0,
            scanned_file_count: 0,
            depth_limit_reached: false,
            count_limit_reached: false,
            events: VecDeque::new(),
        }
    }
}
