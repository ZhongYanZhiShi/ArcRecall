use std::sync::Arc;

use arc_recall_core::{RecoveryHistoryListResult, RecoveryHistoryQuery};
use tauri::State;

use crate::history_support::reveal_history_password;
use crate::logging::LogLevel;
use crate::{AppState, write_log};

#[tauri::command]
pub(crate) async fn history_list(
    state: State<'_, AppState>,
    query: RecoveryHistoryQuery,
) -> Result<RecoveryHistoryListResult, String> {
    let history = Arc::clone(&state.history);
    run_history(move || {
        let store = history.lock().map_err(|error| error.to_string())?;
        store.list(&query).map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub(crate) async fn history_reveal_password(
    state: State<'_, AppState>,
    id: i64,
) -> Result<Option<String>, String> {
    let history = Arc::clone(&state.history);
    let logger = Arc::clone(&state.logger);
    run_history(move || {
        let result = {
            let store = history.lock().map_err(|error| error.to_string())?;
            reveal_history_password(&store, id)
        };
        if result.as_ref().is_ok_and(Option::is_some) {
            write_log(
                &logger,
                LogLevel::Info,
                "history",
                "history.password_revealed",
                "用户查看了一条本机历史密码。",
                std::iter::empty(),
            );
        }
        result
    })
    .await
}

#[tauri::command]
pub(crate) async fn history_delete(state: State<'_, AppState>, id: i64) -> Result<bool, String> {
    let history = Arc::clone(&state.history);
    let logger = Arc::clone(&state.logger);
    run_history(move || {
        let result = {
            let store = history.lock().map_err(|error| error.to_string())?;
            store.delete(id).map_err(|error| error.to_string())
        };
        if result.as_ref().is_ok_and(|deleted| *deleted) {
            write_log(
                &logger,
                LogLevel::Info,
                "history",
                "history.entry_deleted",
                "一条恢复历史已删除。",
                std::iter::empty(),
            );
        }
        result
    })
    .await
}

#[tauri::command]
pub(crate) async fn history_clear(state: State<'_, AppState>) -> Result<u64, String> {
    let history = Arc::clone(&state.history);
    let logger = Arc::clone(&state.logger);
    run_history(move || {
        let result = {
            let store = history.lock().map_err(|error| error.to_string())?;
            store.clear().map_err(|error| error.to_string())
        };
        if let Ok(removed_count) = &result {
            write_log(
                &logger,
                LogLevel::Info,
                "history",
                "history.cleared",
                "恢复历史已清空。",
                [("removed_count".into(), removed_count.to_string())],
            );
        }
        result
    })
    .await
}

async fn run_history<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| format!("恢复历史任务失败：{error}"))?
}
