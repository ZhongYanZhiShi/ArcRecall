use crate::{
    AppState,
    report_support::{ReportFormat, csv_cell, write_report},
};
use arc_recall_core::task_records::{TaskRecordQuery, TaskRecordStore};
use tauri::State;

#[tauri::command]
pub(crate) async fn task_records_search(
    state: State<'_, AppState>,
    query: TaskRecordQuery,
    skip: u32,
) -> Result<Vec<arc_recall_core::task_records::TaskRecord>, String> {
    let path = state.paths.root.join("task-records.db");
    tauri::async_runtime::spawn_blocking(move || {
        TaskRecordStore::open(&path)?.search(&query, skip, 100)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub(crate) async fn task_records_delete(
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> Result<usize, String> {
    delete_records(&state, ids).await
}

pub(crate) async fn delete_records(state: &AppState, ids: Vec<String>) -> Result<usize, String> {
    start_delete_records(
        state.paths.root.join("task-records.db"),
        state.data_maintenance.clone(),
        &state.lifecycle,
        ids,
    )?
    .await
    .map_err(|e| e.to_string())?
}

fn start_delete_records(
    path: std::path::PathBuf,
    maintenance: std::sync::Arc<std::sync::Mutex<()>>,
    lifecycle: &std::sync::Arc<crate::task_lifecycle::TaskLifecycle>,
    ids: Vec<String>,
) -> Result<tauri::async_runtime::JoinHandle<Result<usize, String>>, String> {
    let lease = lifecycle.begin()?;
    Ok(tauri::async_runtime::spawn_blocking(move || {
        let _lease = lease;
        let _guard = maintenance.lock().map_err(|e| e.to_string())?;
        TaskRecordStore::open(&path)?.delete_many(&ids)
    }))
}
fn render(
    mut records: Vec<arc_recall_core::task_records::TaskRecord>,
    format: &ReportFormat,
    include_paths: bool,
) -> Result<String, String> {
    if records.len() > 10_000 {
        return Err("结果超过 10000 条，请缩小日期或关键词范围后导出。".into());
    }
    if !include_paths {
        for record in &mut records {
            record.archive_path.clear();
            record.output_directory.clear();
            record.output_path = None;
            record.source_paths.clear();
            record.selected_paths.clear();
            record.pending_archive_paths.clear();
            record.skipped_scan_directories.clear();
            record.dictionary_group = None;
            if let Some(compression) = &mut record.compression {
                compression.options.output_directory = None;
                compression.base_name.clear();
            }
            for item in &mut record.check_items {
                item.path.clear();
            }
        }
    }
    match format {
        ReportFormat::Json => serde_json::to_string_pretty(
            &serde_json::json!({"version":1,"includesPaths":include_paths,"records":records}),
        )
        .map_err(|e| e.to_string()),
        ReportFormat::Csv => {
            let mut csv = String::from(
                "\u{feff}taskId,operation,state,startedAtMs,elapsedMs,failureKind,archivePath,outputDirectory,outputPath,sourcePaths,selectedPaths,pendingArchivePaths,skippedScanDirectories,checkItems,compression,compressionSucceeded,compressionVerification\r\n",
            );
            for record in records {
                let value = serde_json::to_value(record).map_err(|e| e.to_string())?;
                let cells: Vec<_> = [
                    "taskId",
                    "operation",
                    "state",
                    "startedAtMs",
                    "elapsedMs",
                    "failureKind",
                    "archivePath",
                    "outputDirectory",
                    "outputPath",
                    "sourcePaths",
                    "selectedPaths",
                    "pendingArchivePaths",
                    "skippedScanDirectories",
                    "checkItems",
                    "compression",
                    "compressionSucceeded",
                    "compressionVerification",
                ]
                .iter()
                .map(|key| {
                    let v = &value[key];
                    csv_cell(&if v.is_null() {
                        String::new()
                    } else {
                        v.as_str()
                            .map(str::to_owned)
                            .unwrap_or_else(|| v.to_string())
                    })
                })
                .collect();
                csv.push_str(&cells.join(","));
                csv.push_str("\r\n");
            }
            Ok(csv)
        }
    }
}
#[tauri::command]
pub(crate) async fn task_records_export(
    state: State<'_, AppState>,
    query: TaskRecordQuery,
    format: ReportFormat,
    include_paths: bool,
) -> Result<String, String> {
    let path = state.paths.root.join("task-records.db");
    let root = state.paths.exports.clone();
    let lease = state.lifecycle.begin()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _lease = lease;
        let records = TaskRecordStore::open(&path)?.search(&query, 0, 10_001)?;
        let content = render(records, &format, include_paths)?;
        if content.len() > 64 * 1024 * 1024 {
            return Err("报告超过 64 MiB，请缩小查询范围。".into());
        }
        let path = write_report(&root, "task-records-", &format, &content)?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    use arc_recall_core::task_records::{TaskCheckItem, TaskRecord};
    #[test]
    fn deletion_blocks_updates_and_shutdown_waits_even_if_caller_is_dropped() {
        use std::sync::{Arc, Mutex, mpsc};
        use std::time::Duration;
        for ids in [
            vec!["first".to_string()],
            vec!["first".to_string(), "second".to_string()],
        ] {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join("records.db");
            let store = TaskRecordStore::open(&path).unwrap();
            for id in &ids {
                store
                    .save(&TaskRecord {
                        task_id: id.clone(),
                        ..Default::default()
                    })
                    .unwrap();
            }
            let lifecycle = Arc::new(crate::task_lifecycle::TaskLifecycle::default());
            let maintenance = Arc::new(Mutex::new(()));
            let guard = maintenance.lock().unwrap();
            let worker = start_delete_records(path, maintenance.clone(), &lifecycle, ids).unwrap();
            assert!(lifecycle.reserve_update().is_err());
            drop(worker);
            lifecycle.request_shutdown();
            let (tx, rx) = mpsc::channel();
            let waiter = std::thread::spawn(move || {
                lifecycle.wait_until_finished();
                tx.send(()).unwrap();
            });
            assert!(rx.recv_timeout(Duration::from_millis(30)).is_err());
            drop(guard);
            rx.recv_timeout(Duration::from_secs(5)).unwrap();
            waiter.join().unwrap();
            assert!(store.all().unwrap().is_empty());
        }
    }
    #[test]
    fn exports_redact_all_path_fields_and_escape_csv_formulas() {
        let record = TaskRecord {
            compression: Some(
                arc_recall_core::compression_presets::CompressionRecordOptions {
                    options: arc_recall_core::compression_presets::CompressionOptions {
                        verify_after_compression: false,
                        format: arc_recall_core::CompressionFormat::SevenZip,
                        level: 5,
                        encrypt_file_names: false,
                        output_directory: Some("private-source".into()),
                    },
                    base_name: "private-source".into(),
                    password_required: true,
                },
            ),
            task_id: "=formula".into(),
            archive_path: "private-source".into(),
            source_paths: vec!["private-source".into()],
            check_items: vec![TaskCheckItem {
                path: "private-source".into(),
                state: "passed".into(),
                elapsed_ms: 1,
                checked_at_ms: Some(2),
            }],
            ..Default::default()
        };
        for format in [ReportFormat::Json, ReportFormat::Csv] {
            assert!(
                !render(vec![record.clone()], &format, false)
                    .unwrap()
                    .contains("private-source")
            );
            assert!(
                render(vec![record.clone()], &format, true)
                    .unwrap()
                    .contains("private-source")
            );
        }
        assert!(
            render(vec![record], &ReportFormat::Csv, false)
                .unwrap()
                .contains("\"'=formula\"")
        );
        assert!(
            render(
                vec![TaskRecord::default(); 10_001],
                &ReportFormat::Json,
                false
            )
            .is_err()
        );
    }
}
