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
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DatabaseRestorePreview {
    token: String,
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
        let info = arc_recall_core::snapshot_database_restore(Path::new(&path), &snapshot)?;
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
            },
            DatabaseRestorePreview {
                token,
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
    let lease = state.lifecycle.begin()?;
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
    let exports = state.paths.exports.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _lease = lease;
        let dictionary = dictionary.lock().map_err(|error| error.to_string())?;
        let _history = history.lock().map_err(|error| error.to_string())?;
        let safety_backup = unique_database_backup_path(&exports, current_time_ms())?;
        let info = dictionary.restore_snapshot(
            &prepared.directory.path().join("snapshot.db"),
            &safety_backup,
        )?;
        Ok::<_, String>(DatabaseRestoreResult {
            info,
            safety_backup_path: safety_backup.display().to_string(),
        })
    })
    .await
    .map_err(|error| error.to_string())?;
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
            "数据库恢复失败，原有数据保留。"
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
pub(crate) async fn database_backup(
    state: State<'_, AppState>,
) -> Result<DatabaseBackupResult, String> {
    let created_at_ms = current_time_ms();
    let exports = state.paths.exports.clone();
    let result = run_dictionary(Arc::clone(&state.dictionary), move |store| {
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
pub(crate) async fn dictionary_add(
    state: State<'_, AppState>,
    candidates: Vec<String>,
) -> Result<DictionaryCandidateAddSummary, String> {
    let result = run_dictionary(Arc::clone(&state.dictionary), move |store| {
        store
            .add_candidates(candidates)
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
    let requested_count = ids.len();
    let result = run_dictionary(Arc::clone(&state.dictionary), move |store| {
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
