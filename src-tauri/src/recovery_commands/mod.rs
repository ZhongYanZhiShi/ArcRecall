mod task;

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use arc_recall_core::{
    ArchiveAnalysis, CancellationToken, DEFAULT_RECURSIVE_MAX_ARCHIVES,
    DEFAULT_RECURSIVE_MAX_DEPTH, DictionaryCandidateStore, RecoveryComputeDevice,
    RecoveryComputeMode, RecoveryDictionary, RecoveryError, RecoveryHistoryStore, RecoveryJob,
    RecoveryPhase, RecursiveRecoveryOptions, analyze_archive,
    fingerprint_archive_sha256_with_cancellation, path_for_display,
    recover_and_extract_recursive_lazy,
};
use serde::Deserialize;
use tauri::State;

use crate::LogLevel;
use crate::engine_commands::{full_bundle_manager, recovery_tool_paths};
use crate::history_support::{history_password_by_fingerprint, save_recovered_history};
use crate::task_coordination::TaskStartReservation;
use crate::{AppState, current_time_ms, ensure_no_active_archive_task, write_log};
use task::{
    RecoveryTaskCompletionGuard, RecoveryTaskEvent, append_current_recovery_event,
    append_recovery_update_event, catch_recovery_panic, recovery_failure_kind,
    update_recovery_preparation,
};

pub(crate) use task::{RecoveryTaskHandle, RecoveryTaskStatus};

static RECOVERY_TASK_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecoveryStartRequest {
    archive_path: String,
    output_directory: Option<String>,
    known_password: Option<String>,
    #[serde(default)]
    avoid_output_collision: bool,
    #[serde(default = "default_recursive_recovery")]
    recursive: bool,
    #[serde(default)]
    compute_mode: RecoveryComputeMode,
}

fn default_recursive_recovery() -> bool {
    true
}

#[tauri::command]
pub(crate) async fn archive_analyze(
    state: State<'_, AppState>,
    path: String,
) -> Result<ArchiveAnalysis, String> {
    let result = tauri::async_runtime::spawn_blocking(move || {
        analyze_archive(path).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())
    .and_then(|result| result);
    match &result {
        Ok(analysis) => write_log(
            &state.logger,
            LogLevel::Debug,
            "recovery",
            "archive.analyzed",
            "归档分析已完成。",
            [("format".into(), analysis.format_label.clone())],
        ),
        Err(_) => write_log(
            &state.logger,
            LogLevel::Warn,
            "recovery",
            "archive.analysis_failed",
            "归档分析失败。",
            std::iter::empty(),
        ),
    }
    result
}

#[tauri::command]
pub(crate) async fn recovery_start(
    state: State<'_, AppState>,
    request: RecoveryStartRequest,
) -> Result<RecoveryTaskStatus, String> {
    let start_reservation = TaskStartReservation::acquire(
        &state.archive_task_starting,
        "另一个归档任务正在启动，请勿重复提交。",
    )?;
    write_log(
        &state.logger,
        LogLevel::Debug,
        "recovery",
        "recovery.requested",
        "收到恢复任务请求。",
        [(
            "mode".into(),
            if request.known_password.is_some() {
                "known".into()
            } else {
                "dictionary".into()
            },
        )],
    );
    ensure_no_active_archive_task(&state)?;

    let archive_path = std::fs::canonicalize(PathBuf::from(&request.archive_path))
        .map_err(|error| format!("无法解析归档路径：{error}"))?;
    let analysis = analyze_archive(&archive_path).map_err(|error| error.to_string())?;
    let manual_password = request
        .known_password
        .as_deref()
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let mut output_directory = request
        .output_directory
        .as_deref()
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(&analysis.suggested_output_directory));
    if !output_directory.is_absolute() {
        return Err("输出目录必须使用绝对路径。".into());
    }
    if request.avoid_output_collision {
        output_directory = resolve_available_output_directory(&output_directory);
    }
    if output_directory.is_file() {
        return Err("输出位置已存在且不是目录。".into());
    }

    let manager = full_bundle_manager(&state)?;
    let bundle_status = manager.status();
    // Empty / known-password paths only need 7-Zip. Dictionary recovery validates
    // Hashcat / John / *2john later inside recover_and_extract.
    if !bundle_status.seven_zip.runnable {
        if bundle_status.bundled {
            return Err(
                "7-Zip 尚未部署，请先在“设置 → 解密引擎”中安装完整包（至少部署 7-Zip）。".into(),
            );
        }
        return Err("当前构建未提供 7-Zip 资源，请使用完整发行构建并安装引擎包。".into());
    }
    let tools = recovery_tool_paths(&state)?;

    let task_id = next_recovery_task_id();
    let work_directory = state.paths.temp.join("recovery").join(&task_id);
    let dictionary_path = work_directory.join("dictionary.txt");
    let started_at_ms = current_time_ms();
    let initial_message = if manual_password.is_some() {
        "恢复任务已启动，正在优先检查免密与手动密码。"
    } else {
        "恢复任务已启动，正在后台计算完整指纹并查找历史密码。"
    }
    .to_owned();
    let initial_events = VecDeque::from([RecoveryTaskEvent {
        sequence: 1,
        elapsed_ms: 0,
        phase: RecoveryPhase::Preparing,
        engine: None,
        message: initial_message.clone(),
        archive_path: Some(analysis.archive_path.clone()),
        recursive_depth: 0,
        attempted_count: None,
        total_count: None,
        scanned_file_count: None,
    }]);

    let status = Arc::new(Mutex::new(RecoveryTaskStatus {
        task_id: task_id.clone(),
        phase: RecoveryPhase::Preparing,
        running: true,
        completed: false,
        success: false,
        cancelled: false,
        failure_kind: None,
        failure_phase: None,
        gpu_started: false,
        archive_path: analysis.archive_path.clone(),
        archive_format: analysis.format,
        archive_format_label: analysis.format_label.clone(),
        engine: None,
        message: initial_message,
        candidate_count: 0,
        attempted_count: 0,
        started_at_ms,
        elapsed_ms: 0,
        recovered_password: None,
        output_directory: path_for_display(&output_directory),
        compute_mode: request.compute_mode,
        recursive_enabled: request.recursive,
        recursive_depth: 0,
        current_archive_path: Some(analysis.archive_path.clone()),
        nested_archive_count: 0,
        extracted_nested_archive_count: 0,
        skipped_nested_archive_count: 0,
        scanned_file_count: 0,
        root_extraction_completed: false,
        depth_limit_reached: false,
        count_limit_reached: false,
        events: initial_events,
    }));
    let cancellation = CancellationToken::default();
    {
        let mut current = state
            .recovery_task
            .lock()
            .map_err(|error| error.to_string())?;
        *current = Some(RecoveryTaskHandle {
            id: task_id,
            cancellation: cancellation.clone(),
            status: Arc::clone(&status),
        });
    }

    let initial = status.lock().map_err(|error| error.to_string())?.clone();
    write_log(
        &state.logger,
        LogLevel::Info,
        "recovery",
        "recovery.started",
        "恢复任务已启动。",
        [
            ("task_id".into(), initial.task_id.clone()),
            (
                "archive_format".into(),
                initial.archive_format_label.clone(),
            ),
            (
                "candidate_count".into(),
                initial.candidate_count.to_string(),
            ),
        ],
    );
    let job = RecoveryJob {
        archive_path,
        output_directory,
        dictionary_path: dictionary_path.clone(),
        dictionary_count: 0,
        known_password: manual_password,
        work_directory: work_directory.clone(),
    };
    let status_for_worker = Arc::clone(&status);
    let status_for_history = Arc::clone(&status);
    let status_for_updates = Arc::clone(&status);
    let status_for_dictionary = Arc::clone(&status);
    let dictionary_database_path = state.paths.database.clone();
    let dictionary_cancellation = cancellation.clone();
    let history_database_path = state.paths.database.clone();
    let success_database_path = state.paths.database.clone();
    let analysis_for_history = analysis.clone();
    let logger_for_worker = Arc::clone(&state.logger);
    let logger_for_updates = Arc::clone(&state.logger);
    let worker_task_id = initial.task_id.clone();
    let update_task_id = initial.task_id.clone();
    std::thread::spawn(move || {
        let mut job = job;
        let mut precomputed_fingerprint_sha256 = None;
        let mut completion_guard =
            RecoveryTaskCompletionGuard::new(Arc::clone(&status_for_worker), work_directory);
        let mut last_logged_phase = None;
        let outcome = catch_recovery_panic(|| {
            if job.known_password.is_none() {
                update_recovery_preparation(
                    &status_for_history,
                    "正在后台计算完整归档指纹并查找本机历史密码。",
                );
                let (preferred_password, fingerprint_sha256) = resolve_preferred_recovery_password(
                    None,
                    &analysis_for_history,
                    &history_database_path,
                    &cancellation,
                )?;
                job.known_password = preferred_password;
                precomputed_fingerprint_sha256 = fingerprint_sha256;
                update_recovery_preparation(
                    &status_for_history,
                    if job.known_password.is_some() {
                        "已命中本机历史密码，正在优先复验。"
                    } else {
                        "未命中可复用的历史密码，正在检查归档。"
                    },
                );
            }
            recover_and_extract_recursive_lazy(
                &job,
                &tools,
                &cancellation,
                RecursiveRecoveryOptions {
                    enabled: initial.recursive_enabled,
                    max_depth: DEFAULT_RECURSIVE_MAX_DEPTH,
                    max_nested_archives: DEFAULT_RECURSIVE_MAX_ARCHIVES,
                    compute_mode: initial.compute_mode,
                },
                precomputed_fingerprint_sha256,
                move || {
                    if dictionary_cancellation.is_cancelled() {
                        return Err(RecoveryError::Cancelled);
                    }
                    let store = DictionaryCandidateStore::open(dictionary_database_path).map_err(
                        |error| RecoveryError::Message(format!("打开全局字典失败：{error}")),
                    )?;
                    let candidate_count =
                        store.export_wordlist(&dictionary_path).map_err(|error| {
                            RecoveryError::Message(format!("准备恢复字典失败：{error}"))
                        })?;
                    if let Ok(mut task_status) = status_for_dictionary.lock() {
                        task_status.candidate_count = candidate_count;
                    }
                    Ok(RecoveryDictionary {
                        path: dictionary_path,
                        candidate_count,
                    })
                },
                |update| {
                    let event_update = update.clone();
                    if last_logged_phase != Some(update.phase) {
                        write_log(
                            &logger_for_updates,
                            LogLevel::Debug,
                            "recovery",
                            "recovery.phase_changed",
                            "恢复任务阶段已切换。",
                            [
                                ("task_id".into(), update_task_id.clone()),
                                ("phase".into(), format!("{:?}", update.phase).to_lowercase()),
                                ("engine".into(), update.engine.clone().unwrap_or_default()),
                            ],
                        );
                        last_logged_phase = Some(update.phase);
                    }
                    if let Ok(mut task_status) = status_for_updates.lock() {
                        if update.compute_device == Some(RecoveryComputeDevice::Gpu) {
                            task_status.gpu_started = true;
                        }
                        task_status.phase = update.phase;
                        task_status.engine = update.engine;
                        task_status.message = update.message;
                        if let Some(attempted_count) = update.attempted_count {
                            task_status.attempted_count = attempted_count;
                        }
                        if let Some(total_count) = update.total_count {
                            task_status.candidate_count = total_count;
                        }
                        if let Some(recursive_depth) = update.recursive_depth {
                            task_status.recursive_depth = recursive_depth;
                        }
                        if let Some(current_archive_path) = update.current_archive_path {
                            task_status.current_archive_path = Some(current_archive_path);
                        }
                        if let Some(nested_archive_count) = update.nested_archive_count {
                            task_status.nested_archive_count = nested_archive_count;
                        }
                        if let Some(extracted_count) = update.extracted_nested_archive_count {
                            task_status.extracted_nested_archive_count = extracted_count;
                        }
                        if let Some(skipped_count) = update.skipped_nested_archive_count {
                            task_status.skipped_nested_archive_count = skipped_count;
                        }
                        if let Some(scanned_file_count) = update.scanned_file_count {
                            task_status.scanned_file_count = scanned_file_count;
                        }
                        if let Some(root_extraction_completed) = update.root_extraction_completed {
                            task_status.root_extraction_completed = root_extraction_completed;
                        }
                        append_recovery_update_event(&mut task_status, &event_update);
                    }
                },
            )
        });
        let mut task_status = match status_for_worker.lock() {
            Ok(status) => status,
            Err(poisoned) => poisoned.into_inner(),
        };
        {
            task_status.running = false;
            task_status.completed = true;
            task_status.elapsed_ms = current_time_ms().saturating_sub(task_status.started_at_ms);
            match outcome {
                Ok(result) => {
                    let history_save = if result.root.success {
                        save_recovered_history(
                            &success_database_path,
                            &result.recovered_archives,
                            current_time_ms(),
                        )
                    } else {
                        Default::default()
                    };
                    let dictionary_update_failed_count = if result.root.success {
                        match DictionaryCandidateStore::open(&success_database_path) {
                            Ok(store) => result
                                .recovered_passwords
                                .iter()
                                .filter(|password| store.increment_success(password).is_err())
                                .count(),
                            Err(_) => result.recovered_passwords.len(),
                        }
                    } else {
                        0
                    };
                    task_status.success = result.root.success;
                    task_status.cancelled = result.root.cancelled;
                    task_status.phase = if result.root.cancelled {
                        RecoveryPhase::Cancelled
                    } else if result.root.success {
                        RecoveryPhase::Completed
                    } else {
                        RecoveryPhase::Exhausted
                    };
                    task_status.engine = result.root.engine.clone();
                    task_status.message = result.root.message;
                    if history_save.failed_count > 0 {
                        task_status.message.push_str(&format!(
                            " 注意：有 {} 条恢复历史未能安全保存。",
                            history_save.failed_count
                        ));
                    }
                    if dictionary_update_failed_count > 0 {
                        task_status.message.push_str(&format!(
                            " 注意：有 {dictionary_update_failed_count} 条候选的成功次数未能更新。"
                        ));
                    }
                    task_status.recovered_password = result
                        .root
                        .password
                        .clone()
                        .or_else(|| result.recovered_passwords.first().cloned());
                    task_status.output_directory = path_for_display(&result.root.output_directory);
                    task_status.nested_archive_count = result.discovered_nested_archives;
                    task_status.extracted_nested_archive_count = result.extracted_nested_archives;
                    task_status.skipped_nested_archive_count = result.skipped_nested_archives;
                    task_status.scanned_file_count = result.scanned_files;
                    task_status.root_extraction_completed = result.root.success;
                    task_status.depth_limit_reached = result.depth_limit_reached;
                    task_status.count_limit_reached = result.count_limit_reached;
                    task_status.current_archive_path = None;
                    task_status.recursive_depth = 0;
                    append_current_recovery_event(&mut task_status);
                    write_log(
                        &logger_for_worker,
                        if result.root.success || result.root.cancelled {
                            LogLevel::Info
                        } else {
                            LogLevel::Warn
                        },
                        "recovery",
                        if result.root.success {
                            "recovery.completed"
                        } else if result.root.cancelled {
                            "recovery.cancelled"
                        } else {
                            "recovery.unsuccessful"
                        },
                        if result.root.success {
                            "恢复任务已完成。"
                        } else if result.root.cancelled {
                            "恢复任务已取消。"
                        } else {
                            "恢复任务已结束，但当前候选未找到可用密码。"
                        },
                        [
                            ("task_id".into(), worker_task_id.clone()),
                            (
                                "engine".into(),
                                result.root.engine.clone().unwrap_or_default(),
                            ),
                            (
                                "nested_extracted".into(),
                                result.extracted_nested_archives.to_string(),
                            ),
                            (
                                "nested_skipped".into(),
                                result.skipped_nested_archives.to_string(),
                            ),
                            ("history_saved".into(), history_save.saved_count.to_string()),
                            (
                                "history_save_failed".into(),
                                history_save.failed_count.to_string(),
                            ),
                            (
                                "dictionary_update_failed".into(),
                                dictionary_update_failed_count.to_string(),
                            ),
                        ],
                    );
                    if history_save.failed_count > 0 {
                        write_log(
                            &logger_for_worker,
                            LogLevel::Error,
                            "history",
                            "history.save_failed",
                            "恢复成功，但部分历史记录未能安全保存。",
                            [
                                ("task_id".into(), worker_task_id.clone()),
                                ("failed_count".into(), history_save.failed_count.to_string()),
                            ],
                        );
                    }
                    if dictionary_update_failed_count > 0 {
                        write_log(
                            &logger_for_worker,
                            LogLevel::Warn,
                            "dictionary",
                            "dictionary.success_count_update_failed",
                            "恢复成功，但部分候选的成功次数未能更新。",
                            [
                                ("task_id".into(), worker_task_id.clone()),
                                (
                                    "failed_count".into(),
                                    dictionary_update_failed_count.to_string(),
                                ),
                            ],
                        );
                    }
                }
                Err(RecoveryError::Cancelled) => {
                    task_status.cancelled = true;
                    task_status.phase = RecoveryPhase::Cancelled;
                    task_status.message = "密码恢复任务已取消。".into();
                    append_current_recovery_event(&mut task_status);
                    write_log(
                        &logger_for_worker,
                        LogLevel::Info,
                        "recovery",
                        "recovery.cancelled",
                        "恢复任务已取消。",
                        [("task_id".into(), worker_task_id.clone())],
                    );
                }
                Err(error) => {
                    task_status.failure_kind = Some(recovery_failure_kind(&error));
                    task_status.failure_phase = Some(task_status.phase);
                    task_status.phase = RecoveryPhase::Failed;
                    task_status.message = error.to_string();
                    append_current_recovery_event(&mut task_status);
                    write_log(
                        &logger_for_worker,
                        LogLevel::Error,
                        "recovery",
                        "recovery.failed",
                        "恢复任务执行失败。",
                        [("task_id".into(), worker_task_id.clone())],
                    );
                }
            }
        }
        drop(task_status);
        completion_guard.mark_finalized();
    });

    start_reservation.release();

    Ok(initial)
}

#[tauri::command]
pub(crate) fn recovery_status(
    state: State<'_, AppState>,
    task_id: Option<String>,
) -> Result<Option<RecoveryTaskStatus>, String> {
    let current = state
        .recovery_task
        .lock()
        .map_err(|error| error.to_string())?;
    let Some(task) = current.as_ref() else {
        return Ok(None);
    };
    if task_id.as_deref().is_some_and(|id| id != task.id) {
        return Ok(None);
    }
    let mut status = task
        .status
        .lock()
        .map_err(|error| error.to_string())?
        .clone();
    if status.running {
        status.elapsed_ms = current_time_ms().saturating_sub(status.started_at_ms);
    }
    Ok(Some(status))
}

#[tauri::command]
pub(crate) fn recovery_cancel(state: State<'_, AppState>, task_id: String) -> Result<bool, String> {
    let current = state
        .recovery_task
        .lock()
        .map_err(|error| error.to_string())?;
    let Some(task) = current.as_ref().filter(|task| task.id == task_id) else {
        return Ok(false);
    };
    let status = task.status.lock().map_err(|error| error.to_string())?;
    if !status.running {
        return Ok(false);
    }
    drop(status);
    task.cancellation.cancel();
    if let Ok(mut status) = task.status.lock() {
        status.message = "正在停止外部引擎…".into();
    }
    write_log(
        &state.logger,
        LogLevel::Info,
        "recovery",
        "recovery.cancel_requested",
        "已请求停止恢复任务。",
        [("task_id".into(), task_id)],
    );
    Ok(true)
}

fn resolve_preferred_recovery_password(
    manual_password: Option<String>,
    analysis: &ArchiveAnalysis,
    database_path: &Path,
    cancellation: &CancellationToken,
) -> Result<(Option<String>, Option<String>), RecoveryError> {
    if manual_password.is_some() {
        return Ok((manual_password, None));
    }
    let fingerprint = fingerprint_archive_sha256_with_cancellation(analysis, cancellation)?;
    let store = RecoveryHistoryStore::open(database_path)
        .map_err(|error| RecoveryError::Message(format!("打开恢复历史失败：{error}")))?;
    let password = history_password_by_fingerprint(&store, &fingerprint)
        .map_err(|error| RecoveryError::Message(format!("读取恢复历史失败：{error}")))?;
    Ok((password, Some(fingerprint)))
}

fn resolve_available_output_directory(preferred: &Path) -> PathBuf {
    if !preferred.exists() {
        return preferred.to_path_buf();
    }

    let Some(parent) = preferred.parent() else {
        return preferred.join(format!("ArcRecall 输出-{}", current_time_ms()));
    };
    let base_name = preferred
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("ArcRecall 输出");
    for suffix in 2..=9_999 {
        let candidate = parent.join(format!("{base_name} ({suffix})"));
        if !candidate.exists() {
            return candidate;
        }
    }
    parent.join(format!("{base_name}-{}", current_time_ms()))
}

fn next_recovery_task_id() -> String {
    let timestamp = current_time_ms();
    let sequence = RECOVERY_TASK_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("recovery-{timestamp}-{sequence}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use arc_recall_core::{ArchiveFormat, RecoveredArchive};

    #[test]
    fn output_collision_uses_next_available_sibling_directory() {
        let directory = tempfile::tempdir().expect("tempdir");
        let preferred = directory.path().join("archive");
        let second = directory.path().join("archive (2)");
        std::fs::create_dir_all(&preferred).expect("preferred");
        std::fs::create_dir_all(&second).expect("second");

        assert_eq!(
            resolve_available_output_directory(&preferred),
            directory.path().join("archive (3)")
        );
    }

    #[test]
    fn output_without_collision_keeps_preferred_directory() {
        let directory = tempfile::tempdir().expect("tempdir");
        let preferred = directory.path().join("archive");

        assert_eq!(resolve_available_output_directory(&preferred), preferred);
    }

    #[cfg(windows)]
    #[test]
    fn multi_volume_history_password_is_reused_by_full_fingerprint() {
        let directory = tempfile::tempdir().unwrap();
        let first = directory.path().join("archive.7z.001");
        let second = directory.path().join("archive.7z.002");
        std::fs::write(&first, b"first-volume").unwrap();
        std::fs::write(&second, b"second-volume").unwrap();
        let analysis = ArchiveAnalysis {
            archive_path: path_for_display(&first),
            file_name: "archive.7z.001".into(),
            format: ArchiveFormat::SevenZip,
            format_label: "7z".into(),
            file_size: 25,
            volume_count: 2,
            volume_paths: vec![first, second],
            suggested_output_directory: path_for_display(&directory.path().join("archive")),
        };
        let fingerprint = arc_recall_core::fingerprint_archive_sha256(&analysis).unwrap();
        let database = directory.path().join("history.db");
        let report = save_recovered_history(
            &database,
            &[RecoveredArchive {
                fingerprint_sha256: fingerprint.clone(),
                archive_format: ArchiveFormat::SevenZip,
                file_size: analysis.file_size,
                volume_count: analysis.volume_count,
                password: Some("remembered-password".into()),
            }],
            current_time_ms(),
        );
        assert_eq!(report.saved_count, 1);

        let (resolved, resolved_fingerprint) = resolve_preferred_recovery_password(
            None,
            &analysis,
            &database,
            &CancellationToken::default(),
        )
        .unwrap();

        assert_eq!(resolved.as_deref(), Some("remembered-password"));
        assert_eq!(resolved_fingerprint.as_deref(), Some(fingerprint.as_str()));
    }
}
