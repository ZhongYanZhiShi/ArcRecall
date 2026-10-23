use crate::AppState;
use arc_recall_core::processing_presets::{ProcessingPreset, ProcessingPresetStore};
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub(crate) async fn processing_presets_list(
    state: State<'_, AppState>,
) -> Result<Vec<ProcessingPreset>, String> {
    let path = state.paths.root.join("processing-presets.db");
    tauri::async_runtime::spawn_blocking(move || ProcessingPresetStore::open(&path)?.list())
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn processing_preset_save(
    state: State<'_, AppState>,
    preset: ProcessingPreset,
    overwrite: bool,
) -> Result<(), String> {
    let lease = state.lifecycle.begin()?;
    let maintenance = Arc::clone(&state.data_maintenance);
    let path = state.paths.root.join("processing-presets.db");
    tauri::async_runtime::spawn_blocking(move || {
        let _lease = lease;
        let _guard = maintenance.lock().map_err(|e| e.to_string())?;
        ProcessingPresetStore::open(&path)?.save(&preset, overwrite)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn processing_preset_delete(
    state: State<'_, AppState>,
    name: String,
) -> Result<(), String> {
    let lease = state.lifecycle.begin()?;
    let maintenance = Arc::clone(&state.data_maintenance);
    let path = state.paths.root.join("processing-presets.db");
    tauri::async_runtime::spawn_blocking(move || {
        let _lease = lease;
        let _guard = maintenance.lock().map_err(|e| e.to_string())?;
        ProcessingPresetStore::open(&path)?.delete(&name)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn processing_preset_apply(
    state: State<'_, AppState>,
    name: String,
) -> Result<ProcessingPreset, String> {
    let path = state.paths.root.join("processing-presets.db");
    let dictionary = state.dictionary.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let preset = ProcessingPresetStore::open(&path)?
            .list()?
            .into_iter()
            .find(|p| p.name == name)
            .ok_or("预设已不存在，请刷新列表。")?;
        if let Some(group) = &preset.dictionary_group
            && !dictionary
                .lock()
                .map_err(|e| e.to_string())?
                .groups()
                .map_err(|e| e.to_string())?
                .contains(group)
        {
            return Err("预设中的字典分组已删除，请调整当前选项后覆盖保存预设。".into());
        }
        if let Some(output) = &preset.output_directory
            && !std::path::Path::new(output).is_dir()
        {
            return Err(
                "预设中的输出目录已不存在或不可访问，请调整当前选项后覆盖保存预设。".into(),
            );
        }
        Ok(preset)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn archive_folder_scan(
    state: State<'_, AppState>,
    id: String,
    path: String,
    include_subfolders: bool,
) -> Result<arc_recall_core::tools::FolderScanResult, String> {
    let lease = state.lifecycle.begin()?;
    let _reservation = crate::task_coordination::TaskStartReservation::acquire(
        &state.archive_task_starting,
        "已有归档操作正在运行，请先等待完成或取消。",
    )?;
    crate::ensure_no_active_archive_task(&state)?;
    *state.archive_action.lock().map_err(|e| e.to_string())? =
        Some((id, lease.cancellation.clone()));
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _lease = lease;
        arc_recall_core::tools::scan_archive_folder(
            std::path::Path::new(&path),
            include_subfolders,
            &_lease.cancellation,
        )
    })
    .await
    .map_err(|_| "文件夹扫描意外终止。".to_string());
    *state.archive_action.lock().map_err(|e| e.to_string())? = None;
    result?
}
