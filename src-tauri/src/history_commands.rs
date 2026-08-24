use arc_recall_core::{RecoveryHistoryListResult, RecoveryHistoryQuery};
use tauri::State;

use crate::history_support::reveal_history_password;
use crate::logging::LogLevel;
use crate::{AppState, write_log};

#[tauri::command]
pub(crate) fn history_list(
    state: State<'_, AppState>,
    query: RecoveryHistoryQuery,
) -> Result<RecoveryHistoryListResult, String> {
    let store = state.history.lock().map_err(|error| error.to_string())?;
    store.list(&query).map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn history_reveal_password(
    state: State<'_, AppState>,
    id: i64,
) -> Result<Option<String>, String> {
    let result = {
        let store = state.history.lock().map_err(|error| error.to_string())?;
        reveal_history_password(&store, id)
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
pub(crate) fn history_delete(state: State<'_, AppState>, id: i64) -> Result<bool, String> {
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
pub(crate) fn history_clear(state: State<'_, AppState>) -> Result<u64, String> {
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
