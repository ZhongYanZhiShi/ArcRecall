use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use arc_recall_core::{
    AppSettings, DatabaseInfo, DictionaryCandidateAddSummary, DictionaryCandidateQuery,
    DictionaryCandidateStore, DictionaryListResult, SettingsUpdate,
};
use serde::Serialize;
use tauri::State;

use crate::logging::LogLevel;
use crate::{AppState, apply_logging_settings, current_time_ms, write_log};

static DATABASE_BACKUP_SEQUENCE: AtomicU64 = AtomicU64::new(1);

pub(crate) struct PreparedDatabaseRestore {
    token: String,
    directory: tempfile::TempDir,
    unreadable_password_count: usize,
    contents: Option<arc_recall_core::backup::BackupContents>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DatabaseRestorePreview {
    token: String,
    unified: bool,
    preset_count: usize,
    compression_preset_count: Option<usize>,
    task_record_count: usize,
    includes_settings: bool,
    #[serde(flatten)]
    info: arc_recall_core::DatabaseRestoreInfo,
    unreadable_password_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DatabaseRestoreResult {
    safety_backup_path: String,
    #[serde(flatten)]
    info: arc_recall_core::DatabaseRestoreInfo,
}

#[tauri::command]
pub(crate) async fn database_restore_preview(
    state: State<'_, AppState>,
    path: String,
) -> Result<DatabaseRestorePreview, String> {
    let lease = state.lifecycle.begin()?;
    let (prepared, preview) = tauri::async_runtime::spawn_blocking(move || {
        let _lease = lease;
        let directory = tempfile::Builder::new()
            .prefix("arcrecall-restore-")
            .tempdir()
            .map_err(|error| error.to_string())?;
        let snapshot = directory.path().join("snapshot.db");
        let (info, contents) = arc_recall_core::backup::prepare(Path::new(&path), &snapshot)?;
        let history = arc_recall_core::RecoveryHistoryStore::open(&snapshot)
            .map_err(|error| error.to_string())?;
        let migration = crate::history_support::migrate_legacy_history_passwords(&history)?;
        if migration.failed_count > 0 {
            return Err("备份中的旧密码无法安全迁移。".to_string());
        }
        let unreadable_password_count = history
            .stored_passwords()
            .map_err(|error| error.to_string())?
            .iter()
            .filter(|record| {
                crate::credential_protection::unprotect_history_password(&record.protected_password)
                    .is_err()
            })
            .count();
        let token = format!(
            "{}-{}",
            current_time_ms(),
            DATABASE_BACKUP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        );
        Ok::<_, String>((
            PreparedDatabaseRestore {
                token: token.clone(),
                directory,
                unreadable_password_count,
                contents: contents.clone(),
            },
            DatabaseRestorePreview {
                token,
                unified: contents.is_some(),
                preset_count: contents.as_ref().map_or(0, |data| data.presets.len()),
                compression_preset_count: contents
                    .as_ref()
                    .and_then(|data| data.compression_presets.as_ref().map(Vec::len)),
                task_record_count: contents.as_ref().map_or(0, |data| data.records.len()),
                includes_settings: contents.is_some(),
                info,
                unreadable_password_count,
            },
        ))
    })
    .await
    .map_err(|error| error.to_string())??;
    *state
        .prepared_restore
        .lock()
        .map_err(|error| error.to_string())? = Some(prepared);
    Ok(preview)
}

#[tauri::command]
pub(crate) fn database_restore_discard(
    state: State<'_, AppState>,
    token: String,
) -> Result<(), String> {
    let mut prepared = state
        .prepared_restore
        .lock()
        .map_err(|error| error.to_string())?;
    if prepared.as_ref().is_some_and(|item| item.token == token) {
        *prepared = None;
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn database_restore_apply(
    state: State<'_, AppState>,
    token: String,
) -> Result<DatabaseRestoreResult, String> {
    let lease = state.lifecycle.reserve_idle_maintenance()?;
    let _reservation = crate::task_coordination::TaskStartReservation::acquire(
        &state.archive_task_starting,
        "当前有归档或数据维护操作，请稍后恢复。",
    )?;
    crate::ensure_no_active_archive_task(&state)?;
    let prepared = {
        let mut slot = state
            .prepared_restore
            .lock()
            .map_err(|error| error.to_string())?;
        let candidate = slot.as_ref().ok_or("请重新选择并校验备份。")?;
        if candidate.token != token {
            return Err("备份预览已过期，请重新选择。".into());
        }
        if candidate.unreadable_password_count > 0 {
            return Err(
                "备份包含当前 Windows 账户无法解密的密码，请使用创建备份的账户恢复。".into(),
            );
        }
        slot.take().expect("checked prepared restore")
    };
    let dictionary = Arc::clone(&state.dictionary);
    let history = Arc::clone(&state.history);
    let paths = state.paths.clone();
    let settings = Arc::clone(&state.settings);
    let maintenance = Arc::clone(&state.data_maintenance);
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _lease = lease;
        let _maintenance = maintenance.lock().map_err(|error| error.to_string())?;
        let dictionary = dictionary.lock().map_err(|error| error.to_string())?;
        let _history = history.lock().map_err(|error| error.to_string())?;
        let settings = settings.lock().map_err(|error| error.to_string())?;
        let safety_backup = unique_database_backup_path(&paths.exports, current_time_ms())?
            .with_extension("arcrecall");
        let info = arc_recall_core::backup::restore(
            &paths,
            &dictionary,
            &settings,
            &prepared.directory.path().join("snapshot.db"),
            prepared.contents.as_ref(),
            &safety_backup,
        )?;
        Ok::<_, String>(DatabaseRestoreResult {
            info,
            safety_backup_path: safety_backup.display().to_string(),
        })
    })
    .await
    .map_err(|error| error.to_string())?;
    if result.is_ok() {
        let settings = state
            .settings
            .lock()
            .map_err(|e| e.to_string())?
            .load()
            .map_err(|e| e.to_string())?;
        apply_logging_settings(&state.logger, &settings.logging)?;
    }
    write_log(
        &state.logger,
        if result.is_ok() {
            LogLevel::Info
        } else {
            LogLevel::Error
        },
        "database",
        "database.restore_finished",
        if result.is_ok() {
            "数据库已从备份恢复。"
        } else {
            "数据恢复未完成，请查看恢复结果。"
        },
        std::iter::empty(),
    );
    result
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DatabaseBackupResult {
    path: String,
    byte_count: u64,
    created_at_ms: u64,
}

#[tauri::command]
pub(crate) async fn data_backup(
    state: State<'_, AppState>,
) -> Result<DatabaseBackupResult, String> {
    let lease = state.lifecycle.reserve_idle_maintenance()?;
    let _reservation = crate::task_coordination::TaskStartReservation::acquire(
        &state.archive_task_starting,
        "请等待当前归档或数据维护操作完成后再备份。",
    )?;
    crate::ensure_no_active_archive_task(&state)?;
    let paths = state.paths.clone();
    let dictionary = Arc::clone(&state.dictionary);
    let history = Arc::clone(&state.history);
    let settings = Arc::clone(&state.settings);
    let maintenance = Arc::clone(&state.data_maintenance);
    tauri::async_runtime::spawn_blocking(move || {
        let _lease = lease;
        let _maintenance = maintenance.lock().map_err(|e| e.to_string())?;
        let dictionary = dictionary.lock().map_err(|e| e.to_string())?;
        let _history = history.lock().map_err(|e| e.to_string())?;
        let settings = settings.lock().map_err(|e| e.to_string())?;
        let created_at_ms = current_time_ms();
        let destination =
            unique_database_backup_path(&paths.exports, created_at_ms)?.with_extension("arcrecall");
        let byte_count =
            arc_recall_core::backup::create(&paths, &dictionary, &settings, &destination)?;
        Ok(DatabaseBackupResult {
            path: destination.display().to_string(),
            byte_count,
            created_at_ms,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn database_backup(
    state: State<'_, AppState>,
) -> Result<DatabaseBackupResult, String> {
    let lease = state.lifecycle.begin()?;
    let created_at_ms = current_time_ms();
    let exports = state.paths.exports.clone();
    let result = run_dictionary(Arc::clone(&state.dictionary), move |store| {
        // Keep the lease inside the worker even if the awaiting IPC future is dropped.
        let _lease = lease;
        let destination = unique_database_backup_path(&exports, created_at_ms)?;
        let byte_count = store
            .backup(&destination)
            .map_err(|error| error.to_string())?;
        Ok((destination, byte_count))
    })
    .await;
    match result {
        Ok((destination, byte_count)) => {
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
pub(crate) async fn dictionary_list(
    state: State<'_, AppState>,
    query: DictionaryCandidateQuery,
) -> Result<DictionaryListResult, String> {
    run_dictionary(Arc::clone(&state.dictionary), move |store| {
        store.list(&query).map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub(crate) async fn dictionary_count(state: State<'_, AppState>) -> Result<u64, String> {
    run_dictionary(Arc::clone(&state.dictionary), |store| {
        store.count().map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub(crate) fn dictionary_import_begin(state: State<'_, AppState>) -> Result<String, String> {
    state.dictionary_imports.begin(&state.lifecycle)
}

#[tauri::command]
pub(crate) fn dictionary_import_finish(state: State<'_, AppState>, id: String) {
    state.dictionary_imports.finish(&id);
}

#[tauri::command]
pub(crate) async fn dictionary_add(
    state: State<'_, AppState>,
    candidates: Vec<String>,
    group: Option<String>,
    import_id: Option<String>,
) -> Result<DictionaryCandidateAddSummary, String> {
    let lease = match import_id {
        Some(id) => state.dictionary_imports.batch(&id)?,
        None => Arc::new(state.lifecycle.begin()?),
    };
    let result = run_dictionary(Arc::clone(&state.dictionary), move |store| {
        let _lease = lease;
        if _lease.cancellation.is_cancelled() {
            return Err("字典导入已取消。".into());
        }
        store
            .add_candidates_to_group(candidates, group.as_deref())
            .map_err(|error| error.to_string())
    })
    .await;
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
pub(crate) async fn dictionary_delete(
    state: State<'_, AppState>,
    ids: Vec<i64>,
) -> Result<u64, String> {
    let lease = state.lifecycle.begin()?;
    let requested_count = ids.len();
    let result = run_dictionary(Arc::clone(&state.dictionary), move |store| {
        let _lease = lease;
        store.delete(&ids).map_err(|error| error.to_string())
    })
    .await;
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
pub(crate) async fn database_info(state: State<'_, AppState>) -> Result<DatabaseInfo, String> {
    let count = run_dictionary(Arc::clone(&state.dictionary), |store| {
        store.count().map_err(|error| error.to_string())
    })
    .await?;
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

async fn run_dictionary<T: Send + 'static>(
    store: Arc<Mutex<DictionaryCandidateStore>>,
    operation: impl FnOnce(&DictionaryCandidateStore) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = store.lock().map_err(|error| error.to_string())?;
        operation(&store)
    })
    .await
    .map_err(|error| format!("数据库任务失败：{error}"))?
}

#[tauri::command]
pub(crate) fn settings_get(state: State<'_, AppState>) -> Result<AppSettings, String> {
    let settings = state.settings.lock().map_err(|error| error.to_string())?;
    settings.load().map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn settings_update(
    state: State<'_, AppState>,
    update: SettingsUpdate,
) -> Result<AppSettings, String> {
    let result = {
        let store = state.settings.lock().map_err(|error| error.to_string())?;
        store
            .update_preferences(update)
            .map_err(|error| error.to_string())
    };
    match &result {
        Ok(settings) => {
            let logging = &settings.logging;
            apply_logging_settings(&state.logger, logging)?;
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

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use crate::credential_protection::{protect_history_password, unprotect_history_password};
    use arc_recall_core::{RecoveryHistoryRecord, RecoveryHistoryStore};

    fn test_state(directory: &Path) -> AppState {
        use crate::logging::LogStore;
        use crate::task_lifecycle::{RecoverySession, TaskLifecycle};
        use arc_recall_core::{AppPaths, SettingsStore};
        use std::sync::atomic::AtomicBool;
        let paths = AppPaths::from_root(directory);
        paths.ensure_dirs().unwrap();
        let dictionary = Arc::new(Mutex::new(
            DictionaryCandidateStore::open(&paths.database).unwrap(),
        ));
        dictionary
            .lock()
            .unwrap()
            .add_candidates(["backup-fixture"])
            .unwrap();
        let lifecycle = Arc::new(TaskLifecycle::default());
        AppState {
            queue_journal: Arc::new(Mutex::new(crate::queue_journal::QueueJournal::new(
                paths.root.join("recovery-queue.json"),
            ))),
            history: Arc::new(Mutex::new(
                RecoveryHistoryStore::open(&paths.database).unwrap(),
            )),
            settings: Arc::new(Mutex::new(SettingsStore::open(&paths.settings).unwrap())),
            data_maintenance: Arc::new(Mutex::new(())),
            logger: Arc::new(LogStore::new(&paths.logs).unwrap()),
            recovery_session: RecoverySession::create(&paths.temp).unwrap(),
            paths,
            resource_dir: directory.to_path_buf(),
            dictionary: Arc::clone(&dictionary),
            dictionary_imports: crate::dictionary_imports::DictionaryImports::default(),
            prepared_restore: Mutex::new(None),
            recovery_task: Mutex::new(None),
            compression_task: Mutex::new(None),
            archive_task_starting: AtomicBool::new(false),
            archive_action: Mutex::new(None),
            batch_check: Arc::new(Mutex::new(None)),
            lifecycle: Arc::clone(&lifecycle),
            exit_ready: AtomicBool::new(false),
            seven_zip_cache: Arc::new(Mutex::new(None)),
        }
    }

    #[test]
    fn backup_command_blocks_updates_and_shutdown_until_native_worker_finishes() {
        use std::time::{Duration, Instant};
        use tauri::Manager;

        let directory = tempfile::tempdir().unwrap();
        let state = test_state(directory.path());
        let lifecycle = Arc::clone(&state.lifecycle);
        let dictionary = Arc::clone(&state.dictionary);
        // Only the window runtime is mocked; the command, worker, lifecycle and SQLite are real.
        let app = tauri::test::mock_builder()
            .manage(state)
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let update = lifecycle.reserve_update().unwrap();
        assert!(tauri::async_runtime::block_on(database_backup(app.state())).is_err());
        drop(update);

        let guard = dictionary.lock().unwrap();
        let handle = app.handle().clone();
        let backup =
            tauri::async_runtime::spawn(async move { database_backup(handle.state()).await });
        let start = Instant::now();
        loop {
            if lifecycle.reserve_update().is_err() {
                break;
            }
            assert!(
                start.elapsed() < Duration::from_secs(5),
                "backup did not acquire its lease"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(lifecycle.request_shutdown());
        let waiting = Arc::clone(&lifecycle);
        let (sender, receiver) = std::sync::mpsc::channel();
        let shutdown = std::thread::spawn(move || {
            waiting.wait_until_finished();
            sender.send(()).unwrap();
        });
        assert!(receiver.recv_timeout(Duration::from_millis(100)).is_err());
        drop(guard);
        let result = tauri::async_runtime::block_on(backup).unwrap().unwrap();
        receiver.recv_timeout(Duration::from_secs(5)).unwrap();
        shutdown.join().unwrap();
        assert!(result.byte_count > 0);
        assert_eq!(
            DictionaryCandidateStore::open(result.path)
                .unwrap()
                .count()
                .unwrap(),
            1
        );
    }

    #[test]
    fn completed_archive_workers_keep_shutdown_waiting_until_final_records_are_saved() {
        use arc_recall_core::task_records::TaskRecordStore;
        use std::os::windows::process::CommandExt;
        use std::time::{Duration, Instant};
        use tauri::Manager;

        let executable = std::env::var_os("ARC_RECALL_TEST_7ZIP")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("C:/Program Files/7-Zip/7z.exe"));
        assert!(executable.exists(), "native regression requires 7-Zip");
        for batch in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let state = test_state(directory.path());
            let tools = state.paths.tools.join("7zip/26.02");
            std::fs::create_dir_all(&tools).unwrap();
            std::fs::copy(&executable, tools.join("7z.exe")).unwrap();
            std::fs::copy(executable.with_file_name("7z.dll"), tools.join("7z.dll")).unwrap();
            let source = directory.path().join("归档内容.txt");
            let archive = directory.path().join("测试归档.7z");
            std::fs::write(&source, "native finalization fixture").unwrap();
            assert!(
                std::process::Command::new(&executable)
                    .creation_flags(0x08000000)
                    .args(["a", "-t7z"])
                    .arg(&archive)
                    .arg(&source)
                    .output()
                    .unwrap()
                    .status
                    .success()
            );
            let lifecycle = Arc::clone(&state.lifecycle);
            let cache = Arc::clone(&state.seven_zip_cache);
            // Delay engine preparation so we can hold the finalization mutex.
            let cache_guard = cache.lock().unwrap();
            let app = tauri::test::mock_builder()
                .manage(state)
                .build(tauri::test::mock_context(tauri::test::noop_assets()))
                .unwrap();
            let handle = app.handle().clone();
            let task = tauri::async_runtime::spawn(async move {
                if batch {
                    crate::batch_check_commands::archive_batch_check_run(
                        handle.state(),
                        "finalization".into(),
                        vec![archive.to_string_lossy().into_owned()],
                        None,
                        None,
                    )
                    .await
                    .map(|_| ())
                } else {
                    crate::workflow_commands::archive_action_run(
                        handle.state(),
                        "finalization".into(),
                        arc_recall_core::tools::ArchiveActionRequest {
                            path: archive,
                            password: None,
                            selected_paths: None,
                            output_parent: None,
                        },
                    )
                    .await
                    .map(|_| ())
                }
            });
            let state = app.state::<AppState>();
            let deadline = Instant::now() + Duration::from_secs(10);
            let finalization_guard = loop {
                let guard = state.archive_action.lock().unwrap();
                if guard.is_some() {
                    break guard;
                }
                drop(guard);
                assert!(Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(5));
            };
            let workspace = state.recovery_session.directory().to_path_buf();
            drop(cache_guard);
            // A completed batch exposes its terminal status before final persistence.
            // For a single action the tiny real archive completes within the deadline.
            std::thread::sleep(Duration::from_millis(500));
            if batch {
                while serde_json::to_value(state.batch_check.lock().unwrap().as_ref().unwrap())
                    .unwrap()["running"]
                    == true
                {
                    assert!(Instant::now() < deadline);
                    std::thread::sleep(Duration::from_millis(5));
                }
            }
            assert_eq!(
                std::fs::read_dir(&workspace).unwrap().count(),
                1,
                "worker workspace must already be cleaned"
            );
            assert!(lifecycle.request_shutdown());
            let waiting = Arc::clone(&lifecycle);
            let (sender, receiver) = std::sync::mpsc::channel();
            let shutdown = std::thread::spawn(move || {
                waiting.wait_until_finished();
                sender.send(()).unwrap();
            });
            let premature = receiver.recv_timeout(Duration::from_millis(100)).is_ok();
            drop(finalization_guard);
            tauri::async_runtime::block_on(task).unwrap().unwrap();
            if !premature {
                receiver.recv_timeout(Duration::from_secs(5)).unwrap();
            }
            shutdown.join().unwrap();
            assert!(
                !premature,
                "shutdown released before final record persistence (batch={batch})"
            );
            let records = TaskRecordStore::open(&directory.path().join("task-records.db"))
                .unwrap()
                .all()
                .unwrap();
            assert_eq!(records.len(), 1);
            assert_eq!(records[0].state, "success");
        }
    }

    #[test]
    fn sqlite_restore_round_trips_real_dpapi_history_and_preserves_old_data_backup() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.db");
        let source_dictionary = DictionaryCandidateStore::open(&source).unwrap();
        source_dictionary.add_candidates(["candidate"]).unwrap();
        let history = RecoveryHistoryStore::open(&source).unwrap();
        history
            .upsert_many(&[RecoveryHistoryRecord {
                fingerprint_sha256: "a".repeat(64),
                root_fingerprint_sha256: None,
                archive_name: None,
                archive_path: None,
                output_directory: None,
                archive_format: "ZIP".into(),
                file_size: 22,
                volume_count: 1,
                verified_at_ms: 100,
                protected_password: Some(
                    protect_history_password("restore-fixture-secret").unwrap(),
                ),
            }])
            .unwrap();
        let snapshot = dir.path().join("snapshot.db");
        let info = arc_recall_core::snapshot_database_restore(&source, &snapshot).unwrap();
        assert_eq!(info.password_count, 1);
        let target = dir.path().join("target.db");
        let dictionary = DictionaryCandidateStore::open(&target).unwrap();
        dictionary.add_candidates(["original"]).unwrap();
        let target_history = RecoveryHistoryStore::open(&target).unwrap();
        let safety = dir.path().join("safety.db");
        dictionary.restore_snapshot(&snapshot, &safety).unwrap();
        let password = target_history
            .stored_passwords()
            .unwrap()
            .remove(0)
            .protected_password;
        assert_eq!(
            unprotect_history_password(&password).unwrap(),
            "restore-fixture-secret"
        );
        assert_eq!(
            DictionaryCandidateStore::open(safety)
                .unwrap()
                .get_value(1)
                .unwrap()
                .as_deref(),
            Some("original")
        );
        assert!(
            !String::from_utf8_lossy(&std::fs::read(target).unwrap())
                .contains("restore-fixture-secret")
        );
    }
}
