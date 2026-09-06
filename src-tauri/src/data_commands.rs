use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use arc_recall_core::{
    AppSettings, DatabaseInfo, DictionaryCandidateAddSummary, DictionaryCandidateQuery,
    DictionaryListResult, MAX_LOG_MAX_DISK_MIB, MIN_LOG_MAX_DISK_MIB,
};
use serde::Serialize;
use tauri::State;

use crate::logging::LogLevel;
use crate::{AppState, apply_logging_settings, current_time_ms, write_log};

static DATABASE_BACKUP_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DatabaseBackupResult {
    path: String,
    byte_count: u64,
    created_at_ms: u64,
}

#[tauri::command]
pub(crate) fn database_backup(state: State<'_, AppState>) -> Result<DatabaseBackupResult, String> {
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
pub(crate) fn dictionary_list(
    state: State<'_, AppState>,
    query: DictionaryCandidateQuery,
) -> Result<DictionaryListResult, String> {
    let store = state.dictionary.lock().map_err(|error| error.to_string())?;
    store.list(&query).map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn dictionary_count(state: State<'_, AppState>) -> Result<u64, String> {
    let store = state.dictionary.lock().map_err(|error| error.to_string())?;
    store.count().map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn dictionary_add(
    state: State<'_, AppState>,
    candidates: Vec<String>,
) -> Result<DictionaryCandidateAddSummary, String> {
    let result = {
        let store = state.dictionary.lock().map_err(|error| error.to_string())?;
        store
            .add_candidates(candidates)
            .map_err(|error| error.to_string())
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
pub(crate) fn dictionary_delete(state: State<'_, AppState>, ids: Vec<i64>) -> Result<u64, String> {
    let requested_count = ids.len();
    let result = {
        let store = state.dictionary.lock().map_err(|error| error.to_string())?;
        store.delete(&ids).map_err(|error| error.to_string())
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
pub(crate) fn database_info(state: State<'_, AppState>) -> Result<DatabaseInfo, String> {
    let store = state.dictionary.lock().map_err(|error| error.to_string())?;
    let count = store.count().map_err(|error| error.to_string())?;
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
pub(crate) fn settings_get(state: State<'_, AppState>) -> Result<AppSettings, String> {
    let settings = state.settings.lock().map_err(|error| error.to_string())?;
    settings.load().map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn settings_set(
    state: State<'_, AppState>,
    settings: AppSettings,
) -> Result<AppSettings, String> {
    if !settings.logging.has_valid_disk_limit() {
        return Err(format!(
            "日志最大占用必须在 {MIN_LOG_MAX_DISK_MIB}–{MAX_LOG_MAX_DISK_MIB} MiB 之间。"
        ));
    }
    let logging = settings.logging.clone();
    let result = {
        let store = state.settings.lock().map_err(|error| error.to_string())?;
        store.save(&settings).map_err(|error| error.to_string())?;
        store.load().map_err(|error| error.to_string())
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
