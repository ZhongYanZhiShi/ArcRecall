use crate::AppState;
use arc_recall_core::{
    DictionaryCandidateQuery, DictionaryListResult,
    task_records::{TaskRecord, TaskRecordStore},
    tools::{ArchivePreview, preview_archive},
};
use tauri::State;

#[tauri::command]
pub(crate) async fn task_records_list(
    state: State<'_, AppState>,
    skip: u32,
    failed_only: bool,
) -> Result<Vec<TaskRecord>, String> {
    let path = state.paths.root.join("task-records.db");
    tauri::async_runtime::spawn_blocking(move || {
        TaskRecordStore::open(&path)?.list(skip, failed_only)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn task_record_delete(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let path = state.paths.root.join("task-records.db");
    tauri::async_runtime::spawn_blocking(move || TaskRecordStore::open(&path)?.delete(&id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn dictionary_groups(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let store = state.dictionary.clone();
    tauri::async_runtime::spawn_blocking(move || {
        store
            .lock()
            .map_err(|e| e.to_string())?
            .groups()
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn dictionary_group_assign(
    state: State<'_, AppState>,
    name: String,
    ids: Vec<i64>,
    remove: Option<bool>,
) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty()
        || name.chars().count() > 80
        || name.chars().any(char::is_control)
        || ids.len() > 5000
    {
        return Err("分组名称需为 1–80 个可见字符，每次最多分配 5000 条候选。".into());
    }
    let store = state.dictionary.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let store = store.lock().map_err(|e| e.to_string())?;
        if remove.unwrap_or(false) {
            store.remove_group_members(&name, &ids)
        } else {
            store.assign_group(&name, &ids)
        }
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn dictionary_group_delete(
    state: State<'_, AppState>,
    name: String,
) -> Result<(), String> {
    let store = state.dictionary.clone();
    tauri::async_runtime::spawn_blocking(move || {
        store
            .lock()
            .map_err(|e| e.to_string())?
            .delete_group(&name)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn dictionary_group_list(
    state: State<'_, AppState>,
    name: String,
    query: DictionaryCandidateQuery,
) -> Result<DictionaryListResult, String> {
    let store = state.dictionary.clone();
    tauri::async_runtime::spawn_blocking(move || {
        store
            .lock()
            .map_err(|e| e.to_string())?
            .list_group(&name, &query)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn archive_preview(
    state: State<'_, AppState>,
    path: String,
    password: Option<String>,
) -> Result<ArchivePreview, String> {
    let lease = state.lifecycle.begin()?;
    let seven_zip = crate::engine_commands::require_seven_zip(&state).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let _lease = lease;
        preview_archive(
            std::path::Path::new(&path),
            password.as_deref(),
            &seven_zip,
            &_lease.cancellation,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
