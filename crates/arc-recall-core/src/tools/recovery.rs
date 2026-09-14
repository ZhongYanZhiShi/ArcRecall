use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::runner::{
    CancellationToken, ProcessOutput, ProcessRequest, ProcessRunnerError, run_process,
};

mod archive;
mod cracking;
mod disk_budget;
use disk_budget::TaskDiskBudget;
mod recursive;
mod repair;
pub use repair::create_repaired_archive_copy;
mod seven_zip;

#[cfg(test)]
use archive::{
    MAX_LZ4_DECODED_BYTES, RAR5_SIGNATURE, SEVEN_ZIP_SIGNATURE, ZIP_SIGNATURES,
    lz4_decoded_byte_limit, materialize_volume_with,
};
pub use archive::{
    analyze_archive, detect_archive_format, fingerprint_archive_sha256,
    fingerprint_archive_sha256_with_cancellation, fingerprint_file_sha256, path_for_display,
};
use archive::{
    detect_nested_archive_format, is_lz4_frame, materialize_lz4_archive, materialize_split_archive,
};
pub use cracking::probe_recovery_capabilities;
#[cfg(test)]
use cracking::{
    HashcatComputeDevice, HashcatDeviceAvailability, decode_password, extract_hashes,
    fallback_hashcat_modes, hashcat_device_plan, parse_hash_records, parse_hashcat_device_types,
    seven_zip_converter_archive_args,
};
use cracking::{recover_with_dictionary, validate_base_job_inputs, validate_dictionary_input};
#[cfg(test)]
use recursive::NestedOutputTransaction;
use recursive::RecursiveProgressSnapshot;
pub use recursive::recover_and_extract_recursive_lazy;
#[cfg(test)]
use seven_zip::{
    ArchiveExtractionBudget, archive_type_matches, parse_seven_zip_extraction_budget,
    seven_zip_archive_types, seven_zip_password_arg,
};
use seven_zip::{extract_with_password, validate_archive_container, verify_password};

pub const DEFAULT_RECURSIVE_MAX_DEPTH: u32 = 5;
pub const DEFAULT_RECURSIVE_MAX_ARCHIVES: u32 = 100;
pub const DEFAULT_SCAN_MAX_FILES_PER_DIRECTORY: u32 = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ArchiveFormat {
    SevenZip,
    Zip,
    Rar3,
    Rar5,
}

impl ArchiveFormat {
    pub fn label(self) -> &'static str {
        match self {
            Self::SevenZip => "7z",
            Self::Zip => "ZIP",
            Self::Rar3 => "RAR3",
            Self::Rar5 => "RAR5",
        }
    }

    fn extension(self) -> &'static str {
        match self {
            Self::SevenZip => "7z",
            Self::Zip => "zip",
            Self::Rar3 | Self::Rar5 => "rar",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RecoveryPhase {
    Preparing,
    Verifying,
    Converting,
    Hashcat,
    John,
    Internal,
    Extracting,
    Recursive,
    Completed,
    Exhausted,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum RecoveryComputeMode {
    #[default]
    GpuPreferred,
    CpuOnly,
}

impl RecoveryComputeMode {
    pub const fn label(self) -> &'static str {
        match self {
            Self::GpuPreferred => "GPU 优先",
            Self::CpuOnly => "仅 CPU",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RecoveryComputeDevice {
    Gpu,
    Cpu,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryMethodCapability {
    pub id: String,
    pub label: String,
    pub device: RecoveryComputeDevice,
    pub supported: bool,
    pub available: bool,
    #[serde(default)]
    pub optional: bool,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryCapabilities {
    pub gpu_available: bool,
    pub cpu_available: bool,
    pub methods: Vec<RecoveryMethodCapability>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveAnalysis {
    pub archive_path: String,
    pub file_name: String,
    pub format: ArchiveFormat,
    pub format_label: String,
    pub file_size: u64,
    pub volume_count: u32,
    #[serde(skip)]
    pub volume_paths: Vec<PathBuf>,
    pub suggested_output_directory: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HashcatProgress {
    pub completed: u64,
    pub total: u64,
    pub hashes_per_second: u64,
    pub remaining_seconds: Option<u64>,
    pub temperature_celsius: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryUpdate {
    pub phase: RecoveryPhase,
    pub engine: Option<String>,
    pub compute_device: Option<RecoveryComputeDevice>,
    pub message: String,
    pub attempted_count: Option<u64>,
    pub total_count: Option<u64>,
    pub recursive_depth: Option<u32>,
    pub current_archive_path: Option<String>,
    pub nested_archive_count: Option<u32>,
    pub extracted_nested_archive_count: Option<u32>,
    pub skipped_nested_archive_count: Option<u32>,
    pub scanned_file_count: Option<u64>,
    pub root_extraction_completed: Option<bool>,
    pub hashcat_progress: Option<HashcatProgress>,
}

impl RecoveryUpdate {
    fn stage(
        phase: RecoveryPhase,
        engine: Option<impl Into<String>>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            phase,
            engine: engine.map(Into::into),
            compute_device: None,
            message: message.into(),
            attempted_count: None,
            total_count: None,
            recursive_depth: None,
            current_archive_path: None,
            nested_archive_count: None,
            extracted_nested_archive_count: None,
            skipped_nested_archive_count: None,
            scanned_file_count: None,
            root_extraction_completed: None,
            hashcat_progress: None,
        }
    }

    fn progress(
        phase: RecoveryPhase,
        engine: impl Into<String>,
        message: impl Into<String>,
        attempted_count: u64,
        total_count: u64,
    ) -> Self {
        Self {
            phase,
            engine: Some(engine.into()),
            compute_device: None,
            message: message.into(),
            attempted_count: Some(attempted_count),
            total_count: Some(total_count),
            recursive_depth: None,
            current_archive_path: None,
            nested_archive_count: None,
            extracted_nested_archive_count: None,
            skipped_nested_archive_count: None,
            scanned_file_count: None,
            root_extraction_completed: None,
            hashcat_progress: None,
        }
    }

    fn with_root_extraction_completed(mut self) -> Self {
        self.root_extraction_completed = Some(true);
        self
    }

    fn with_compute_device(mut self, compute_device: RecoveryComputeDevice) -> Self {
        self.compute_device = Some(compute_device);
        self
    }

    fn with_recursive_context(
        mut self,
        depth: u32,
        archive_path: &Path,
        state: &RecursiveProgressSnapshot,
    ) -> Self {
        self.recursive_depth = Some(depth);
        self.current_archive_path = Some(path_for_display(archive_path));
        self.nested_archive_count = Some(state.discovered_nested_archives);
        self.extracted_nested_archive_count = Some(state.extracted_nested_archives);
        self.skipped_nested_archive_count = Some(state.skipped_nested_archives);
        self.scanned_file_count = Some(state.scanned_files);
        self
    }
}

#[derive(Debug, Clone)]
pub struct RecoveryToolPaths {
    pub seven_zip: PathBuf,
    pub hashcat: PathBuf,
    pub john_tools_directory: PathBuf,
    pub perl: PathBuf,
}

#[derive(Debug, Clone)]
pub struct RecoveryJob {
    pub archive_path: PathBuf,
    pub output_directory: PathBuf,
    pub dictionary_path: PathBuf,
    pub dictionary_count: u64,
    pub known_password: Option<String>,
    pub work_directory: PathBuf,
}

/// The physical size of the archive being processed, including every volume.
/// For an LZ4 wrapper this describes the decoded inner archive instead.
struct RecoveryInput<'a> {
    job: &'a RecoveryJob,
    archive_bytes: u64,
    disk_budget: &'a TaskDiskBudget,
}

#[derive(Debug, Clone)]
pub struct RecoveryDictionary {
    pub path: PathBuf,
    pub candidate_count: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecursiveRecoveryOptions {
    pub enabled: bool,
    /// Skip a directory and its descendants when it has more direct files.
    /// Zero disables this scan heuristic; extraction and password checks are unaffected.
    pub max_files_per_directory: u32,
    pub max_depth: u32,
    pub max_nested_archives: u32,
    pub compute_mode: RecoveryComputeMode,
    pub max_total_bytes: u64,
    pub max_total_entries: u64,
}

impl Default for RecursiveRecoveryOptions {
    fn default() -> Self {
        Self {
            enabled: true,
            max_files_per_directory: DEFAULT_SCAN_MAX_FILES_PER_DIRECTORY,
            max_depth: DEFAULT_RECURSIVE_MAX_DEPTH,
            max_nested_archives: DEFAULT_RECURSIVE_MAX_ARCHIVES,
            compute_mode: RecoveryComputeMode::default(),
            max_total_bytes: disk_budget::DEFAULT_TASK_MAX_BYTES,
            max_total_entries: disk_budget::DEFAULT_TASK_MAX_ENTRIES,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveredArchive {
    pub fingerprint_sha256: String,
    pub archive_format: ArchiveFormat,
    pub file_size: u64,
    pub volume_count: u32,
    pub password: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryResult {
    pub success: bool,
    pub cancelled: bool,
    pub password: Option<String>,
    pub engine: Option<String>,
    pub output_directory: PathBuf,
    pub message: String,
    pub recovered_archive: Option<RecoveredArchive>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecursiveRecoveryResult {
    /// Root success means its output was published, even when a later recursive
    /// step was cancelled. Consumers must check `root.cancelled` for task status.
    pub root: RecoveryResult,
    pub discovered_nested_archives: u32,
    pub extracted_nested_archives: u32,
    pub skipped_nested_archives: u32,
    pub depth_limit_reached: bool,
    pub count_limit_reached: bool,
    pub recovered_passwords: Vec<String>,
    pub recovered_archives: Vec<RecoveredArchive>,
    pub scanned_files: u64,
    pub completed_archive_paths: Vec<PathBuf>,
    pub skipped_archive_paths: Vec<PathBuf>,
    pub pending_archive_paths: Vec<PathBuf>,
    pub scan_interrupted: bool,
    pub budget_limit_reached: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum RecoveryError {
    #[error("找不到文件：{0}")]
    NotFound(String),
    #[error("当前仅支持 7z、ZIP、RAR3 和 RAR5 归档")]
    UnsupportedFormat,
    #[error("恢复引擎缺失：{0}")]
    MissingTool(String),
    #[error("外部工具执行失败：{0}")]
    Process(String),
    #[error("外部恢复任务已取消")]
    Cancelled,
    #[error("归档无法继续验密：{0}")]
    InvalidArchive(String),
    #[error("{0}")]
    BudgetExceeded(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Message(String),
}

pub fn recover_and_extract(
    job: &RecoveryJob,
    tools: &RecoveryToolPaths,
    cancellation: &CancellationToken,
    report: impl FnMut(RecoveryUpdate),
) -> Result<RecoveryResult, RecoveryError> {
    let dictionary = RecoveryDictionary {
        path: job.dictionary_path.clone(),
        candidate_count: job.dictionary_count,
    };
    recover_and_extract_lazy(job, tools, cancellation, move || Ok(dictionary), report)
}

/// Recover and extract an archive while deferring dictionary materialization.
///
/// Empty-password and manually supplied password checks run before
/// `prepare_dictionary` is called. This keeps the common path fast even when
/// the global dictionary contains millions of candidates.
pub fn recover_and_extract_lazy(
    job: &RecoveryJob,
    tools: &RecoveryToolPaths,
    cancellation: &CancellationToken,
    prepare_dictionary: impl FnOnce() -> Result<RecoveryDictionary, RecoveryError>,
    mut report: impl FnMut(RecoveryUpdate),
) -> Result<RecoveryResult, RecoveryError> {
    let mut prepare_dictionary = Some(prepare_dictionary);
    let disk_budget = TaskDiskBudget::default();
    recover_single_archive(
        job,
        tools,
        cancellation,
        RecoveryComputeMode::default(),
        &disk_budget,
        None,
        &mut || {
            let prepare = prepare_dictionary
                .take()
                .ok_or_else(|| RecoveryError::Message("恢复字典只能准备一次。".into()))?;
            prepare()
        },
        &mut report,
    )
}

#[allow(clippy::too_many_arguments)]
fn recover_single_archive(
    job: &RecoveryJob,
    tools: &RecoveryToolPaths,
    cancellation: &CancellationToken,
    compute_mode: RecoveryComputeMode,
    disk_budget: &TaskDiskBudget,
    precomputed_fingerprint_sha256: Option<&str>,
    prepare_dictionary: &mut impl FnMut() -> Result<RecoveryDictionary, RecoveryError>,
    report: &mut impl FnMut(RecoveryUpdate),
) -> Result<RecoveryResult, RecoveryError> {
    validate_base_job_inputs(job, tools)?;
    let analysis = analyze_archive(&job.archive_path)?;
    fs::create_dir_all(&job.work_directory)?;
    let mut processing_job = job.clone();
    let mut archive_bytes = analysis.file_size;
    let mut converter_archive_paths = analysis.volume_paths.clone();
    let split_materialization =
        materialize_split_archive(&analysis, &job.work_directory, cancellation, disk_budget)?;

    if let Some(materialization) = &split_materialization {
        report(RecoveryUpdate::stage(
            RecoveryPhase::Preparing,
            Some("7-Zip"),
            format!(
                "检测到 {} 个归档分卷，已在任务工作目录准备可读分卷序列。",
                analysis.volume_count
            ),
        ));
        processing_job.archive_path = materialization.primary_path().to_path_buf();
        converter_archive_paths = materialization.volume_paths().to_vec();
    }

    if is_lz4_frame(&job.archive_path)? {
        report(RecoveryUpdate::stage(
            RecoveryPhase::Preparing,
            Some("LZ4"),
            format!(
                "检测到 LZ4 Frame，正在流式解包内部 {} 归档。",
                analysis.format.label()
            ),
        ));
        processing_job.archive_path = materialize_lz4_archive(
            &job.archive_path,
            analysis.format,
            &job.work_directory,
            cancellation,
            disk_budget,
        )?
        .ok_or_else(|| RecoveryError::Message("LZ4 临时归档准备失败。".into()))?;
        converter_archive_paths = vec![processing_job.archive_path.clone()];
        archive_bytes = fs::metadata(&processing_job.archive_path)?.len();
    }

    let processing_input = RecoveryInput {
        job: &processing_job,
        archive_bytes,
        disk_budget,
    };
    validate_archive_container(
        &processing_job.archive_path,
        analysis.format,
        tools,
        cancellation,
    )?;
    ensure_not_cancelled(cancellation)?;
    report(RecoveryUpdate::stage(
        RecoveryPhase::Verifying,
        Some("7-Zip"),
        "正在检查归档是否无需密码。",
    ));
    if verify_password(&processing_job.archive_path, "", tools, cancellation)? {
        extract_with_password(&processing_input, tools, "", cancellation, report)?;
        return attach_recovered_archive(
            success_result(&processing_job, None, "7-Zip", "归档无需密码，已直接解压。"),
            &analysis,
            precomputed_fingerprint_sha256,
            cancellation,
        );
    }

    if let Some(password) = job
        .known_password
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        report(RecoveryUpdate::stage(
            RecoveryPhase::Verifying,
            Some("7-Zip"),
            "正在验证手动输入或历史记录中的密码。",
        ));
        if verify_password(&processing_job.archive_path, password, tools, cancellation)? {
            extract_with_password(&processing_input, tools, password, cancellation, report)?;
            return attach_recovered_archive(
                success_result(
                    &processing_job,
                    Some(password.to_owned()),
                    "优先密码",
                    "优先密码验证通过，归档已解压。",
                ),
                &analysis,
                precomputed_fingerprint_sha256,
                cancellation,
            );
        }
    }

    ensure_not_cancelled(cancellation)?;
    report(RecoveryUpdate::stage(
        RecoveryPhase::Preparing,
        Some("全局字典"),
        "需要继续恢复密码，正在准备全局字典。",
    ));
    let dictionary = prepare_dictionary()?;
    ensure_not_cancelled(cancellation)?;
    let dictionary_job = RecoveryJob {
        dictionary_path: dictionary.path,
        dictionary_count: dictionary.candidate_count,
        ..processing_job
    };
    validate_dictionary_input(&dictionary_job)?;
    report(RecoveryUpdate::progress(
        RecoveryPhase::Preparing,
        "全局字典",
        format!(
            "已准备 {} 条候选，正在选择可用的恢复引擎。",
            dictionary_job.dictionary_count
        ),
        0,
        dictionary_job.dictionary_count,
    ));

    if dictionary_job.dictionary_count == 0 {
        return Ok(exhausted_result(
            &dictionary_job,
            "优先密码未通过，且全局字典中没有可用候选。",
        ));
    }

    let result = recover_with_dictionary(
        &RecoveryInput {
            job: &dictionary_job,
            archive_bytes,
            disk_budget,
        },
        tools,
        analysis.format,
        &converter_archive_paths,
        cancellation,
        compute_mode,
        report,
    )?;
    attach_recovered_archive(
        result,
        &analysis,
        precomputed_fingerprint_sha256,
        cancellation,
    )
}

fn run_checked(
    request: &ProcessRequest,
    cancellation: &CancellationToken,
) -> Result<ProcessOutput, RecoveryError> {
    run_process(request, Some(cancellation)).map_err(|error| match error {
        ProcessRunnerError::Cancelled => RecoveryError::Cancelled,
        other => RecoveryError::Process(other.to_string()),
    })
}

fn ensure_not_cancelled(cancellation: &CancellationToken) -> Result<(), RecoveryError> {
    if cancellation.is_cancelled() {
        Err(RecoveryError::Cancelled)
    } else {
        Ok(())
    }
}

fn success_result(
    job: &RecoveryJob,
    password: Option<String>,
    engine: &str,
    message: &str,
) -> RecoveryResult {
    RecoveryResult {
        success: true,
        cancelled: false,
        password,
        engine: Some(engine.into()),
        output_directory: job.output_directory.clone(),
        message: message.into(),
        recovered_archive: None,
    }
}

fn exhausted_result(job: &RecoveryJob, message: &str) -> RecoveryResult {
    RecoveryResult {
        success: false,
        cancelled: false,
        password: None,
        engine: None,
        output_directory: job.output_directory.clone(),
        message: message.into(),
        recovered_archive: None,
    }
}

fn attach_recovered_archive(
    mut result: RecoveryResult,
    analysis: &ArchiveAnalysis,
    precomputed_fingerprint_sha256: Option<&str>,
    cancellation: &CancellationToken,
) -> Result<RecoveryResult, RecoveryError> {
    if result.success {
        ensure_not_cancelled(cancellation)?;
        let fingerprint = match precomputed_fingerprint_sha256 {
            Some(fingerprint) => Some(fingerprint.to_owned()),
            None => match fingerprint_archive_sha256_with_cancellation(analysis, cancellation) {
                Ok(fingerprint) => Some(fingerprint),
                Err(RecoveryError::Cancelled) => return Err(RecoveryError::Cancelled),
                // A missing history record must not undo a completed extraction.
                Err(_) => None,
            },
        };
        ensure_not_cancelled(cancellation)?;
        result.recovered_archive = fingerprint.map(|fingerprint_sha256| RecoveredArchive {
            fingerprint_sha256,
            archive_format: analysis.format,
            file_size: analysis.file_size,
            volume_count: analysis.volume_count,
            password: result.password.clone().filter(|value| !value.is_empty()),
        });
    }
    Ok(result)
}

fn process_failure(tool: &str, output: &ProcessOutput) -> RecoveryError {
    let detail = process_failure_detail(output);
    RecoveryError::Process(format!("{tool} 退出码 {:?}：{}", output.exit_code, detail))
}

fn process_failure_detail(output: &ProcessOutput) -> String {
    let detail = if output.stderr.trim().is_empty() {
        output.stdout.trim()
    } else {
        output.stderr.trim()
    };
    if detail.is_empty() {
        format!("退出码 {:?}，未返回诊断信息", output.exit_code)
    } else {
        detail.to_owned()
    }
}

fn is_password_rejection(output: &ProcessOutput) -> bool {
    let diagnostic = format!("{}\n{}", output.stdout, output.stderr).to_lowercase();
    [
        "wrong password",
        "password is incorrect",
        "cannot open encrypted archive",
        "data error in encrypted file",
    ]
    .iter()
    .any(|marker| diagnostic.contains(marker))
}

#[cfg(test)]
#[path = "recovery/tests.rs"]
mod tests;
