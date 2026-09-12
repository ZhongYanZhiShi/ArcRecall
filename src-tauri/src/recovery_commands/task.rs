use std::collections::VecDeque;
use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use arc_recall_core::{
    ArchiveFormat, CancellationToken, RecoveryComputeMode, RecoveryError, RecoveryPhase,
    RecoveryUpdate, path_for_display,
};
use serde::Serialize;

use crate::{current_time_ms, panic_payload_message};

const RECOVERY_EVENT_LIMIT: usize = 80;

pub(crate) struct RecoveryTaskHandle {
    pub(super) id: String,
    pub(super) cancellation: CancellationToken,
    pub(super) status: Arc<Mutex<RecoveryTaskStatus>>,
}

impl RecoveryTaskHandle {
    pub(crate) fn is_running(&self) -> Result<bool, String> {
        self.status
            .lock()
            .map(|status| status.running)
            .map_err(|error| error.to_string())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RecoveryTaskEvent {
    pub(super) sequence: u64,
    pub(super) elapsed_ms: u64,
    pub(super) phase: RecoveryPhase,
    pub(super) engine: Option<String>,
    pub(super) message: String,
    pub(super) archive_path: Option<String>,
    pub(super) recursive_depth: u32,
    pub(super) attempted_count: Option<u64>,
    pub(super) total_count: Option<u64>,
    pub(super) scanned_file_count: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum RecoveryFailureKind {
    InvalidArchive,
    UnsupportedFormat,
    MissingTool,
    NotFound,
    Io,
    Process,
    Other,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecoveryTaskStatus {
    pub(super) task_id: String,
    pub(super) phase: RecoveryPhase,
    pub(super) running: bool,
    pub(super) completed: bool,
    pub(super) success: bool,
    pub(super) cancelled: bool,
    pub(super) failure_kind: Option<RecoveryFailureKind>,
    pub(super) failure_phase: Option<RecoveryPhase>,
    pub(super) gpu_started: bool,
    pub(super) hashcat_progress: Option<arc_recall_core::HashcatProgress>,
    pub(super) archive_path: String,
    pub(super) archive_format: ArchiveFormat,
    pub(super) archive_format_label: String,
    pub(super) engine: Option<String>,
    pub(super) message: String,
    pub(super) candidate_count: u64,
    pub(super) attempted_count: u64,
    pub(super) started_at_ms: u64,
    pub(super) elapsed_ms: u64,
    pub(super) recovered_password: Option<String>,
    pub(super) output_directory: String,
    pub(super) compute_mode: RecoveryComputeMode,
    pub(super) recursive_enabled: bool,
    pub(super) recursive_depth: u32,
    pub(super) current_archive_path: Option<String>,
    pub(super) nested_archive_count: u32,
    pub(super) extracted_nested_archive_count: u32,
    pub(super) skipped_nested_archive_count: u32,
    pub(super) scanned_file_count: u64,
    pub(super) root_extraction_completed: bool,
    pub(super) depth_limit_reached: bool,
    pub(super) count_limit_reached: bool,
    pub(super) events: VecDeque<RecoveryTaskEvent>,
}

pub(super) struct RecoveryTaskCompletionGuard {
    status: Arc<Mutex<RecoveryTaskStatus>>,
    work_directory: PathBuf,
    finalized: bool,
}

impl RecoveryTaskCompletionGuard {
    pub(super) fn new(status: Arc<Mutex<RecoveryTaskStatus>>, work_directory: PathBuf) -> Self {
        Self {
            status,
            work_directory,
            finalized: false,
        }
    }

    pub(super) fn mark_finalized(&mut self) {
        self.finalized = true;
    }
}

impl Drop for RecoveryTaskCompletionGuard {
    fn drop(&mut self) {
        if !self.finalized {
            let mut status = match self.status.lock() {
                Ok(status) => status,
                Err(poisoned) => poisoned.into_inner(),
            };
            if status.running {
                status.failure_kind = Some(RecoveryFailureKind::Other);
                status.failure_phase = Some(status.phase);
                status.running = false;
                status.completed = true;
                status.success = false;
                status.phase = RecoveryPhase::Failed;
                status.message = "后台恢复任务异常终止，已自动停止并清理临时文件。".into();
                status.elapsed_ms = current_time_ms().saturating_sub(status.started_at_ms);
            }
        }
        let _ = std::fs::remove_dir_all(&self.work_directory);
    }
}

pub(super) fn append_recovery_update_event(
    status: &mut RecoveryTaskStatus,
    update: &RecoveryUpdate,
) {
    let archive_path = update
        .current_archive_path
        .as_deref()
        .or(status.current_archive_path.as_deref())
        .map(|path| path_for_display(Path::new(path)));
    push_recovery_event(
        status,
        update.phase,
        update.engine.clone(),
        update.message.clone(),
        archive_path,
        update.recursive_depth.unwrap_or(status.recursive_depth),
        update.attempted_count,
        update.total_count,
        update.scanned_file_count,
    );
}

pub(super) fn append_current_recovery_event(status: &mut RecoveryTaskStatus) {
    let phase = status.phase;
    let engine = status.engine.clone();
    let message = status.message.clone();
    let archive_path = status.current_archive_path.clone();
    let recursive_depth = status.recursive_depth;
    let attempted_count = (status.attempted_count > 0).then_some(status.attempted_count);
    let total_count = (status.candidate_count > 0).then_some(status.candidate_count);
    let scanned_file_count = (status.scanned_file_count > 0).then_some(status.scanned_file_count);
    push_recovery_event(
        status,
        phase,
        engine,
        message,
        archive_path,
        recursive_depth,
        attempted_count,
        total_count,
        scanned_file_count,
    );
}

#[allow(clippy::too_many_arguments)]
fn push_recovery_event(
    status: &mut RecoveryTaskStatus,
    phase: RecoveryPhase,
    engine: Option<String>,
    message: String,
    archive_path: Option<String>,
    recursive_depth: u32,
    attempted_count: Option<u64>,
    total_count: Option<u64>,
    scanned_file_count: Option<u64>,
) {
    if let Some(latest) = status.events.front()
        && latest.phase == phase
        && latest.engine == engine
        && latest.archive_path == archive_path
        && latest.recursive_depth == recursive_depth
    {
        if let (Some(attempted), Some(total), Some(previous_attempted), Some(previous_total)) = (
            attempted_count,
            total_count,
            latest.attempted_count,
            latest.total_count,
        ) {
            let bucket = recovery_progress_bucket(attempted, total);
            let previous_bucket = recovery_progress_bucket(previous_attempted, previous_total);
            if bucket == previous_bucket && attempted < total {
                return;
            }
        } else if latest.message == message && latest.scanned_file_count == scanned_file_count {
            return;
        }
    }

    let sequence = status
        .events
        .front()
        .map(|event| event.sequence.saturating_add(1))
        .unwrap_or(1);
    status.events.push_front(RecoveryTaskEvent {
        sequence,
        elapsed_ms: current_time_ms().saturating_sub(status.started_at_ms),
        phase,
        engine,
        message,
        archive_path,
        recursive_depth,
        attempted_count,
        total_count,
        scanned_file_count,
    });
    if status.events.len() > RECOVERY_EVENT_LIMIT {
        status.events.pop_back();
    }
}

fn recovery_progress_bucket(attempted: u64, total: u64) -> u64 {
    attempted
        .saturating_mul(20)
        .checked_div(total)
        .unwrap_or(attempted)
}

pub(super) fn catch_recovery_panic<T>(
    operation: impl FnOnce() -> Result<T, RecoveryError>,
) -> Result<T, RecoveryError> {
    match std::panic::catch_unwind(AssertUnwindSafe(operation)) {
        Ok(outcome) => outcome,
        Err(payload) => Err(RecoveryError::Message(format!(
            "后台恢复任务异常终止：{}",
            panic_payload_message(payload.as_ref())
        ))),
    }
}

pub(super) fn recovery_failure_kind(error: &RecoveryError) -> RecoveryFailureKind {
    match error {
        RecoveryError::InvalidArchive(_) => RecoveryFailureKind::InvalidArchive,
        RecoveryError::UnsupportedFormat => RecoveryFailureKind::UnsupportedFormat,
        RecoveryError::MissingTool(_) => RecoveryFailureKind::MissingTool,
        RecoveryError::NotFound(_) => RecoveryFailureKind::NotFound,
        RecoveryError::Io(_) => RecoveryFailureKind::Io,
        RecoveryError::Process(_) => RecoveryFailureKind::Process,
        RecoveryError::Cancelled | RecoveryError::Message(_) => RecoveryFailureKind::Other,
    }
}

pub(super) fn update_recovery_preparation(
    status: &Arc<Mutex<RecoveryTaskStatus>>,
    message: impl Into<String>,
) {
    let Ok(mut status) = status.lock() else {
        return;
    };
    status.phase = RecoveryPhase::Preparing;
    status.engine = Some("本机历史".into());
    status.message = message.into();
    append_current_recovery_event(&mut status);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_recovery_status() -> RecoveryTaskStatus {
        RecoveryTaskStatus {
            task_id: "test".into(),
            phase: RecoveryPhase::Preparing,
            running: true,
            completed: false,
            success: false,
            cancelled: false,
            failure_kind: None,
            failure_phase: None,
            gpu_started: false,
            hashcat_progress: None,
            archive_path: "archive.7z".into(),
            archive_format: ArchiveFormat::SevenZip,
            archive_format_label: "7z".into(),
            engine: None,
            message: "test".into(),
            candidate_count: 0,
            attempted_count: 0,
            started_at_ms: current_time_ms(),
            elapsed_ms: 0,
            recovered_password: None,
            output_directory: "output".into(),
            compute_mode: RecoveryComputeMode::GpuPreferred,
            recursive_enabled: true,
            recursive_depth: 0,
            current_archive_path: Some("archive.7z".into()),
            nested_archive_count: 0,
            extracted_nested_archive_count: 0,
            skipped_nested_archive_count: 0,
            scanned_file_count: 0,
            root_extraction_completed: false,
            depth_limit_reached: false,
            count_limit_reached: false,
            events: VecDeque::new(),
        }
    }

    #[test]
    fn recovery_event_history_is_bounded_and_latest_first() {
        let mut status = test_recovery_status();
        for index in 0..100 {
            push_recovery_event(
                &mut status,
                RecoveryPhase::Preparing,
                None,
                format!("event-{index}"),
                None,
                0,
                None,
                None,
                None,
            );
        }

        assert_eq!(status.events.len(), RECOVERY_EVENT_LIMIT);
        assert_eq!(
            status.events.front().map(|event| event.message.as_str()),
            Some("event-99")
        );
        assert_eq!(
            status.events.back().map(|event| event.message.as_str()),
            Some("event-20")
        );
    }

    #[test]
    fn recovery_candidate_events_are_recorded_in_five_percent_buckets() {
        let mut status = test_recovery_status();
        for attempted in [1, 2, 4, 5, 6, 9, 10] {
            push_recovery_event(
                &mut status,
                RecoveryPhase::Internal,
                Some("7-Zip CPU".into()),
                format!("attempted {attempted}"),
                Some("archive.7z".into()),
                0,
                Some(attempted),
                Some(100),
                None,
            );
        }

        assert_eq!(status.events.len(), 3);
        assert_eq!(
            status
                .events
                .iter()
                .map(|event| event.attempted_count)
                .collect::<Vec<_>>(),
            vec![Some(10), Some(5), Some(1)]
        );
    }

    #[test]
    fn recovery_panics_become_failed_outcomes() {
        let outcome: Result<(), RecoveryError> =
            catch_recovery_panic(|| panic!("simulated recovery panic"));

        assert!(matches!(
            outcome,
            Err(RecoveryError::Message(message))
                if message.contains("simulated recovery panic")
        ));
    }

    #[test]
    fn recovery_errors_map_to_structured_failure_kinds() {
        assert_eq!(
            recovery_failure_kind(&RecoveryError::InvalidArchive("broken".into())),
            RecoveryFailureKind::InvalidArchive
        );
        assert_eq!(
            recovery_failure_kind(&RecoveryError::Io(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "denied",
            ))),
            RecoveryFailureKind::Io
        );
    }

    #[test]
    fn recovery_completion_guard_finalizes_and_cleans_after_unwind() {
        let directory = tempfile::tempdir().expect("tempdir");
        let work_directory = directory.path().join("recovery-work");
        std::fs::create_dir_all(&work_directory).expect("work directory");
        std::fs::write(work_directory.join("partial"), b"partial").expect("partial output");
        let status = Arc::new(Mutex::new(test_recovery_status()));

        {
            let _guard =
                RecoveryTaskCompletionGuard::new(Arc::clone(&status), work_directory.clone());
        }

        let status = status.lock().expect("status");
        assert!(!status.running);
        assert!(status.completed);
        assert_eq!(status.phase, RecoveryPhase::Failed);
        assert_eq!(status.failure_kind, Some(RecoveryFailureKind::Other));
        assert_eq!(status.failure_phase, Some(RecoveryPhase::Preparing));
        assert!(!work_directory.exists());
    }
}
