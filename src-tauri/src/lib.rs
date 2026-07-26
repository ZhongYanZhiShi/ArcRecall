use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use arc_recall_core::{
    APP_DATA_FOLDER_NAME, AppPaths, AppSettings, ArchiveAnalysis, ArchiveFormat, CancellationToken,
    DatabaseInfo, DictionaryCandidateAddSummary, DictionaryCandidateQuery,
    DictionaryCandidateStore, DictionaryListResult, FullEngineBundleInstallResult,
    FullEngineBundleManager, FullEngineBundleStatus, HashcatInstallResult, HashcatStatus,
    HashcatToolDownloader, JohnPerlStatus, RecoveryJob, RecoveryPhase, RecoveryToolPaths,
    SERVICE_NAME, SettingsStore, analyze_archive, health_status, probe_john_perl,
    recover_and_extract, resolve_tools_directory,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

static RECOVERY_TASK_SEQUENCE: AtomicU64 = AtomicU64::new(1);

struct AppState {
    paths: AppPaths,
    resource_dir: PathBuf,
    dictionary: Mutex<DictionaryCandidateStore>,
    settings: Mutex<SettingsStore>,
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
    output_directory: Option<String>,
    known_password: Option<String>,
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
    recovered_password: Option<String>,
    output_directory: String,
}

#[tauri::command]
fn health() -> HealthResponse {
    HealthResponse {
        service: SERVICE_NAME,
        status: health_status(),
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
    let store = state.dictionary.lock().map_err(|e| e.to_string())?;
    store.add_candidates(candidates).map_err(|e| e.to_string())
}

#[tauri::command]
fn dictionary_import_file(
    state: State<'_, AppState>,
    path: String,
) -> Result<DictionaryCandidateAddSummary, String> {
    let store = state.dictionary.lock().map_err(|e| e.to_string())?;
    store.import_file(path).map_err(|e| e.to_string())
}

#[tauri::command]
fn dictionary_delete(state: State<'_, AppState>, ids: Vec<i64>) -> Result<u64, String> {
    let store = state.dictionary.lock().map_err(|e| e.to_string())?;
    store.delete(&ids).map_err(|e| e.to_string())
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
    let store = state.settings.lock().map_err(|e| e.to_string())?;
    store.save(&settings).map_err(|e| e.to_string())?;
    store.load().map_err(|e| e.to_string())
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
    let downloader = hashcat_downloader(&state)?;
    let result = downloader.install().map_err(|e| e.to_string())?;
    if result.success && !result.executable_path.is_empty() {
        let settings = state.settings.lock().map_err(|e| e.to_string())?;
        settings
            .save_hashcat_path(&result.executable_path)
            .map_err(|e| e.to_string())?;
    }
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
fn archive_analyze(path: String) -> Result<ArchiveAnalysis, String> {
    analyze_archive(path).map_err(|error| error.to_string())
}

#[tauri::command]
async fn recovery_start(
    state: State<'_, AppState>,
    request: RecoveryStartRequest,
) -> Result<RecoveryTaskStatus, String> {
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

    let analysis = analyze_archive(&request.archive_path).map_err(|error| error.to_string())?;
    let output_directory = request
        .output_directory
        .as_deref()
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(&analysis.suggested_output_directory));
    if !output_directory.is_absolute() {
        return Err("输出目录必须使用绝对路径。".into());
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
    let database_path = state.paths.database.clone();
    let export_path = dictionary_path.clone();
    let candidate_count = tauri::async_runtime::spawn_blocking(move || {
        let store = DictionaryCandidateStore::open(database_path)
            .map_err(|error| format!("打开全局字典失败：{error}"))?;
        store
            .export_wordlist(export_path)
            .map_err(|error| format!("导出外部引擎字典失败：{error}"))
    })
    .await
    .map_err(|error| format!("字典导出任务失败：{error}"))??;

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
        message: format!("已导出 {candidate_count} 条候选，正在启动恢复任务。"),
        candidate_count,
        recovered_password: None,
        output_directory: output_directory.display().to_string(),
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
    let job = RecoveryJob {
        archive_path: PathBuf::from(analysis.archive_path),
        output_directory,
        dictionary_path,
        dictionary_count: candidate_count,
        known_password: request.known_password,
        work_directory: work_directory.clone(),
    };
    let status_for_worker = Arc::clone(&status);
    let success_database_path = state.paths.database.clone();
    std::thread::spawn(move || {
        let outcome = recover_and_extract(&job, &tools, &cancellation, |update| {
            if let Ok(mut task_status) = status_for_worker.lock() {
                task_status.phase = update.phase;
                task_status.engine = update.engine;
                task_status.message = update.message;
            }
        });
        if let Ok(mut task_status) = status_for_worker.lock() {
            task_status.running = false;
            task_status.completed = true;
            match outcome {
                Ok(result) => {
                    task_status.success = result.success;
                    task_status.cancelled = result.cancelled;
                    task_status.phase = if result.cancelled {
                        RecoveryPhase::Cancelled
                    } else {
                        RecoveryPhase::Completed
                    };
                    task_status.engine = result.engine;
                    task_status.message = result.message;
                    task_status.recovered_password = result.password.clone();
                    task_status.output_directory = result.output_directory.display().to_string();
                    if result.success
                        && let Some(password) = result.password
                        && let Ok(store) = DictionaryCandidateStore::open(&success_database_path)
                    {
                        let _ = store.increment_success(&password);
                    }
                }
                Err(arc_recall_core::RecoveryError::Cancelled) => {
                    task_status.cancelled = true;
                    task_status.phase = RecoveryPhase::Cancelled;
                    task_status.message = "密码恢复任务已取消。".into();
                }
                Err(error) => {
                    task_status.phase = RecoveryPhase::Failed;
                    task_status.message = error.to_string();
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
    let status = task
        .status
        .lock()
        .map_err(|error| error.to_string())?
        .clone();
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
    Ok(true)
}

#[tauri::command]
fn open_output_directory(path: String) -> Result<(), String> {
    let directory = PathBuf::from(path);
    if !directory.is_dir() {
        return Err("输出目录不存在。".into());
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

fn next_recovery_task_id() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
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
            let settings = SettingsStore::open(&paths.settings)
                .map_err(|e| format!("open settings store: {e}"))?;
            app.manage(AppState {
                paths,
                resource_dir,
                dictionary: Mutex::new(dictionary),
                settings: Mutex::new(settings),
                engine_install: Arc::new(Mutex::new(())),
                recovery_task: Mutex::new(None),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            health,
            dictionary_list,
            dictionary_count,
            dictionary_add,
            dictionary_import_file,
            dictionary_delete,
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
        ])
        .run(tauri::generate_context!())
        .expect("failed to run ArcRecall");
}
