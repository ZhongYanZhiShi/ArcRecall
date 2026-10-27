use crate::AppState;
use arc_recall_core::compression_presets::CompressionOptions;
use serde::{Deserialize, Serialize};
use std::{fs, io::Write};
use tauri::State;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    sources: Vec<String>,
    base_name: String,
    output_directory: Option<String>,
    format: arc_recall_core::CompressionFormat,
    level: u8,
    #[serde(default)]
    encrypt_file_names: bool,
    #[serde(default)]
    verify_after_compression: bool,
    #[serde(default)]
    volume_size_mib: Option<u32>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Entry {
    id: String,
    request: Request,
    password_required: bool,
    state: String,
    task_id: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Journal {
    version: u32,
    enabled: bool,
    items: Vec<Entry>,
}
fn validate(items: &[Entry]) -> Result<(), String> {
    if items.len() > 200 {
        return Err("压缩队列最多 200 项".into());
    }
    let mut ids = std::collections::HashSet::new();
    for item in items {
        if !ids.insert(&item.id)
            || !["waiting", "running", "success", "failed", "cancelled"]
                .contains(&item.state.as_str())
            || item.request.sources.is_empty()
            || item.request.sources.len() > 10000
            || item
                .request
                .sources
                .iter()
                .any(|p| !std::path::Path::new(p).is_absolute())
        {
            return Err("压缩队列项目无效".into());
        }
        arc_recall_core::sanitize_archive_base_name(&item.request.base_name)
            .map_err(|e| e.to_string())?;
        CompressionOptions {
            volume_size_mib: item.request.volume_size_mib,
            verify_after_compression: item.request.verify_after_compression,
            format: item.request.format,
            level: item.request.level,
            encrypt_file_names: item.request.encrypt_file_names,
            output_directory: item.request.output_directory.clone(),
        }
        .validate()?;
    }
    Ok(())
}
#[tauri::command]
pub(crate) fn compression_queue_load(state: State<'_, AppState>) -> Result<Journal, String> {
    let _guard = state.data_maintenance.lock().map_err(|e| e.to_string())?;
    let path = state.paths.root.join("compression-queue.json");
    if !path.exists() {
        return Ok(Journal {
            version: 1,
            enabled: false,
            items: vec![],
        });
    }
    if fs::metadata(&path).map_err(|e| e.to_string())?.len() > 4 * 1024 * 1024 {
        return Err("压缩队列记录过大".into());
    }
    let mut journal: Journal = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if journal.version != 1 {
        return Err("压缩队列版本无效".into());
    }
    validate(&journal.items)?;
    let records = arc_recall_core::task_records::TaskRecordStore::open(
        &state.paths.root.join("task-records.db"),
    )?;
    for item in &mut journal.items {
        if item.state == "running" {
            item.state = if let Some(id) = &item.task_id {
                records
                    .find(id)?
                    .filter(|r| r.state == "success")
                    .map(|_| "success")
                    .unwrap_or("cancelled")
            } else {
                "cancelled"
            }
            .into();
        }
        item.task_id = None;
        if item.state == "waiting"
            && (item
                .request
                .sources
                .iter()
                .any(|p| !std::path::Path::new(p).exists())
                || item
                    .request
                    .output_directory
                    .as_ref()
                    .is_some_and(|p| !std::path::Path::new(p).is_dir()))
        {
            item.state = "failed".into();
        }
    }
    Ok(journal)
}
#[tauri::command]
pub(crate) fn compression_queue_save(
    state: State<'_, AppState>,
    enabled: bool,
    items: Vec<Entry>,
) -> Result<(), String> {
    let _guard = state.data_maintenance.lock().map_err(|e| e.to_string())?;
    let path = state.paths.root.join("compression-queue.json");
    if !enabled {
        return match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        };
    }
    validate(&items)?;
    let bytes = serde_json::to_vec(&Journal {
        version: 1,
        enabled,
        items,
    })
    .map_err(|e| e.to_string())?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err("压缩队列记录过大".into());
    }
    let mut file = tempfile::NamedTempFile::new_in(&state.paths.root).map_err(|e| e.to_string())?;
    file.write_all(&bytes).map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}
