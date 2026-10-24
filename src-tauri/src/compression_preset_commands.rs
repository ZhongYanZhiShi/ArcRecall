use crate::AppState;
use arc_recall_core::compression_presets::{CompressionPreset, CompressionPresetStore};
use tauri::State;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CompressionRetryDraft {
    record: arc_recall_core::task_records::TaskRecord,
    missing_sources: Vec<String>,
    output_missing: bool,
}

#[tauri::command]
pub(crate) async fn compression_retry_prepare(
    state: State<'_, AppState>,
    id: String,
) -> Result<CompressionRetryDraft, String> {
    let lease = state.lifecycle.begin()?;
    crate::ensure_no_active_archive_task(&state)?;
    let path = state.paths.root.join("task-records.db");
    tauri::async_runtime::spawn_blocking(move || {
        let _lease = lease;
        let record = arc_recall_core::task_records::TaskRecordStore::open(&path)?
            .find(&id)?
            .ok_or("任务记录已不存在，请刷新列表。")?;
        if record.operation != arc_recall_core::task_records::TaskOperation::Compression
            || record.state == "running"
        {
            return Err("此记录不能准备重新压缩。".into());
        }
        let compression = record
            .compression
            .as_ref()
            .ok_or("旧任务未记录压缩参数，请手动创建压缩任务。")?;
        compression.validate()?;
        if record.source_paths.is_empty() {
            return Err("记录中没有压缩源文件。".into());
        }
        let missing_sources = record
            .source_paths
            .iter()
            .filter(|source| {
                std::fs::metadata(source).map_or(true, |m| !m.is_file() && !m.is_dir())
            })
            .cloned()
            .collect();
        let output_missing = compression
            .options
            .output_directory
            .as_ref()
            .is_some_and(|path| !std::path::Path::new(path).is_dir());
        Ok(CompressionRetryDraft {
            record,
            missing_sources,
            output_missing,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn compression_presets_list(
    state: State<'_, AppState>,
) -> Result<Vec<CompressionPreset>, String> {
    let path = state.paths.root.join("compression-presets.db");
    tauri::async_runtime::spawn_blocking(move || CompressionPresetStore::open(&path)?.list())
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn compression_preset_save(
    state: State<'_, AppState>,
    preset: CompressionPreset,
    overwrite: bool,
) -> Result<(), String> {
    let lease = state.lifecycle.begin()?;
    let maintenance = state.data_maintenance.clone();
    let path = state.paths.root.join("compression-presets.db");
    tauri::async_runtime::spawn_blocking(move || {
        let _lease = lease;
        let _guard = maintenance.lock().map_err(|e| e.to_string())?;
        CompressionPresetStore::open(&path)?.save(&preset, overwrite)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn compression_preset_delete(
    state: State<'_, AppState>,
    name: String,
) -> Result<(), String> {
    let lease = state.lifecycle.begin()?;
    let maintenance = state.data_maintenance.clone();
    let path = state.paths.root.join("compression-presets.db");
    tauri::async_runtime::spawn_blocking(move || {
        let _lease = lease;
        let _guard = maintenance.lock().map_err(|e| e.to_string())?;
        CompressionPresetStore::open(&path)?.delete(&name)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn compression_preset_apply(
    state: State<'_, AppState>,
    name: String,
) -> Result<CompressionPreset, String> {
    let path = state.paths.root.join("compression-presets.db");
    tauri::async_runtime::spawn_blocking(move || {
        let preset = CompressionPresetStore::open(&path)?
            .list()?
            .into_iter()
            .find(|p| p.name == name)
            .ok_or("压缩预设已不存在，请刷新列表。")?;
        preset.options.check_output()?;
        Ok(preset)
    })
    .await
    .map_err(|e| e.to_string())?
}
