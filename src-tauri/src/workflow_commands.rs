use crate::AppState;
use arc_recall_core::{
    DictionaryCandidateQuery, DictionaryListResult,
    task_records::{TaskOperation, TaskRecord, TaskRecordStore},
    tools::{ArchivePreview, preview_archive},
};
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub(crate) async fn archive_action_run(
    state: State<'_, AppState>,
    id: String,
    request: arc_recall_core::tools::ArchiveActionRequest,
) -> Result<arc_recall_core::tools::ArchiveActionResult, String> {
    // The command owns final persistence; the worker also retains ownership
    // so dropping an IPC future cannot release a still-running native task.
    let lease = Arc::new(state.lifecycle.begin()?);
    let _reservation = crate::task_coordination::TaskStartReservation::acquire(
        &state.archive_task_starting,
        "已有归档操作正在运行，请先等待完成或取消。",
    )?;
    crate::ensure_no_active_archive_task(&state)?;
    let cancellation = lease.cancellation.clone();
    let mut record = TaskRecord {
        task_id: format!("action-{}-{}", crate::current_time_ms(), id),
        operation: if request.selected_paths.is_some() {
            TaskOperation::SelectiveExtraction
        } else {
            TaskOperation::IntegrityCheck
        },
        archive_path: request.path.to_string_lossy().into_owned(),
        selected_paths: request.selected_paths.clone().unwrap_or_default(),
        started_at_ms: crate::current_time_ms(),
        state: "running".into(),
        ..Default::default()
    };
    *state.archive_action.lock().map_err(|e| e.to_string())? =
        Some((id, lease.cancellation.clone()));
    let result = async {
        TaskRecordStore::open(&state.paths.root.join("task-records.db"))?
            .save_for_session(&record, state.recovery_session.directory())?;
        let seven_zip = crate::engine_commands::require_seven_zip(&state).await?;
        let workspace = tempfile::Builder::new()
            .prefix("archive-action-")
            .tempdir_in(state.recovery_session.directory())
            .map_err(|e| e.to_string())?;
        let worker_lease = Arc::clone(&lease);
        tauri::async_runtime::spawn_blocking(move || {
            let _lease = worker_lease;
            arc_recall_core::tools::run_archive_action(
                &request,
                &seven_zip,
                workspace.path(),
                &_lease.cancellation,
            )
        })
        .await
        .map_err(|_| "归档操作意外终止。".to_string())?
    }
    .await;
    *state.archive_action.lock().map_err(|e| e.to_string())? = None;
    record.elapsed_ms = crate::current_time_ms().saturating_sub(record.started_at_ms);
    record.state = if result.is_ok() {
        "success"
    } else if cancellation.is_cancelled() {
        "cancelled"
    } else {
        "failed"
    }
    .into();
    if let Ok(value) = &result {
        record.output_directory = value.output_directory.clone().unwrap_or_default();
    }
    if result.is_err() {
        record.failure_kind = Some("Process".into());
    }
    TaskRecordStore::open(&state.paths.root.join("task-records.db"))?
        .save(&record)
        .map_err(|_| {
            "归档操作已结束，但任务记录保存失败，请先检查记录再决定是否重试。".to_string()
        })?;
    result
}

#[tauri::command]
pub(crate) fn archive_action_cancel(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let action = state.archive_action.lock().map_err(|e| e.to_string())?;
    if let Some((active, token)) = action.as_ref()
        && active == &id
    {
        token.cancel();
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn task_records_list(
    state: State<'_, AppState>,
    skip: u32,
    failed_only: bool,
    operation: Option<TaskOperation>,
) -> Result<Vec<TaskRecord>, String> {
    let path = state.paths.root.join("task-records.db");
    tauri::async_runtime::spawn_blocking(move || {
        TaskRecordStore::open(&path)?.list_filtered(skip, failed_only, operation)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn task_record_delete(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    crate::record_management_commands::delete_records(&state, vec![id])
        .await
        .map(|_| ())
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
    let lease = state.lifecycle.begin()?;
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
        let _lease = lease;
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
    let lease = state.lifecycle.begin()?;
    let store = state.dictionary.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _lease = lease;
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
