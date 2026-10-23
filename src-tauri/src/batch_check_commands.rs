use crate::AppState;
use arc_recall_core::{
    CancellationToken,
    tools::{ArchiveActionRequest, analyze_archive, path_for_display, run_archive_action},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
    time::Instant,
};
use tauri::State;

const MAX_ITEMS: usize = 200;
const PASSED_MESSAGE: &str = "完整性检查通过，当前归档所有条目均可读取；未展开检查嵌套归档。";
const FAILED_MESSAGE: &str = "检查未通过或未能完成：请检查密码、归档、所有分卷和访问权限后重试。";
const CANCELLED_MESSAGE: &str = "检查已取消，未产生完整性结论。";
const REPORT_SCOPE: &str =
    "结果仅代表 checkedAtMs 时的本次检查，未展开检查嵌套归档；不代表此后文件仍完整。";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum CheckState {
    Waiting,
    Checking,
    Passed,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchCheckItem {
    path: String,
    source_paths: Vec<String>,
    state: CheckState,
    message: String,
    elapsed_ms: u64,
    checked_at_ms: Option<u64>,
}

impl BatchCheckItem {
    fn waiting(path: String) -> Self {
        Self {
            source_paths: vec![path.clone()],
            path,
            state: CheckState::Waiting,
            message: "等待检查。".into(),
            elapsed_ms: 0,
            checked_at_ms: None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BatchCheckStatus {
    id: String,
    running: bool,
    cancelled: bool,
    items: Vec<BatchCheckItem>,
}

type SharedBatch = Arc<Mutex<Option<BatchCheckStatus>>>;

fn path_key(path: &Path) -> String {
    let text = path_for_display(path);
    if cfg!(windows) {
        text.replace('/', "\\").to_lowercase()
    } else {
        text
    }
}

fn validate_paths(paths: Vec<String>) -> Result<Vec<String>, String> {
    if paths.is_empty() || paths.len() > MAX_ITEMS {
        return Err("每批请选择 1–200 个归档。".into());
    }
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for path in paths {
        let path = Path::new(&path);
        if !path.is_absolute() || path.as_os_str().len() > 32_768 {
            return Err("归档路径必须是有效的绝对路径。".into());
        }
        // Missing files remain items so one unavailable archive cannot reject an entire batch.
        let mut clean = PathBuf::new();
        for component in path.components() {
            match component {
                Component::CurDir => {}
                Component::ParentDir => {
                    clean.pop();
                }
                other => clean.push(other.as_os_str()),
            }
        }
        if seen.insert(path_key(&clean)) {
            normalized.push(path_for_display(&clean));
        }
    }
    Ok(normalized)
}

fn prepare_batch(
    current: Option<&BatchCheckStatus>,
    id: String,
    paths: Vec<String>,
    retry_failed: bool,
) -> Result<BatchCheckStatus, String> {
    if id.is_empty() || id.len() > 128 || id.chars().any(char::is_control) {
        return Err("批次标识无效。".into());
    }
    if retry_failed {
        let previous = current
            .filter(|batch| batch.id == id && !batch.running)
            .ok_or("只能重查当前已结束批次的未通过项。")?;
        if previous
            .items
            .iter()
            .map(|item| &item.path)
            .ne(paths.iter())
        {
            return Err("批次归档列表已变化，请重新开始检查。".into());
        }
        if !previous
            .items
            .iter()
            .any(|item| item.state == CheckState::Failed)
        {
            return Err("当前批次没有需要重查的未通过项。".into());
        }
        let mut batch = previous.clone();
        batch.running = true;
        batch.cancelled = false;
        for item in &mut batch.items {
            if item.state == CheckState::Failed {
                item.state = CheckState::Waiting;
                item.message = "等待检查。".into();
                item.elapsed_ms = 0;
                item.checked_at_ms = None;
            }
        }
        return Ok(batch);
    }
    Ok(BatchCheckStatus {
        id,
        running: true,
        cancelled: false,
        items: validate_paths(paths)?
            .into_iter()
            .map(BatchCheckItem::waiting)
            .collect(),
    })
}

fn group_volume_paths(paths: &[String], cancellation: &CancellationToken) -> Vec<BatchCheckItem> {
    let mut aliases = HashMap::new();
    let canonical: Vec<_> = paths
        .iter()
        .map(|path| {
            Path::new(path)
                .canonicalize()
                .unwrap_or_else(|_| path.into())
        })
        .collect();
    for path in &canonical {
        if cancellation.is_cancelled() {
            break;
        }
        if aliases.contains_key(&path_key(path)) {
            continue;
        }
        if let Ok(analysis) = analyze_archive(path) {
            let primary = path_for_display(Path::new(&analysis.archive_path));
            aliases.insert(path_key(path), primary.clone());
            aliases.insert(path_key(Path::new(&primary)), primary.clone());
            for volume in analysis.volume_paths {
                aliases.insert(path_key(&volume), primary.clone());
            }
        }
    }
    // Build the alias map first: a later first-volume selection can identify an earlier
    // secondary-volume selection even if the secondary cannot be analyzed on its own.
    let mut groups = HashMap::new();
    let mut items: Vec<BatchCheckItem> = Vec::new();
    for (source, path) in paths.iter().zip(&canonical) {
        let primary = aliases
            .get(&path_key(path))
            .cloned()
            .unwrap_or_else(|| path_for_display(path));
        let index = *groups
            .entry(path_key(Path::new(&primary)))
            .or_insert_with(|| {
                let mut item = BatchCheckItem::waiting(primary);
                item.source_paths.clear();
                items.push(item);
                items.len() - 1
            });
        if !items[index].source_paths.contains(source) {
            items[index].source_paths.push(source.clone());
        }
    }
    items
}

fn snapshot(shared: &SharedBatch) -> Option<BatchCheckStatus> {
    shared.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

#[cfg(test)]
fn run_checks(
    shared: &SharedBatch,
    cancellation: &CancellationToken,
    check: impl FnMut(&str) -> Result<(), String>,
) -> BatchCheckStatus {
    run_checks_with_progress(shared, cancellation, check, |_| {})
}

fn run_checks_with_progress(
    shared: &SharedBatch,
    cancellation: &CancellationToken,
    mut check: impl FnMut(&str) -> Result<(), String>,
    mut progress: impl FnMut(&BatchCheckStatus),
) -> BatchCheckStatus {
    let count = snapshot(shared).expect("batch initialized").items.len();
    for index in 0..count {
        if cancellation.is_cancelled() {
            break;
        }
        let path = {
            let mut guard = shared.lock().unwrap_or_else(|e| e.into_inner());
            let item = &mut guard.as_mut().expect("batch initialized").items[index];
            if item.state != CheckState::Waiting {
                continue;
            }
            item.state = CheckState::Checking;
            item.message = "正在检查。".into();
            item.path.clone()
        };
        let start = Instant::now();
        let result = check(&path);
        let mut guard = shared.lock().unwrap_or_else(|e| e.into_inner());
        let item = &mut guard.as_mut().expect("batch initialized").items[index];
        item.elapsed_ms = start.elapsed().as_millis().min(u64::MAX as u128) as u64;
        // Never surface raw engine errors: they can contain the command or password.
        if result.is_ok() {
            item.state = CheckState::Passed;
            item.message = PASSED_MESSAGE.into();
            item.checked_at_ms = Some(crate::current_time_ms());
        } else if cancellation.is_cancelled() {
            item.state = CheckState::Cancelled;
            item.message = CANCELLED_MESSAGE.into();
        } else {
            item.state = CheckState::Failed;
            item.message = FAILED_MESSAGE.into();
            item.checked_at_ms = Some(crate::current_time_ms());
        }
        let updated = guard.as_ref().expect("batch initialized").clone();
        drop(guard);
        progress(&updated);
    }
    finish_batch(shared, cancellation.is_cancelled())
}

fn finish_batch(shared: &SharedBatch, cancelled: bool) -> BatchCheckStatus {
    let mut guard = shared.lock().unwrap_or_else(|e| e.into_inner());
    let batch = guard.as_mut().expect("batch initialized");
    for item in &mut batch.items {
        if matches!(item.state, CheckState::Waiting | CheckState::Checking) {
            item.state = if cancelled {
                CheckState::Cancelled
            } else {
                CheckState::Failed
            };
            item.message = if cancelled {
                CANCELLED_MESSAGE
            } else {
                FAILED_MESSAGE
            }
            .into();
        }
    }
    batch.running = false;
    batch.cancelled = cancelled
        || batch
            .items
            .iter()
            .any(|item| item.state == CheckState::Cancelled);
    batch.clone()
}

#[tauri::command]
pub(crate) async fn archive_batch_check_run(
    state: State<'_, AppState>,
    id: String,
    paths: Vec<String>,
    password: Option<String>,
    retry_failed: Option<bool>,
) -> Result<BatchCheckStatus, String> {
    let lease = state.lifecycle.begin()?;
    let _reservation = crate::task_coordination::TaskStartReservation::acquire(
        &state.archive_task_starting,
        "已有归档操作正在运行，请先等待完成或取消。",
    )?;
    crate::ensure_no_active_archive_task(&state)?;
    let retry_failed = retry_failed.unwrap_or(false);
    {
        let mut current = state.batch_check.lock().unwrap_or_else(|e| e.into_inner());
        *current = Some(prepare_batch(
            current.as_ref(),
            id.clone(),
            paths,
            retry_failed,
        )?);
    }
    let mut record = batch_record(&snapshot(&state.batch_check).expect("batch initialized"));
    let cancellation = lease.cancellation.clone();
    *state
        .archive_action
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some((id, cancellation.clone()));
    let initial_save = arc_recall_core::task_records::TaskRecordStore::open(
        &state.paths.root.join("task-records.db"),
    )
    .and_then(|store| store.save_for_session(&record, state.recovery_session.directory()));
    if let Err(error) = initial_save {
        finish_batch(&state.batch_check, false);
        *state
            .archive_action
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;
        return Err(error);
    }
    let shared = Arc::clone(&state.batch_check);
    let record_path = state.paths.root.join("task-records.db");
    let owner = state.recovery_session.directory().to_path_buf();
    let progress_id = record.task_id.clone();
    let progress_started = record.started_at_ms;
    let logger = Arc::clone(&state.logger);
    let result = async {
        if cancellation.is_cancelled() {
            return Ok(finish_batch(&shared, true));
        }
        let seven_zip = crate::engine_commands::require_seven_zip(&state).await;
        if cancellation.is_cancelled() {
            return Ok(finish_batch(&shared, true));
        }
        let seven_zip =
            seven_zip.map_err(|_| "无法准备 7-Zip 引擎，请检查引擎设置后重试。".to_string())?;
        let workspace = tempfile::Builder::new()
            .prefix("batch-check-")
            .tempdir_in(state.recovery_session.directory())
            .map_err(|_| "无法创建检查工作目录，请检查磁盘空间和访问权限。".to_string())?;
        tauri::async_runtime::spawn_blocking(move || {
            let _lease = lease;
            // The workspace must drop before the lease allows shutdown cleanup.
            let workspace = workspace;
            if !retry_failed {
                let paths = snapshot(&shared)
                    .expect("batch initialized")
                    .items
                    .into_iter()
                    .map(|item| item.path)
                    .collect::<Vec<_>>();
                let items = group_volume_paths(&paths, &_lease.cancellation);
                shared
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .as_mut()
                    .expect("batch initialized")
                    .items = items;
            }
            run_checks_with_progress(
                &shared,
                &_lease.cancellation,
                |path| {
                    // Separate workspaces prevent split-archive materialization collisions and
                    // release each archive's temporary files before the next archive starts.
                    let item_workspace = tempfile::Builder::new()
                        .prefix("archive-")
                        .tempdir_in(workspace.path())
                        .map_err(|_| "无法创建检查目录。".to_string())?;
                    let request = ArchiveActionRequest {
                        path: path.into(),
                        password: password.clone(),
                        selected_paths: None,
                        output_parent: None,
                    };
                    run_archive_action(
                        &request,
                        &seven_zip,
                        item_workspace.path(),
                        &_lease.cancellation,
                    )
                    .map(|_| ())
                },
                |batch| {
                    let mut record = batch_record(batch);
                    record.task_id = progress_id.clone();
                    record.started_at_ms = progress_started;
                    record.elapsed_ms = crate::current_time_ms().saturating_sub(progress_started);
                    if arc_recall_core::task_records::TaskRecordStore::open(&record_path)
                        .and_then(|store| store.save_for_session(&record, &owner))
                        .is_err()
                    {
                        crate::write_log(
                            &logger,
                            crate::logging::LogLevel::Error,
                            "archive",
                            "archive.record_failed",
                            "批量检查进度记录保存失败。",
                            std::iter::empty(),
                        );
                    }
                },
            )
        })
        .await
        .map_err(|_| "批量检查意外终止，请重试未通过项。".to_string())
    }
    .await;
    // Keep the archive reservation until the worker and its temporary files are gone.
    *state
        .archive_action
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = None;
    if result.is_err() {
        finish_batch(&state.batch_check, cancellation.is_cancelled());
    }
    let final_record = batch_record(&snapshot(&state.batch_check).expect("batch initialized"));
    record.state = final_record.state;
    record.check_items = final_record.check_items;
    record.source_paths = final_record.source_paths;
    record.elapsed_ms = crate::current_time_ms().saturating_sub(record.started_at_ms);
    arc_recall_core::task_records::TaskRecordStore::open(
        &state.paths.root.join("task-records.db"),
    )?
    .save(&record)
    .map_err(|_| "检查已结束，但任务记录保存失败，请检查磁盘空间。".to_string())?;
    result
}

fn batch_record(batch: &BatchCheckStatus) -> arc_recall_core::task_records::TaskRecord {
    use arc_recall_core::task_records::{TaskCheckItem, TaskOperation, TaskRecord};
    let started = crate::current_time_ms();
    TaskRecord {
        task_id: format!("batch-{}-{started}", batch.id),
        operation: TaskOperation::BatchIntegrityCheck,
        archive_path: batch
            .items
            .first()
            .map(|item| item.path.clone())
            .unwrap_or_default(),
        source_paths: batch.items.iter().map(|item| item.path.clone()).collect(),
        started_at_ms: started,
        state: if batch.running {
            "running"
        } else if batch.cancelled {
            "cancelled"
        } else if batch
            .items
            .iter()
            .all(|item| item.state == CheckState::Passed)
        {
            "success"
        } else if batch
            .items
            .iter()
            .any(|item| item.state == CheckState::Passed)
        {
            "partial"
        } else {
            "failed"
        }
        .into(),
        check_items: batch
            .items
            .iter()
            .map(|item| TaskCheckItem {
                path: item.path.clone(),
                state: match item.state {
                    CheckState::Waiting => "waiting",
                    CheckState::Checking => "checking",
                    CheckState::Passed => "passed",
                    CheckState::Failed => "failed",
                    CheckState::Cancelled => "cancelled",
                }
                .into(),
                elapsed_ms: item.elapsed_ms,
                checked_at_ms: item.checked_at_ms,
            })
            .collect(),
        ..Default::default()
    }
}

#[tauri::command]
pub(crate) fn archive_batch_check_status(
    state: State<'_, AppState>,
    id: String,
) -> Option<BatchCheckStatus> {
    snapshot(&state.batch_check).filter(|batch| batch.id == id)
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum BatchReportFormat {
    Json,
    Csv,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchReport<'a> {
    version: u32,
    id: &'a str,
    generated_at_ms: u64,
    cancelled: bool,
    scope: &'static str,
    items: Vec<ReportItem<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReportItem<'a> {
    index: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<&'a str>,
    state: CheckState,
    message: &'a str,
    elapsed_ms: u64,
    checked_at_ms: Option<u64>,
}

fn csv_cell(value: &str) -> String {
    let unsafe_start = value.trim_start().starts_with(['=', '+', '-', '@'])
        || value.starts_with(['\t', '\r', '\n']);
    format!(
        "\"{}{}\"",
        if unsafe_start { "'" } else { "" },
        value.replace('"', "\"\"")
    )
}

fn render_report(
    batch: &BatchCheckStatus,
    format: &BatchReportFormat,
    include_paths: bool,
) -> Result<String, String> {
    if batch.running {
        return Err("请等待批量检查结束后再导出报告。".into());
    }
    let report = BatchReport {
        version: 1,
        id: &batch.id,
        generated_at_ms: crate::current_time_ms(),
        cancelled: batch.cancelled,
        scope: REPORT_SCOPE,
        items: batch
            .items
            .iter()
            .enumerate()
            .map(|(index, item)| ReportItem {
                index: index + 1,
                path: include_paths.then_some(item.path.as_str()),
                state: item.state,
                message: &item.message,
                elapsed_ms: item.elapsed_ms,
                checked_at_ms: item.checked_at_ms,
            })
            .collect(),
    };
    match format {
        BatchReportFormat::Json => serde_json::to_string_pretty(&report).map_err(|e| e.to_string()),
        BatchReportFormat::Csv => {
            let mut rows = vec!["\u{feff}version,batchId,generatedAtMs,cancelled,index,state,message,elapsedMs,checkedAtMs,scope".to_string()];
            if include_paths {
                rows[0].push_str(",path");
            }
            for item in report.items {
                let state = serde_json::to_value(item.state).map_err(|e| e.to_string())?;
                let mut fields = vec![
                    "1".into(),
                    report.id.into(),
                    report.generated_at_ms.to_string(),
                    report.cancelled.to_string(),
                    item.index.to_string(),
                    state.as_str().unwrap_or_default().to_string(),
                    item.message.into(),
                    item.elapsed_ms.to_string(),
                    item.checked_at_ms
                        .map(|time| time.to_string())
                        .unwrap_or_default(),
                    report.scope.into(),
                ];
                if let Some(path) = item.path {
                    fields.push(path.into());
                }
                rows.push(
                    fields
                        .iter()
                        .map(|field| csv_cell(field))
                        .collect::<Vec<_>>()
                        .join(","),
                );
            }
            Ok(rows.join("\r\n") + "\r\n")
        }
    }
}

#[tauri::command]
pub(crate) async fn archive_batch_check_export(
    state: State<'_, AppState>,
    id: String,
    format: BatchReportFormat,
    include_paths: bool,
) -> Result<String, String> {
    let batch = snapshot(&state.batch_check)
        .filter(|batch| batch.id == id)
        .ok_or("批次结果已不存在，请重新检查。")?;
    let root = state.paths.exports.clone();
    let lease = state.lifecycle.begin()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _lease = lease;
        let content = render_report(&batch, &format, include_paths)?;
        if content.len() > 4 * 1024 * 1024 {
            return Err("报告过大。".into());
        }
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let suffix = match format {
            BatchReportFormat::Json => ".json",
            BatchReportFormat::Csv => ".csv",
        };
        let mut file = tempfile::Builder::new()
            .prefix("batch-check-report-")
            .suffix(suffix)
            .tempfile_in(root)
            .map_err(|e| e.to_string())?;
        file.write_all(content.as_bytes())
            .map_err(|e| e.to_string())?;
        file.as_file().sync_all().map_err(|e| e.to_string())?;
        let (_, path) = file.keep().map_err(|e| e.to_string())?;
        Ok(path_for_display(&path))
    })
    .await
    .map_err(|_| "报告导出意外终止。".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn batch(paths: &[&str]) -> SharedBatch {
        Arc::new(Mutex::new(Some(BatchCheckStatus {
            id: "batch-test".into(),
            running: true,
            cancelled: false,
            items: paths
                .iter()
                .map(|path| BatchCheckItem::waiting((*path).into()))
                .collect(),
        })))
    }

    #[test]
    fn invalid_batch_sizes_and_relative_paths_are_rejected_but_missing_files_are_retained() {
        assert!(validate_paths(vec![]).is_err());
        assert!(validate_paths(vec!["archive.zip".into()]).is_err());
        let root = tempfile::tempdir().unwrap();
        let path = path_for_display(&root.path().join("缺失归档.zip"));
        assert!(validate_paths(vec![path.clone(); 201]).is_err());
        assert_eq!(
            validate_paths(vec![path.clone(), path.clone()]).unwrap(),
            vec![path]
        );
    }

    #[test]
    fn volume_members_are_grouped_even_when_secondary_is_selected_first() {
        let root = tempfile::tempdir().unwrap();
        let first = root.path().join("[测试分组] 分卷归档.7z.001");
        let second = root.path().join("[测试分组] 分卷归档.7z.002");
        // A valid 7z start header pointing at an eight-byte next header in the second volume.
        fs::write(
            &first,
            hex::decode("377abcaf271c0004e7f3e38e0000000000000000080000000000000081ee5914")
                .unwrap(),
        )
        .unwrap();
        fs::write(&second, b"nexthead").unwrap();
        assert_eq!(analyze_archive(&first).unwrap().volume_count, 2);
        let missing = root.path().join("缺失归档.zip");
        let paths = [second, first.clone(), missing.clone(), first.clone()]
            .iter()
            .map(|path| path_for_display(path))
            .collect::<Vec<_>>();
        let grouped = group_volume_paths(&paths, &CancellationToken::default());
        assert_eq!(grouped.len(), 2);
        assert_eq!(grouped[0].path, path_for_display(&first));
        assert_eq!(grouped[0].source_paths, paths[..2]);
        assert_eq!(grouped[1].path, path_for_display(&missing));
        assert_eq!(grouped[1].source_paths, [path_for_display(&missing)]);
    }

    #[test]
    fn failures_continue_and_engine_errors_never_enter_status_or_reports() {
        let shared = batch(&["first.zip", "second.zip"]);
        let mut visited = Vec::new();
        let result = run_checks(&shared, &CancellationToken::default(), |path| {
            assert!(
                snapshot(&shared)
                    .unwrap()
                    .items
                    .iter()
                    .any(|item| item.path == path && item.state == CheckState::Checking)
            );
            visited.push(path.to_owned());
            if path == "first.zip" {
                Err("engine -pSECRET_MARKER".into())
            } else {
                Ok(())
            }
        });
        assert_eq!(visited, ["first.zip", "second.zip"]);
        assert_eq!(result.items[0].state, CheckState::Failed);
        assert_eq!(result.items[1].state, CheckState::Passed);
        assert!(result.items.iter().all(|item| item.checked_at_ms.is_some()));
        assert!(!result.running);
        assert!(
            !serde_json::to_string(&result)
                .unwrap()
                .contains("SECRET_MARKER")
        );
        for format in [BatchReportFormat::Json, BatchReportFormat::Csv] {
            assert!(
                !render_report(&result, &format, true)
                    .unwrap()
                    .contains("SECRET_MARKER")
            );
        }
    }

    #[test]
    fn setup_failure_finishes_all_items_without_claiming_a_check_timestamp() {
        let shared = batch(&["first.zip", "second.zip"]);
        let result = finish_batch(&shared, false);
        assert!(!result.running);
        assert!(
            result
                .items
                .iter()
                .all(|item| { item.state == CheckState::Failed && item.checked_at_ms.is_none() })
        );
    }

    #[test]
    fn cancellation_preserves_completed_results_and_marks_current_and_waiting_items() {
        let shared = batch(&["first.zip", "second.zip", "third.zip"]);
        let cancellation = CancellationToken::default();
        let result = run_checks(&shared, &cancellation, |path| {
            if path == "second.zip" {
                cancellation.cancel();
                Err("cancelled".into())
            } else {
                Ok(())
            }
        });
        assert_eq!(
            result
                .items
                .iter()
                .map(|item| item.state)
                .collect::<Vec<_>>(),
            vec![
                CheckState::Passed,
                CheckState::Cancelled,
                CheckState::Cancelled
            ]
        );
        assert!(result.cancelled);
        assert!(result.items[0].checked_at_ms.is_some());
        assert!(
            result.items[1..]
                .iter()
                .all(|item| item.checked_at_ms.is_none())
        );
        let shared = batch(&["first.zip"]);
        let result = run_checks(&shared, &cancellation, |_| {
            panic!("cancelled batch must not run")
        });
        assert_eq!(result.items[0].state, CheckState::Cancelled);
    }

    #[test]
    fn retry_only_checks_failed_items_and_preserves_prior_results() {
        let shared = batch(&["first.zip", "second.zip", "third.zip"]);
        shared.lock().unwrap().as_mut().unwrap().items[1]
            .source_paths
            .push("second.zip.002".into());
        let original = run_checks(&shared, &CancellationToken::default(), |path| {
            if path == "second.zip" {
                Err("failed".into())
            } else {
                Ok(())
            }
        });
        let paths = original
            .items
            .iter()
            .map(|item| item.path.clone())
            .collect();
        let retry = prepare_batch(Some(&original), original.id.clone(), paths, true).unwrap();
        assert_eq!(retry.items[0].state, CheckState::Passed);
        assert_eq!(retry.items[1].state, CheckState::Waiting);
        assert_eq!(retry.items[1].source_paths, original.items[1].source_paths);
        assert_eq!(retry.items[2].state, CheckState::Passed);
        *shared.lock().unwrap() = Some(retry);
        let mut visited = Vec::new();
        let result = run_checks(&shared, &CancellationToken::default(), |path| {
            visited.push(path.to_owned());
            Ok(())
        });
        assert_eq!(visited, ["second.zip"]);
        assert_eq!(
            result.items[0].checked_at_ms,
            original.items[0].checked_at_ms
        );
        assert_eq!(result.items.len(), 3);
        assert!(prepare_batch(Some(&original), "different-id".into(), vec![], true).is_err());
        assert!(prepare_batch(Some(&original), original.id.clone(), vec![], true).is_err());
        let paths = result.items.iter().map(|item| item.path.clone()).collect();
        assert!(prepare_batch(Some(&result), result.id.clone(), paths, true).is_err());
    }

    #[test]
    fn report_omits_paths_by_default_and_neutralizes_csv_formulas() {
        let shared = batch(&["=sensitive-path.zip", "中文,\"file\"\nnext.zip"]);
        assert!(
            render_report(&snapshot(&shared).unwrap(), &BatchReportFormat::Json, false).is_err()
        );
        let result = run_checks(&shared, &CancellationToken::default(), |_| Ok(()));
        let json = render_report(&result, &BatchReportFormat::Json, false).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["version"], 1);
        assert!(parsed["items"][0].get("path").is_none());
        assert!(parsed["items"][0].get("sourcePaths").is_none());
        assert!(!json.contains("sensitive-path"));
        let csv = render_report(&result, &BatchReportFormat::Csv, false).unwrap();
        assert!(!csv.contains("sensitive-path"));
        let csv = render_report(&result, &BatchReportFormat::Csv, true).unwrap();
        assert!(csv.contains("\"'=sensitive-path.zip\""));
        assert!(csv.contains("\"中文,\"\"file\"\"\nnext.zip\""));
        for formula in ["@SUM(A1)", "  +123", "\t=2", "-2"] {
            assert!(csv_cell(formula).starts_with("\"'"));
        }
    }
    #[test]
    fn completed_item_progress_survives_interruption_before_the_next_check() {
        let shared = Arc::new(Mutex::new(Some(BatchCheckStatus {
            id: "progress".into(),
            running: true,
            cancelled: false,
            items: vec![
                BatchCheckItem::waiting("first.zip".into()),
                BatchCheckItem::waiting("second.zip".into()),
            ],
        })));
        let token = CancellationToken::default();
        let temp = tempfile::tempdir().unwrap();
        let store =
            arc_recall_core::task_records::TaskRecordStore::open(&temp.path().join("records.db"))
                .unwrap();
        run_checks_with_progress(
            &shared,
            &token,
            |_| Ok(()),
            |batch| {
                let mut record = batch_record(batch);
                record.task_id = "progress-record".into();
                store.save(&record).unwrap();
                token.cancel();
            },
        );
        store.interrupt_running().unwrap();
        let record = store.list(0, false).unwrap().remove(0);
        assert_eq!(record.state, "interrupted");
        assert_eq!(record.check_items[0].state, "passed");
        assert!(record.check_items[0].checked_at_ms.is_some());
        assert_eq!(record.check_items[1].state, "interrupted");
    }
}
