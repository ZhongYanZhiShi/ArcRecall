use std::collections::{HashMap, HashSet, VecDeque};
use std::ffi::OsString;
use std::fs;
use std::io::{BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use lz4::Decoder as Lz4Decoder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::runner::{
    CancellationToken, ProcessOutput, ProcessRequest, ProcessRunnerError, run_process,
    strawberry_perl_path_entries,
};

const SEVEN_ZIP_SIGNATURE: &[u8] = b"\x37\x7a\xbc\xaf\x27\x1c";
const RAR3_SIGNATURE: &[u8] = b"Rar!\x1a\x07\x00";
const RAR5_SIGNATURE: &[u8] = b"Rar!\x1a\x07\x01\x00";
const ZIP_SIGNATURES: [&[u8]; 3] = [b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08"];
const LZ4_FRAME_SIGNATURE: &[u8] = b"\x04\x22\x4d\x18";
const SIGNATURE_SCAN_LIMIT: u64 = 4 * 1024 * 1024;
const HEADER_PROBE_LIMIT: usize = 16;
const DOS_HEADER_PROBE_LIMIT: usize = 64;
const PE_SECTION_HEADER_SIZE: u64 = 40;
const PE_MAX_SECTION_COUNT: u16 = 96;
const LZ4_COPY_BUFFER_SIZE: usize = 256 * 1024;
const SCAN_PROGRESS_INTERVAL_FILES: u64 = 128;
const FINGERPRINT_FULL_READ_LIMIT: u64 = 1024 * 1024;
const FINGERPRINT_SAMPLE_SIZE: u64 = 64 * 1024;
const FINGERPRINT_SAMPLE_COUNT: u64 = 5;
pub const DEFAULT_RECURSIVE_MAX_DEPTH: u32 = 5;
pub const DEFAULT_RECURSIVE_MAX_ARCHIVES: u32 = 100;

const HASHCAT_ARCHIVE_MODES: [u32; 13] = [
    11600, 12500, 13000, 13600, 17200, 17210, 17220, 17225, 17230, 17240, 17250, 23700, 23800,
];

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
    pub suggested_output_directory: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryUpdate {
    pub phase: RecoveryPhase,
    pub engine: Option<String>,
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
        }
    }

    fn with_root_extraction_completed(mut self) -> Self {
        self.root_extraction_completed = Some(true);
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

#[derive(Debug, Clone)]
pub struct RecoveryDictionary {
    pub path: PathBuf,
    pub candidate_count: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecursiveRecoveryOptions {
    pub enabled: bool,
    pub max_depth: u32,
    pub max_nested_archives: u32,
    pub compute_mode: RecoveryComputeMode,
}

impl Default for RecursiveRecoveryOptions {
    fn default() -> Self {
        Self {
            enabled: true,
            max_depth: DEFAULT_RECURSIVE_MAX_DEPTH,
            max_nested_archives: DEFAULT_RECURSIVE_MAX_ARCHIVES,
            compute_mode: RecoveryComputeMode::default(),
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
    pub root: RecoveryResult,
    pub discovered_nested_archives: u32,
    pub extracted_nested_archives: u32,
    pub skipped_nested_archives: u32,
    pub depth_limit_reached: bool,
    pub count_limit_reached: bool,
    pub recovered_passwords: Vec<String>,
    pub recovered_archives: Vec<RecoveredArchive>,
    pub scanned_files: u64,
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
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Message(String),
}

#[derive(Debug, Clone)]
struct HashRecord {
    john_line: String,
    hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum CrackAttempt {
    Found(String),
    Exhausted,
    Failed,
}

#[derive(Debug, Clone)]
struct NestedArchiveTask {
    archive_path: PathBuf,
    depth: u32,
    inherited_password: Option<String>,
}

struct NestedOutputTransaction {
    destination: PathBuf,
    staging: PathBuf,
    committed: bool,
}

impl NestedOutputTransaction {
    fn new(destination: PathBuf) -> Self {
        let staging = resolve_nested_staging_directory(&destination);
        Self {
            destination,
            staging,
            committed: false,
        }
    }

    fn staging_directory(&self) -> &Path {
        &self.staging
    }

    fn commit(&mut self) -> Result<(), RecoveryError> {
        if !self.staging.is_dir() {
            return Err(RecoveryError::Message(
                "嵌套归档解压完成，但临时输出不存在。".into(),
            ));
        }
        if self.destination.exists() {
            return Err(RecoveryError::Message(format!(
                "嵌套归档输出位置已被占用：{}",
                path_for_display(&self.destination)
            )));
        }
        fs::rename(&self.staging, &self.destination)?;
        self.committed = true;
        Ok(())
    }
}

impl Drop for NestedOutputTransaction {
    fn drop(&mut self) {
        if !self.committed {
            let _ = fs::remove_dir_all(&self.staging);
        }
    }
}

#[derive(Debug, Clone)]
struct FileSnapshot {
    length: u64,
    modified: Option<std::time::SystemTime>,
    created: Option<std::time::SystemTime>,
}

impl FileSnapshot {
    fn has_changed_since(&self, previous: &Self) -> bool {
        self.length != previous.length
            || self.modified != previous.modified
            || self.created != previous.created
    }
}

#[derive(Debug, Clone, Copy)]
struct RecursiveProgressSnapshot {
    discovered_nested_archives: u32,
    extracted_nested_archives: u32,
    skipped_nested_archives: u32,
    scanned_files: u64,
}

struct RecursiveRecoveryState {
    options: RecursiveRecoveryOptions,
    processed_archives: HashSet<PathBuf>,
    discovered_nested_archives: u32,
    extracted_nested_archives: u32,
    skipped_nested_archives: u32,
    scanned_files: u64,
    depth_limit_reached: bool,
    count_limit_reached: bool,
}

impl RecursiveRecoveryState {
    fn new(options: RecursiveRecoveryOptions) -> Self {
        Self {
            options,
            processed_archives: HashSet::new(),
            discovered_nested_archives: 0,
            extracted_nested_archives: 0,
            skipped_nested_archives: 0,
            scanned_files: 0,
            depth_limit_reached: false,
            count_limit_reached: false,
        }
    }

    fn collection_limit(&self) -> usize {
        let remaining = self
            .options
            .max_nested_archives
            .saturating_sub(self.discovered_nested_archives);
        remaining.saturating_add(1) as usize
    }

    fn progress_snapshot(&self) -> RecursiveProgressSnapshot {
        RecursiveProgressSnapshot {
            discovered_nested_archives: self.discovered_nested_archives,
            extracted_nested_archives: self.extracted_nested_archives,
            skipped_nested_archives: self.skipped_nested_archives,
            scanned_files: self.scanned_files,
        }
    }

    fn update(
        &self,
        message: impl Into<String>,
        depth: u32,
        archive_path: &Path,
    ) -> RecoveryUpdate {
        RecoveryUpdate::stage(RecoveryPhase::Recursive, Some("递归解密"), message)
            .with_recursive_context(depth, archive_path, &self.progress_snapshot())
    }
}

pub fn analyze_archive(path: impl AsRef<Path>) -> Result<ArchiveAnalysis, RecoveryError> {
    let path = path.as_ref();
    if !path.is_file() {
        return Err(RecoveryError::NotFound(path_for_display(path)));
    }
    let absolute = path.canonicalize()?;
    let format = detect_archive_format(&absolute)?;
    let metadata = absolute.metadata()?;
    let file_name = absolute
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("archive")
        .to_owned();
    let output_name = absolute
        .file_stem()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("archive");
    let suggested_output_directory = absolute
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(output_name);

    Ok(ArchiveAnalysis {
        archive_path: path_for_display(&absolute),
        file_name,
        format,
        format_label: format.label().into(),
        file_size: metadata.len(),
        suggested_output_directory: path_for_display(&suggested_output_directory),
    })
}

pub fn fingerprint_file_sha256(path: impl AsRef<Path>) -> Result<String, RecoveryError> {
    let mut file = fs::File::open(path)?;
    let file_size = file.metadata()?.len();
    let mut hasher = Sha256::new();
    hasher.update(b"arc-recall-content-fingerprint-v2\0");
    hasher.update(file_size.to_le_bytes());

    let ranges = fingerprint_sample_ranges(file_size);
    let mut buffer = vec![0u8; FINGERPRINT_SAMPLE_SIZE as usize];
    for (offset, length) in ranges {
        file.seek(SeekFrom::Start(offset))?;
        hasher.update(offset.to_le_bytes());
        hasher.update((length as u64).to_le_bytes());
        let mut read_total = 0;
        while read_total < length {
            let count = file.read(&mut buffer[..length - read_total])?;
            if count == 0 {
                break;
            }
            hasher.update(&buffer[..count]);
            read_total += count;
        }
    }
    Ok(hex::encode(hasher.finalize()))
}

fn fingerprint_sample_ranges(file_size: u64) -> Vec<(u64, usize)> {
    if file_size == 0 {
        return Vec::new();
    }
    if file_size <= FINGERPRINT_FULL_READ_LIMIT {
        return vec![(0, file_size as usize)];
    }

    let max_offset = file_size.saturating_sub(FINGERPRINT_SAMPLE_SIZE);
    let mut offsets = (0..FINGERPRINT_SAMPLE_COUNT)
        .map(|index| max_offset.saturating_mul(index) / (FINGERPRINT_SAMPLE_COUNT - 1))
        .collect::<Vec<_>>();
    offsets.sort_unstable();
    offsets.dedup();
    offsets
        .into_iter()
        .map(|offset| {
            (
                offset,
                FINGERPRINT_SAMPLE_SIZE.min(file_size - offset) as usize,
            )
        })
        .collect()
}

pub fn detect_archive_format(path: &Path) -> Result<ArchiveFormat, RecoveryError> {
    detect_archive_format_with_limit(path, |_| SIGNATURE_SCAN_LIMIT)
}

fn detect_nested_archive_format(path: &Path) -> Result<ArchiveFormat, RecoveryError> {
    if !path.is_file() {
        return Err(RecoveryError::NotFound(path_for_display(path)));
    }
    let mut file = fs::File::open(path)?;
    let metadata = file.metadata()?;
    let mut prefix = [0u8; DOS_HEADER_PROBE_LIMIT];
    let prefix_length = file.read(&mut prefix)?;
    let prefix = &prefix[..prefix_length];

    if prefix.starts_with(LZ4_FRAME_SIGNATURE) {
        return detect_lz4_inner_format(path, file);
    }
    if let Some(format) = detect_format_at_offset(prefix) {
        return Ok(format);
    }

    let scan_start = if prefix.starts_with(b"MZ") {
        pe_overlay_offset(&mut file, metadata.len()).ok_or(RecoveryError::UnsupportedFormat)?
    } else if looks_like_embedded_archive_carrier(prefix) {
        0
    } else {
        return Err(RecoveryError::UnsupportedFormat);
    };
    if scan_start >= metadata.len() {
        return Err(RecoveryError::UnsupportedFormat);
    }

    file.seek(SeekFrom::Start(scan_start))?;
    let scan_length = metadata
        .len()
        .saturating_sub(scan_start)
        .min(SIGNATURE_SCAN_LIMIT) as usize;
    let mut buffer = Vec::with_capacity(scan_length);
    file.take(scan_length as u64).read_to_end(&mut buffer)?;
    detect_format_in_buffer(&buffer, false).ok_or(RecoveryError::UnsupportedFormat)
}

fn detect_archive_format_with_limit(
    path: &Path,
    scan_limit: impl FnOnce(&[u8]) -> u64,
) -> Result<ArchiveFormat, RecoveryError> {
    if !path.is_file() {
        return Err(RecoveryError::NotFound(path_for_display(path)));
    }
    let mut file = fs::File::open(path)?;
    let metadata = file.metadata()?;
    let mut prefix = [0u8; HEADER_PROBE_LIMIT];
    let prefix_length = file.read(&mut prefix)?;
    let prefix = &prefix[..prefix_length];
    let scan_limit = scan_limit(prefix);
    if prefix.starts_with(LZ4_FRAME_SIGNATURE) {
        return detect_lz4_inner_format(path, file);
    }
    if let Some(format) = detect_format_in_buffer(prefix, true) {
        return Ok(format);
    }
    let scan_limit = metadata.len().min(scan_limit) as usize;
    let mut buffer = Vec::with_capacity(scan_limit);
    buffer.extend_from_slice(prefix);
    file.take(scan_limit.saturating_sub(prefix_length) as u64)
        .read_to_end(&mut buffer)?;
    detect_format_in_buffer(&buffer, false).ok_or(RecoveryError::UnsupportedFormat)
}

fn detect_lz4_inner_format(
    path: &Path,
    mut file: fs::File,
) -> Result<ArchiveFormat, RecoveryError> {
    file.seek(SeekFrom::Start(0))?;
    let mut decoder =
        Lz4Decoder::new(BufReader::new(file)).map_err(|error| lz4_decode_error(path, error))?;
    let mut header = [0u8; HEADER_PROBE_LIMIT];
    let header_length = decoder
        .read(&mut header)
        .map_err(|error| lz4_decode_error(path, error))?;
    detect_format_at_offset(&header[..header_length]).ok_or(RecoveryError::UnsupportedFormat)
}

fn pe_overlay_offset(file: &mut fs::File, file_size: u64) -> Option<u64> {
    let mut dos_header = [0u8; DOS_HEADER_PROBE_LIMIT];
    file.seek(SeekFrom::Start(0)).ok()?;
    file.read_exact(&mut dos_header).ok()?;
    if !dos_header.starts_with(b"MZ") {
        return None;
    }

    let pe_offset = u32::from_le_bytes(dos_header[0x3c..0x40].try_into().ok()?) as u64;
    let mut coff_header = [0u8; 24];
    file.seek(SeekFrom::Start(pe_offset)).ok()?;
    file.read_exact(&mut coff_header).ok()?;
    if !coff_header.starts_with(b"PE\0\0") {
        return None;
    }

    let section_count = u16::from_le_bytes(coff_header[6..8].try_into().ok()?);
    if section_count == 0 || section_count > PE_MAX_SECTION_COUNT {
        return None;
    }
    let optional_header_size = u16::from_le_bytes(coff_header[20..22].try_into().ok()?) as u64;
    let section_table_offset = pe_offset
        .checked_add(24)?
        .checked_add(optional_header_size)?;
    let section_table_size = u64::from(section_count).checked_mul(PE_SECTION_HEADER_SIZE)?;
    if section_table_offset.checked_add(section_table_size)? > file_size {
        return None;
    }

    let mut overlay_offset = section_table_offset.checked_add(section_table_size)?;
    let mut section_header = [0u8; PE_SECTION_HEADER_SIZE as usize];
    for index in 0..section_count {
        let offset = section_table_offset
            .checked_add(u64::from(index).checked_mul(PE_SECTION_HEADER_SIZE)?)?;
        file.seek(SeekFrom::Start(offset)).ok()?;
        file.read_exact(&mut section_header).ok()?;
        let raw_size = u32::from_le_bytes(section_header[16..20].try_into().ok()?) as u64;
        let raw_offset = u32::from_le_bytes(section_header[20..24].try_into().ok()?) as u64;
        overlay_offset = overlay_offset.max(raw_offset.checked_add(raw_size)?);
    }
    Some(overlay_offset.min(file_size))
}

fn detect_format_in_buffer(buffer: &[u8], require_start: bool) -> Option<ArchiveFormat> {
    if require_start {
        return detect_format_at_offset(buffer);
    }
    (0..buffer.len()).find_map(|index| detect_format_at_offset(&buffer[index..]))
}

fn detect_format_at_offset(buffer: &[u8]) -> Option<ArchiveFormat> {
    match buffer.first().copied()? {
        0x37 if buffer.starts_with(SEVEN_ZIP_SIGNATURE) => Some(ArchiveFormat::SevenZip),
        b'R' if buffer.starts_with(RAR5_SIGNATURE) => Some(ArchiveFormat::Rar5),
        b'R' if buffer.starts_with(RAR3_SIGNATURE) => Some(ArchiveFormat::Rar3),
        b'P' if ZIP_SIGNATURES
            .iter()
            .any(|signature| buffer.starts_with(signature)) =>
        {
            Some(ArchiveFormat::Zip)
        }
        _ => None,
    }
}

fn lz4_decode_error(path: &Path, error: std::io::Error) -> RecoveryError {
    RecoveryError::Message(format!(
        "LZ4 外层解码失败（{}）：{error}",
        path_for_display(path)
    ))
}

fn is_lz4_frame(path: &Path) -> Result<bool, RecoveryError> {
    let mut file = fs::File::open(path)?;
    let mut signature = [0u8; LZ4_FRAME_SIGNATURE.len()];
    let length = file.read(&mut signature)?;
    Ok(length == signature.len() && signature == LZ4_FRAME_SIGNATURE)
}

fn materialize_lz4_archive(
    source: &Path,
    format: ArchiveFormat,
    work_directory: &Path,
    cancellation: &CancellationToken,
) -> Result<Option<PathBuf>, RecoveryError> {
    if !is_lz4_frame(source)? {
        return Ok(None);
    }

    let normalized_path = work_directory.join(format!("lz4-decoded.{}", format.extension()));
    let partial_path = work_directory.join("lz4-decoded.partial");
    let result = (|| {
        let input = BufReader::new(fs::File::open(source)?);
        let mut decoder =
            Lz4Decoder::new(input).map_err(|error| lz4_decode_error(source, error))?;
        let mut output = BufWriter::new(fs::File::create(&partial_path)?);
        let mut buffer = vec![0u8; LZ4_COPY_BUFFER_SIZE];

        loop {
            ensure_not_cancelled(cancellation)?;
            let length = decoder
                .read(&mut buffer)
                .map_err(|error| lz4_decode_error(source, error))?;
            if length == 0 {
                break;
            }
            output.write_all(&buffer[..length])?;
        }
        ensure_not_cancelled(cancellation)?;
        output.flush()?;
        drop(output);
        let (_, finish_result) = decoder.finish();
        finish_result.map_err(|error| lz4_decode_error(source, error))?;

        let mut normalized = fs::File::open(&partial_path)?;
        let mut header = [0u8; HEADER_PROBE_LIMIT];
        let header_length = normalized.read(&mut header)?;
        let decoded_format = detect_format_at_offset(&header[..header_length])
            .ok_or(RecoveryError::UnsupportedFormat)?;
        if decoded_format != format {
            return Err(RecoveryError::Message(format!(
                "LZ4 解包后的归档格式与分析结果不一致：预期 {}，实际 {}。",
                format.label(),
                decoded_format.label()
            )));
        }

        fs::rename(&partial_path, &normalized_path)?;
        Ok(normalized_path.clone())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&partial_path);
        let _ = fs::remove_file(&normalized_path);
    }
    result.map(Some)
}

fn looks_like_embedded_archive_carrier(prefix: &[u8]) -> bool {
    prefix.starts_with(b"\xff\xd8\xff")
        || prefix.starts_with(b"\x89PNG\r\n\x1a\n")
        || prefix.starts_with(b"GIF87a")
        || prefix.starts_with(b"GIF89a")
        || prefix.starts_with(b"BM")
        || prefix.starts_with(b"%PDF")
        || prefix.starts_with(b"ID3")
        || prefix.starts_with(b"\x1aE\xdf\xa3")
        || (prefix.len() >= 12 && &prefix[4..8] == b"ftyp")
        || (prefix.len() >= 12 && prefix.starts_with(b"RIFF") && &prefix[8..12] == b"WEBP")
}

pub fn path_for_display(path: &Path) -> String {
    strip_windows_verbatim_prefix(&path.to_string_lossy())
}

fn strip_windows_verbatim_prefix(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        rest.to_owned()
    } else {
        path.to_owned()
    }
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
    recover_single_archive(
        job,
        tools,
        cancellation,
        RecoveryComputeMode::default(),
        &mut || {
            let prepare = prepare_dictionary
                .take()
                .ok_or_else(|| RecoveryError::Message("恢复字典只能准备一次。".into()))?;
            prepare()
        },
        &mut report,
    )
}

pub fn recover_and_extract_recursive_lazy(
    job: &RecoveryJob,
    tools: &RecoveryToolPaths,
    cancellation: &CancellationToken,
    options: RecursiveRecoveryOptions,
    prepare_dictionary: impl FnOnce() -> Result<RecoveryDictionary, RecoveryError>,
    mut report: impl FnMut(RecoveryUpdate),
) -> Result<RecursiveRecoveryResult, RecoveryError> {
    let before_root_extraction = if options.enabled {
        capture_file_snapshot(&job.output_directory, cancellation)?
    } else {
        HashMap::new()
    };
    let mut prepare_dictionary = Some(prepare_dictionary);
    let mut dictionary_cache: Option<RecoveryDictionary> = None;
    let mut dictionary_error: Option<String> = None;
    let mut dictionary_provider = || {
        if let Some(dictionary) = dictionary_cache.as_ref() {
            return Ok(dictionary.clone());
        }
        if let Some(message) = dictionary_error.as_ref() {
            return Err(RecoveryError::Message(message.clone()));
        }
        let prepare = prepare_dictionary
            .take()
            .ok_or_else(|| RecoveryError::Message("恢复字典只能准备一次。".into()))?;
        match prepare() {
            Ok(dictionary) => {
                dictionary_cache = Some(dictionary.clone());
                Ok(dictionary)
            }
            Err(error) => {
                let message = error.to_string();
                dictionary_error = Some(message.clone());
                Err(RecoveryError::Message(message))
            }
        }
    };

    let mut root = recover_single_archive(
        job,
        tools,
        cancellation,
        options.compute_mode,
        &mut dictionary_provider,
        &mut report,
    )?;
    let mut recovered_passwords = Vec::new();
    if let Some(password) = root.password.as_ref() {
        recovered_passwords.push(password.clone());
    }
    let mut recovered_archives = root
        .recovered_archive
        .clone()
        .into_iter()
        .collect::<Vec<_>>();
    if !root.success || !options.enabled {
        return Ok(RecursiveRecoveryResult {
            root,
            discovered_nested_archives: 0,
            extracted_nested_archives: 0,
            skipped_nested_archives: 0,
            depth_limit_reached: false,
            count_limit_reached: false,
            recovered_passwords,
            recovered_archives,
            scanned_files: 0,
        });
    }

    let mut state = RecursiveRecoveryState::new(options);
    report(
        state
            .update(
                "外层解压已完成，正在扫描第 1 层输出。",
                1,
                &job.output_directory,
            )
            .with_root_extraction_completed(),
    );
    let initial_limit = state.collection_limit();
    let initial_scan_base = state.scanned_files;
    let nested_archives = find_new_or_changed_archives(
        &job.output_directory,
        &before_root_extraction,
        initial_limit,
        cancellation,
        |scanned_files, found_archives| {
            state.scanned_files = initial_scan_base.saturating_add(scanned_files);
            report(state.update(
                format!(
                    "正在扫描第 1 层输出：已检查 {scanned_files} 个文件，发现 {found_archives} 个归档。"
                ),
                1,
                &job.output_directory,
            ));
        },
    )?;
    let inherited_password = root
        .password
        .clone()
        .or_else(|| job.known_password.clone())
        .filter(|password| !password.is_empty());
    let mut pending = nested_archives
        .into_iter()
        .map(|archive_path| NestedArchiveTask {
            archive_path,
            depth: 1,
            inherited_password: inherited_password.clone(),
        })
        .collect::<VecDeque<_>>();

    while let Some(nested) = pending.pop_front() {
        ensure_not_cancelled(cancellation)?;
        if !nested.archive_path.is_file() {
            state.skipped_nested_archives = state.skipped_nested_archives.saturating_add(1);
            report(state.update(
                "嵌套压缩包已不存在，已跳过。",
                nested.depth,
                &nested.archive_path,
            ));
            continue;
        }
        if !state.processed_archives.insert(nested.archive_path.clone()) {
            continue;
        }
        if state.discovered_nested_archives >= state.options.max_nested_archives {
            state.count_limit_reached = true;
            state.skipped_nested_archives = state.skipped_nested_archives.saturating_add(1);
            report(state.update(
                format!(
                    "已达到 {} 个嵌套压缩包的安全上限，剩余项目不再处理。",
                    state.options.max_nested_archives
                ),
                nested.depth,
                &nested.archive_path,
            ));
            break;
        }

        state.discovered_nested_archives = state.discovered_nested_archives.saturating_add(1);
        if nested.depth > state.options.max_depth {
            state.depth_limit_reached = true;
            state.skipped_nested_archives = state.skipped_nested_archives.saturating_add(1);
            report(state.update(
                format!(
                    "已超过 {} 层递归安全上限，当前嵌套压缩包已跳过。",
                    state.options.max_depth
                ),
                nested.depth,
                &nested.archive_path,
            ));
            continue;
        }

        report(state.update(
            format!(
                "正在处理第 {} 层嵌套压缩包：{}。",
                nested.depth,
                archive_display_name(&nested.archive_path)
            ),
            nested.depth,
            &nested.archive_path,
        ));
        let nested_output = resolve_nested_output_directory(&nested.archive_path);
        let before_nested_extraction = capture_file_snapshot(&nested_output, cancellation)?;
        let mut output_transaction = NestedOutputTransaction::new(nested_output.clone());
        let nested_job = RecoveryJob {
            archive_path: nested.archive_path.clone(),
            output_directory: output_transaction.staging_directory().to_path_buf(),
            dictionary_path: job.dictionary_path.clone(),
            dictionary_count: job.dictionary_count,
            known_password: nested.inherited_password.clone(),
            work_directory: job
                .work_directory
                .join(format!("nested-{}", state.discovered_nested_archives)),
        };
        let context_state = state.progress_snapshot();
        let nested_result = recover_single_archive(
            &nested_job,
            tools,
            cancellation,
            state.options.compute_mode,
            &mut dictionary_provider,
            &mut |update| {
                let mut update = update.with_recursive_context(
                    nested.depth,
                    &nested.archive_path,
                    &context_state,
                );
                if update.phase == RecoveryPhase::Extracting {
                    update.message = format!(
                        "正在安全解压嵌套归档到 {}。",
                        path_for_display(&nested_output)
                    );
                }
                report(update)
            },
        );

        match nested_result {
            Ok(mut result) if result.success => {
                if let Err(error) = output_transaction.commit() {
                    state.skipped_nested_archives = state.skipped_nested_archives.saturating_add(1);
                    report(state.update(
                        format!(
                            "嵌套压缩包 {} 的临时输出无法发布，已自动清理：{error}",
                            archive_display_name(&nested.archive_path)
                        ),
                        nested.depth,
                        &nested.archive_path,
                    ));
                    continue;
                }
                result.output_directory = nested_output.clone();
                state.extracted_nested_archives = state.extracted_nested_archives.saturating_add(1);
                if let Some(record) = result.recovered_archive.clone() {
                    recovered_archives.push(record);
                }
                if let Some(password) = result.password.as_ref()
                    && !recovered_passwords.contains(password)
                {
                    recovered_passwords.push(password.clone());
                }
                let child_password = result
                    .password
                    .or(nested.inherited_password)
                    .filter(|password| !password.is_empty());
                let next_depth = nested.depth.saturating_add(1);
                report(state.update(
                    format!(
                        "{} 已完成解压，正在扫描第 {} 层输出。",
                        archive_display_name(&nested.archive_path),
                        next_depth
                    ),
                    next_depth,
                    &nested_output,
                ));
                let child_limit = state.collection_limit();
                let child_scan_base = state.scanned_files;
                let child_archives = find_new_or_changed_archives(
                    &nested_output,
                    &before_nested_extraction,
                    child_limit,
                    cancellation,
                    |scanned_files, found_archives| {
                        state.scanned_files = child_scan_base.saturating_add(scanned_files);
                        report(state.update(
                            format!(
                                "正在扫描第 {next_depth} 层输出：已检查 {scanned_files} 个文件，发现 {found_archives} 个归档。"
                            ),
                            next_depth,
                            &nested_output,
                        ));
                    },
                )?;
                pending.extend(
                    child_archives
                        .into_iter()
                        .map(|archive_path| NestedArchiveTask {
                            archive_path,
                            depth: next_depth,
                            inherited_password: child_password.clone(),
                        }),
                );
                report(state.update(
                    format!(
                        "已解开第 {} 层嵌套压缩包：{}。",
                        nested.depth,
                        archive_display_name(&nested.archive_path)
                    ),
                    nested.depth,
                    &nested.archive_path,
                ));
            }
            Ok(_) => {
                state.skipped_nested_archives = state.skipped_nested_archives.saturating_add(1);
                report(state.update(
                    format!(
                        "未找到嵌套压缩包 {} 的密码，已跳过。",
                        archive_display_name(&nested.archive_path)
                    ),
                    nested.depth,
                    &nested.archive_path,
                ));
            }
            Err(RecoveryError::Cancelled) => return Err(RecoveryError::Cancelled),
            Err(error) => {
                state.skipped_nested_archives = state.skipped_nested_archives.saturating_add(1);
                report(state.update(
                    format!(
                        "嵌套压缩包 {} 无法继续处理，已跳过：{error}",
                        archive_display_name(&nested.archive_path)
                    ),
                    nested.depth,
                    &nested.archive_path,
                ));
            }
        }
    }

    let mut summary = format!(
        "递归扫描完成，共检查 {} 个文件，已自动解开 {} 个嵌套压缩包",
        state.scanned_files, state.extracted_nested_archives
    );
    if state.skipped_nested_archives > 0 {
        summary.push_str(&format!("，跳过 {} 个", state.skipped_nested_archives));
    }
    if state.depth_limit_reached || state.count_limit_reached {
        summary.push_str("；已达到安全限制");
    }
    summary.push('。');
    root.message = format!("{} {summary}", root.message);

    Ok(RecursiveRecoveryResult {
        root,
        discovered_nested_archives: state.discovered_nested_archives,
        extracted_nested_archives: state.extracted_nested_archives,
        skipped_nested_archives: state.skipped_nested_archives,
        depth_limit_reached: state.depth_limit_reached,
        count_limit_reached: state.count_limit_reached,
        recovered_passwords,
        recovered_archives,
        scanned_files: state.scanned_files,
    })
}

fn capture_file_snapshot(
    directory: &Path,
    cancellation: &CancellationToken,
) -> Result<HashMap<PathBuf, FileSnapshot>, RecoveryError> {
    let mut snapshot = HashMap::new();
    visit_files(directory, cancellation, |path| {
        if let Some(state) = capture_file_state(&path) {
            snapshot.insert(path, state);
        }
        true
    })?;
    Ok(snapshot)
}

fn find_new_or_changed_archives(
    directory: &Path,
    before: &HashMap<PathBuf, FileSnapshot>,
    max_archives: usize,
    cancellation: &CancellationToken,
    mut report_progress: impl FnMut(u64, usize),
) -> Result<Vec<PathBuf>, RecoveryError> {
    if max_archives == 0 {
        return Ok(Vec::new());
    }
    let mut archives = Vec::with_capacity(max_archives.min(16));
    let mut scanned_files = 0u64;
    let mut last_reported = 0u64;
    let mut last_report_at = Instant::now();
    visit_files(directory, cancellation, |path| {
        scanned_files = scanned_files.saturating_add(1);
        if let Some(current) = capture_file_state(&path)
            && before
                .get(&path)
                .is_none_or(|previous| current.has_changed_since(previous))
            && detect_nested_archive_format(&path).is_ok()
        {
            archives.push(path);
        }
        if scanned_files == 1
            || scanned_files.is_multiple_of(SCAN_PROGRESS_INTERVAL_FILES)
            || last_report_at.elapsed() >= Duration::from_millis(250)
        {
            report_progress(scanned_files, archives.len());
            last_reported = scanned_files;
            last_report_at = Instant::now();
        }
        archives.len() < max_archives
    })?;
    if scanned_files != last_reported {
        report_progress(scanned_files, archives.len());
    }
    Ok(archives)
}

fn visit_files(
    directory: &Path,
    cancellation: &CancellationToken,
    mut visit: impl FnMut(PathBuf) -> bool,
) -> Result<(), RecoveryError> {
    if !directory.is_dir() {
        return Ok(());
    }
    let mut pending = vec![directory.to_path_buf()];
    while let Some(current) = pending.pop() {
        ensure_not_cancelled(cancellation)?;
        let entries = match fs::read_dir(current) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries {
            ensure_not_cancelled(cancellation)?;
            let Ok(entry) = entry else {
                continue;
            };
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                pending.push(entry.path());
            } else if file_type.is_file() && !visit(entry.path()) {
                return Ok(());
            }
        }
    }
    Ok(())
}

fn capture_file_state(path: &Path) -> Option<FileSnapshot> {
    let metadata = path.metadata().ok()?;
    Some(FileSnapshot {
        length: metadata.len(),
        modified: metadata.modified().ok(),
        created: metadata.created().ok(),
    })
}

fn resolve_nested_output_directory(archive_path: &Path) -> PathBuf {
    let parent = archive_path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = archive_display_name(archive_path);
    let output_name = if archive_path.extension().is_some() {
        archive_path
            .file_stem()
            .map(|name| name.to_string_lossy().into_owned())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| format!("{file_name}.extracted"))
    } else {
        format!("{file_name}.extracted")
    };
    resolve_available_nested_directory(&parent.join(output_name))
}

fn resolve_available_nested_directory(preferred: &Path) -> PathBuf {
    if !preferred.exists() {
        return preferred.to_path_buf();
    }
    let parent = preferred.parent().unwrap_or_else(|| Path::new("."));
    let base_name = preferred
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "archive.extracted".into());
    for suffix in 2..=9_999 {
        let candidate = parent.join(format!("{base_name} ({suffix})"));
        if !candidate.exists() {
            return candidate;
        }
    }
    parent.join(format!("{base_name}-{}", std::process::id()))
}

fn resolve_nested_staging_directory(destination: &Path) -> PathBuf {
    let parent = destination.parent().unwrap_or_else(|| Path::new("."));
    let base_name = destination
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "archive".into());
    let preferred = parent.join(format!(
        ".{base_name}.arcrecall-{}.partial",
        std::process::id()
    ));
    resolve_available_nested_directory(&preferred)
}

fn archive_display_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| path_for_display(path))
}

fn recover_single_archive(
    job: &RecoveryJob,
    tools: &RecoveryToolPaths,
    cancellation: &CancellationToken,
    compute_mode: RecoveryComputeMode,
    prepare_dictionary: &mut impl FnMut() -> Result<RecoveryDictionary, RecoveryError>,
    report: &mut impl FnMut(RecoveryUpdate),
) -> Result<RecoveryResult, RecoveryError> {
    validate_base_job_inputs(job, tools)?;
    let analysis = analyze_archive(&job.archive_path)?;
    fs::create_dir_all(&job.work_directory)?;
    let mut processing_job = job.clone();

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
        )?
        .ok_or_else(|| RecoveryError::Message("LZ4 临时归档准备失败。".into()))?;
    }

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
        extract_with_password(&processing_job, tools, "", cancellation, report)?;
        return Ok(attach_recovered_archive(
            success_result(&processing_job, None, "7-Zip", "归档无需密码，已直接解压。"),
            &analysis,
            &job.archive_path,
        ));
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
            extract_with_password(&processing_job, tools, password, cancellation, report)?;
            return Ok(attach_recovered_archive(
                success_result(
                    &processing_job,
                    Some(password.to_owned()),
                    "优先密码",
                    "优先密码验证通过，归档已解压。",
                ),
                &analysis,
                &job.archive_path,
            ));
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
        &dictionary_job,
        tools,
        analysis.format,
        cancellation,
        compute_mode,
        report,
    )?;
    Ok(attach_recovered_archive(
        result,
        &analysis,
        &job.archive_path,
    ))
}

fn recover_with_dictionary(
    job: &RecoveryJob,
    tools: &RecoveryToolPaths,
    format: ArchiveFormat,
    cancellation: &CancellationToken,
    compute_mode: RecoveryComputeMode,
    report: &mut impl FnMut(RecoveryUpdate),
) -> Result<RecoveryResult, RecoveryError> {
    let mut fallback_reasons = Vec::new();
    let records = if converter_is_available(tools, format) {
        report(RecoveryUpdate::stage(
            RecoveryPhase::Converting,
            Some(converter_name(format)),
            format!(
                "正在使用 {} 提取 {} 验密哈希。",
                converter_name(format),
                format.label()
            ),
        ));
        match extract_hashes(job, tools, format, cancellation) {
            Ok(records) if !records.is_empty() => Some(records),
            Ok(_) => {
                fallback_reasons.push(format!("{} 未生成可用哈希", converter_name(format)));
                None
            }
            Err(RecoveryError::Cancelled) => return Err(RecoveryError::Cancelled),
            Err(error) => {
                fallback_reasons.push(format!("{} 执行失败：{error}", converter_name(format)));
                None
            }
        }
    } else {
        fallback_reasons.push(format!("{} 不可用", converter_name(format)));
        None
    };

    let mut verified_candidates = HashSet::new();
    let mut hashcat_completed = false;
    let mut hashcat_attempted = false;
    if let Some(records) = records.as_ref() {
        if tools.hashcat.is_file() {
            let hashcat_probe = probe_hashcat_devices(&tools.hashcat);
            let device_plan = hashcat_device_plan(compute_mode, hashcat_probe.availability);
            if device_plan.is_empty() {
                fallback_reasons.push(hashcat_probe.unavailable_message(compute_mode));
            }
            for device in device_plan {
                let engine = device.engine_label();
                let mut device_completed = false;
                for (record_index, record) in records.iter().enumerate() {
                    ensure_not_cancelled(cancellation)?;
                    let hash_file = job
                        .work_directory
                        .join(format!("hashcat-{record_index}.hash"));
                    fs::write(&hash_file, format!("{}\n", record.hash))?;
                    let modes =
                        identify_hashcat_modes(&hash_file, &record.hash, tools, cancellation);
                    for mode in modes {
                        ensure_not_cancelled(cancellation)?;
                        report(RecoveryUpdate::stage(
                            RecoveryPhase::Hashcat,
                            Some(engine),
                            format!(
                                "{engine} 正在尝试模式 {mode}（{} 条候选）。",
                                job.dictionary_count
                            ),
                        ));
                        hashcat_attempted = true;
                        match run_hashcat(job, tools, &hash_file, mode, device, cancellation) {
                            Ok(attempt) => {
                                let completed = attempt == CrackAttempt::Exhausted;
                                device_completed |= completed;
                                hashcat_completed |= completed;
                                if let Some(result) = verify_crack_attempt(
                                    attempt,
                                    job,
                                    tools,
                                    cancellation,
                                    report,
                                    &mut verified_candidates,
                                    engine,
                                )? {
                                    return Ok(result);
                                }
                            }
                            Err(RecoveryError::Cancelled) => {
                                return Err(RecoveryError::Cancelled);
                            }
                            Err(error) => {
                                fallback_reasons.push(format!("{engine} 执行失败：{error}"));
                                break;
                            }
                        }
                    }
                }
                if device_completed {
                    break;
                }
            }
        } else {
            fallback_reasons.push("Hashcat 不可用".into());
        }
    }

    if hashcat_completed {
        return Ok(exhausted_result(
            job,
            "Hashcat 已完成当前字典，未命中密码。",
        ));
    }

    let mut john_completed = false;
    if let Some(records) = records.as_ref() {
        if tools.john_tools_directory.join("john.exe").is_file() {
            report(RecoveryUpdate::stage(
                RecoveryPhase::John,
                Some("John CPU"),
                if hashcat_attempted {
                    format!(
                        "Hashcat 未找到可用密码，正在用 John CPU 复跑 {} 条候选。",
                        job.dictionary_count
                    )
                } else {
                    format!("正在用 John CPU 尝试 {} 条候选。", job.dictionary_count)
                },
            ));
            match run_john(job, tools, records, cancellation) {
                Ok(attempt) => {
                    john_completed = attempt == CrackAttempt::Exhausted;
                    if let Some(result) = verify_crack_attempt(
                        attempt,
                        job,
                        tools,
                        cancellation,
                        report,
                        &mut verified_candidates,
                        "John CPU",
                    )? {
                        return Ok(result);
                    }
                }
                Err(RecoveryError::Cancelled) => return Err(RecoveryError::Cancelled),
                Err(error) => fallback_reasons.push(format!("John CPU 执行失败：{error}")),
            }
        } else {
            fallback_reasons.push("John CPU 不可用".into());
        }
    }

    if john_completed {
        return Ok(exhausted_result(
            job,
            "可用的外部恢复引擎已完成，当前字典未命中密码。",
        ));
    }

    let fallback_summary = if fallback_reasons.is_empty() {
        "外部引擎未能完成".to_owned()
    } else {
        fallback_reasons.join("；")
    };
    report(RecoveryUpdate::progress(
        RecoveryPhase::Internal,
        "7-Zip CPU",
        format!("{fallback_summary}。正在回退到兼容性更高的 7-Zip CPU 验密。"),
        0,
        job.dictionary_count,
    ));
    if let Some(result) =
        run_internal_dictionary(job, tools, cancellation, report, &verified_candidates)?
    {
        return Ok(result);
    }
    Ok(exhausted_result(
        job,
        "外部引擎不可用或未能完成，7-Zip CPU 兜底也未在当前字典中找到密码。",
    ))
}

fn validate_base_job_inputs(
    job: &RecoveryJob,
    tools: &RecoveryToolPaths,
) -> Result<(), RecoveryError> {
    if !tools.seven_zip.is_file() {
        return Err(RecoveryError::MissingTool(format!(
            "7-Zip（{}）",
            path_for_display(&tools.seven_zip)
        )));
    }
    if !job.archive_path.is_file() {
        return Err(RecoveryError::NotFound(path_for_display(&job.archive_path)));
    }
    Ok(())
}

fn validate_dictionary_input(job: &RecoveryJob) -> Result<(), RecoveryError> {
    if !job.dictionary_path.is_file() {
        return Err(RecoveryError::NotFound(path_for_display(
            &job.dictionary_path,
        )));
    }
    Ok(())
}

fn converter_is_available(tools: &RecoveryToolPaths, format: ArchiveFormat) -> bool {
    match format {
        ArchiveFormat::SevenZip => {
            tools.perl.is_file() && tools.john_tools_directory.join("7z2john.pl").is_file()
        }
        ArchiveFormat::Zip => tools.john_tools_directory.join("zip2john.exe").is_file(),
        ArchiveFormat::Rar3 | ArchiveFormat::Rar5 => {
            tools.john_tools_directory.join("rar2john.exe").is_file()
        }
    }
}

fn converter_name(format: ArchiveFormat) -> &'static str {
    match format {
        ArchiveFormat::SevenZip => "7z2john",
        ArchiveFormat::Zip => "zip2john",
        ArchiveFormat::Rar3 | ArchiveFormat::Rar5 => "rar2john",
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HashcatComputeDevice {
    Gpu,
    Cpu,
}

impl HashcatComputeDevice {
    const fn opencl_type(self) -> &'static str {
        match self {
            Self::Gpu => "2",
            Self::Cpu => "1",
        }
    }

    const fn engine_label(self) -> &'static str {
        match self {
            Self::Gpu => "Hashcat GPU",
            Self::Cpu => "Hashcat CPU",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct HashcatDeviceAvailability {
    gpu: bool,
    cpu: bool,
}

impl HashcatDeviceAvailability {
    const fn supports(self, device: HashcatComputeDevice) -> bool {
        match device {
            HashcatComputeDevice::Gpu => self.gpu,
            HashcatComputeDevice::Cpu => self.cpu,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct HashcatDeviceProbe {
    availability: HashcatDeviceAvailability,
    failure: Option<String>,
}

impl HashcatDeviceProbe {
    fn method_message(&self, device: HashcatComputeDevice) -> String {
        if self.availability.supports(device) {
            return match device {
                HashcatComputeDevice::Gpu => "Hashcat 已检测到可用的 GPU 计算设备。".to_owned(),
                HashcatComputeDevice::Cpu => {
                    "Hashcat 已检测到可用的 CPU OpenCL 计算设备。".to_owned()
                }
            };
        }
        if let Some(failure) = &self.failure {
            return failure.clone();
        }
        match device {
            HashcatComputeDevice::Gpu => "Hashcat 未检测到可用的 GPU 计算设备。".to_owned(),
            HashcatComputeDevice::Cpu => {
                "Hashcat 未检测到 CPU OpenCL；Hashcat CPU 是可选能力。".to_owned()
            }
        }
    }

    fn unavailable_message(&self, mode: RecoveryComputeMode) -> String {
        if let Some(failure) = &self.failure {
            return failure.clone();
        }
        match mode {
            RecoveryComputeMode::GpuPreferred => {
                "Hashcat 未检测到适用于当前模式的 GPU 或 CPU OpenCL 设备".to_owned()
            }
            RecoveryComputeMode::CpuOnly => {
                "Hashcat 未检测到 CPU OpenCL，已跳过可选的 Hashcat CPU".to_owned()
            }
        }
    }
}

fn hashcat_device_plan(
    mode: RecoveryComputeMode,
    availability: HashcatDeviceAvailability,
) -> Vec<HashcatComputeDevice> {
    const GPU_PREFERRED: [HashcatComputeDevice; 2] =
        [HashcatComputeDevice::Gpu, HashcatComputeDevice::Cpu];
    const CPU_ONLY: [HashcatComputeDevice; 1] = [HashcatComputeDevice::Cpu];
    let requested = match mode {
        RecoveryComputeMode::GpuPreferred => GPU_PREFERRED.as_slice(),
        RecoveryComputeMode::CpuOnly => CPU_ONLY.as_slice(),
    };
    requested
        .iter()
        .copied()
        .filter(|device| availability.supports(*device))
        .collect()
}

pub fn probe_recovery_capabilities(tools: &RecoveryToolPaths) -> RecoveryCapabilities {
    let hashcat_probe = probe_hashcat_devices(&tools.hashcat);
    let hashcat_gpu = hashcat_probe.availability.gpu;
    let hashcat_cpu = hashcat_probe.availability.cpu;
    let john_available = tools.john_tools_directory.join("john.exe").is_file();
    let seven_zip_available = tools.seven_zip.is_file();
    let cpu_available = hashcat_cpu || john_available || seven_zip_available;

    RecoveryCapabilities {
        gpu_available: hashcat_gpu,
        cpu_available,
        methods: vec![
            RecoveryMethodCapability {
                id: "hashcatGpu".into(),
                label: "Hashcat GPU".into(),
                device: RecoveryComputeDevice::Gpu,
                supported: true,
                available: hashcat_gpu,
                optional: false,
                message: hashcat_probe.method_message(HashcatComputeDevice::Gpu),
            },
            RecoveryMethodCapability {
                id: "hashcatCpu".into(),
                label: "Hashcat CPU".into(),
                device: RecoveryComputeDevice::Cpu,
                supported: true,
                available: hashcat_cpu,
                optional: true,
                message: hashcat_probe.method_message(HashcatComputeDevice::Cpu),
            },
            RecoveryMethodCapability {
                id: "johnCpu".into(),
                label: "John CPU".into(),
                device: RecoveryComputeDevice::Cpu,
                supported: true,
                available: john_available,
                optional: false,
                message: if john_available {
                    "John CPU 引擎已就绪。".into()
                } else {
                    "John CPU 引擎尚未安装。".into()
                },
            },
            RecoveryMethodCapability {
                id: "sevenZipCpu".into(),
                label: "7-Zip CPU".into(),
                device: RecoveryComputeDevice::Cpu,
                supported: true,
                available: seven_zip_available,
                optional: false,
                message: if seven_zip_available {
                    "7-Zip CPU 兼容验密已就绪。".into()
                } else {
                    "7-Zip CPU 引擎尚未安装。".into()
                },
            },
        ],
    }
}

fn probe_hashcat_devices(hashcat: &Path) -> HashcatDeviceProbe {
    if !hashcat.is_file() {
        return HashcatDeviceProbe {
            availability: HashcatDeviceAvailability::default(),
            failure: Some("Hashcat 尚未安装。".into()),
        };
    }
    let mut request = ProcessRequest::new(hashcat);
    request.args = vec![OsString::from("-I")];
    request.current_dir = hashcat.parent().map(Path::to_path_buf);
    request.timeout = Duration::from_secs(15);
    request.max_output_bytes = 512 * 1024;
    match run_process(&request, None) {
        Ok(output) => {
            let combined = format!("{}\n{}", output.stdout, output.stderr);
            let (gpu, cpu) = parse_hashcat_device_types(&combined);
            HashcatDeviceProbe {
                availability: HashcatDeviceAvailability { gpu, cpu },
                failure: None,
            }
        }
        Err(error) => HashcatDeviceProbe {
            availability: HashcatDeviceAvailability::default(),
            failure: Some(format!("Hashcat 计算设备探测失败：{error}")),
        },
    }
}

fn parse_hashcat_device_types(output: &str) -> (bool, bool) {
    let mut gpu = false;
    let mut cpu = false;
    for line in output.lines() {
        let Some((field, value)) = line.split_once(':') else {
            continue;
        };
        let field = field.trim().trim_end_matches('.').to_ascii_lowercase();
        if field != "type" {
            continue;
        }
        let value = value.trim().to_ascii_lowercase();
        gpu |= value.split_whitespace().any(|part| part == "gpu");
        cpu |= value.split_whitespace().any(|part| part == "cpu");
    }
    (gpu, cpu)
}

fn run_internal_dictionary(
    job: &RecoveryJob,
    tools: &RecoveryToolPaths,
    cancellation: &CancellationToken,
    report: &mut impl FnMut(RecoveryUpdate),
    already_verified: &HashSet<String>,
) -> Result<Option<RecoveryResult>, RecoveryError> {
    let file = fs::File::open(&job.dictionary_path)?;
    let mut reader = BufReader::with_capacity(64 * 1024, file);
    let mut line = String::new();
    let mut attempted = 0u64;
    let mut last_reported = 0u64;
    let mut last_report_at = Instant::now();

    loop {
        ensure_not_cancelled(cancellation)?;
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            break;
        }
        if line.ends_with('\n') {
            line.pop();
            if line.ends_with('\r') {
                line.pop();
            }
        }
        if line.is_empty() {
            continue;
        }

        attempted = attempted.saturating_add(1);
        if attempted == 1 || last_report_at.elapsed() >= Duration::from_millis(250) {
            report(RecoveryUpdate::progress(
                RecoveryPhase::Internal,
                "7-Zip CPU",
                format!(
                    "7-Zip CPU 正在逐条验密：{} / {}。",
                    attempted, job.dictionary_count
                ),
                attempted,
                job.dictionary_count,
            ));
            last_reported = attempted;
            last_report_at = Instant::now();
        }

        if already_verified.contains(&line) {
            continue;
        }
        if verify_password(&job.archive_path, &line, tools, cancellation)? {
            extract_with_password(job, tools, &line, cancellation, report)?;
            return Ok(Some(success_result(
                job,
                Some(line.clone()),
                "7-Zip CPU",
                "7-Zip CPU 兜底找到的密码已通过复验并完成解压。",
            )));
        }
    }

    if attempted != last_reported {
        report(RecoveryUpdate::progress(
            RecoveryPhase::Internal,
            "7-Zip CPU",
            format!(
                "7-Zip CPU 已完成逐条验密：{} / {}。",
                attempted, job.dictionary_count
            ),
            attempted,
            job.dictionary_count,
        ));
    }
    Ok(None)
}

fn extract_hashes(
    job: &RecoveryJob,
    tools: &RecoveryToolPaths,
    format: ArchiveFormat,
    cancellation: &CancellationToken,
) -> Result<Vec<HashRecord>, RecoveryError> {
    let john_dir = &tools.john_tools_directory;
    let (program, args) = match format {
        ArchiveFormat::SevenZip => (
            tools.perl.clone(),
            vec![
                john_dir.join("7z2john.pl").into_os_string(),
                job.archive_path.as_os_str().to_owned(),
            ],
        ),
        ArchiveFormat::Zip => (
            john_dir.join("zip2john.exe"),
            vec![job.archive_path.as_os_str().to_owned()],
        ),
        ArchiveFormat::Rar3 | ArchiveFormat::Rar5 => (
            john_dir.join("rar2john.exe"),
            vec![job.archive_path.as_os_str().to_owned()],
        ),
    };
    if !program.is_file() {
        return Err(RecoveryError::MissingTool(path_for_display(&program)));
    }

    let mut request = ProcessRequest::new(program);
    request.args = args;
    request.current_dir = Some(john_dir.clone());
    if matches!(format, ArchiveFormat::SevenZip) {
        // Portable Strawberry needs c\bin (liblzma) on PATH for Compress::Raw::Lzma.
        request.path_prepend = strawberry_perl_path_entries(&tools.perl);
    }
    request.timeout = Duration::from_secs(10 * 60);
    request.max_output_bytes = 16 * 1024 * 1024;
    let output = run_checked(&request, cancellation)?;
    if !output.success && output.stdout.trim().is_empty() {
        return Err(process_failure(converter_name(format), &output));
    }
    Ok(parse_hash_records(&output.stdout))
}

fn identify_hashcat_modes(
    hash_file: &Path,
    hash: &str,
    tools: &RecoveryToolPaths,
    cancellation: &CancellationToken,
) -> Vec<u32> {
    let mut request = ProcessRequest::new(&tools.hashcat);
    request.args = vec![
        OsString::from("--identify"),
        hash_file.as_os_str().to_owned(),
    ];
    request.current_dir = tools.hashcat.parent().map(Path::to_path_buf);
    request.timeout = Duration::from_secs(30);
    request.max_output_bytes = 1024 * 1024;

    let mut modes = Vec::new();
    if let Ok(output) = run_process(&request, Some(cancellation)) {
        for line in output.stdout.lines().chain(output.stderr.lines()) {
            let Some(left) = line.split('|').next() else {
                continue;
            };
            if let Ok(mode) = left.trim().parse::<u32>()
                && HASHCAT_ARCHIVE_MODES.contains(&mode)
                && !modes.contains(&mode)
            {
                modes.push(mode);
            }
        }
    }
    for mode in fallback_hashcat_modes(hash) {
        if !modes.contains(&mode) {
            modes.push(mode);
        }
    }
    modes
}

fn fallback_hashcat_modes(hash: &str) -> Vec<u32> {
    if hash.starts_with("$7z$") {
        vec![11600]
    } else if hash.starts_with("$rar5$") {
        vec![13000]
    } else if hash.starts_with("$RAR3$*0*") {
        vec![12500]
    } else if hash.starts_with("$RAR3$*1*") {
        vec![23700, 23800]
    } else if hash.starts_with("$zip2$") {
        vec![13600]
    } else if hash.starts_with("$pkzip2$") {
        vec![17200, 17210, 17220, 17225, 17230, 17240, 17250]
    } else {
        Vec::new()
    }
}

fn run_hashcat(
    job: &RecoveryJob,
    tools: &RecoveryToolPaths,
    hash_file: &Path,
    mode: u32,
    device: HashcatComputeDevice,
    cancellation: &CancellationToken,
) -> Result<CrackAttempt, RecoveryError> {
    let output_file = job
        .work_directory
        .join(format!("hashcat-{mode}-{}.found", device.opencl_type()));
    let _ = fs::remove_file(&output_file);
    let mut request = ProcessRequest::new(&tools.hashcat);
    request.args = vec![
        OsString::from("-m"),
        OsString::from(mode.to_string()),
        OsString::from("-a"),
        OsString::from("0"),
        OsString::from("-D"),
        OsString::from(device.opencl_type()),
        OsString::from("--status"),
        OsString::from("--status-json"),
        OsString::from("--status-timer"),
        OsString::from("1"),
        OsString::from("--potfile-disable"),
        OsString::from("--restore-disable"),
        OsString::from("--outfile"),
        output_file.as_os_str().to_owned(),
        OsString::from("--outfile-format"),
        OsString::from("2"),
        hash_file.as_os_str().to_owned(),
        job.dictionary_path.as_os_str().to_owned(),
    ];
    request.current_dir = tools.hashcat.parent().map(Path::to_path_buf);
    request.timeout = Duration::from_secs(7 * 24 * 60 * 60);
    request.max_output_bytes = 8 * 1024 * 1024;

    let output = run_checked(&request, cancellation)?;
    if output_file.is_file()
        && let Some(password) = read_first_password(&output_file)?
    {
        return Ok(CrackAttempt::Found(password));
    }
    Ok(match output.exit_code {
        Some(1) => CrackAttempt::Exhausted,
        _ => CrackAttempt::Failed,
    })
}

fn run_john(
    job: &RecoveryJob,
    tools: &RecoveryToolPaths,
    records: &[HashRecord],
    cancellation: &CancellationToken,
) -> Result<CrackAttempt, RecoveryError> {
    let hash_file = job.work_directory.join("john.hash");
    let pot_file = job.work_directory.join("john.pot");
    let session_file = job.work_directory.join("john-session");
    let content = records
        .iter()
        .map(|record| record.john_line.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    fs::write(&hash_file, format!("{content}\n"))?;
    let _ = fs::remove_file(&pot_file);

    let john = tools.john_tools_directory.join("john.exe");
    let mut request = ProcessRequest::new(john);
    request.args = vec![
        OsString::from(format!("--wordlist={}", job.dictionary_path.display())),
        OsString::from(format!("--pot={}", pot_file.display())),
        OsString::from(format!("--session={}", session_file.display())),
        OsString::from("--nolog"),
        hash_file.as_os_str().to_owned(),
    ];
    request.current_dir = Some(tools.john_tools_directory.clone());
    request.timeout = Duration::from_secs(7 * 24 * 60 * 60);
    request.max_output_bytes = 8 * 1024 * 1024;
    let output = run_checked(&request, cancellation)?;

    if pot_file.is_file() {
        let pot = fs::read_to_string(&pot_file)?;
        let hashes: Vec<_> = records.iter().map(|record| record.hash.as_str()).collect();
        for line in pot.lines() {
            if let Some(password) = password_from_pot_line(line, &hashes) {
                return Ok(CrackAttempt::Found(password));
            }
        }
    }
    Ok(if output.success {
        CrackAttempt::Exhausted
    } else {
        CrackAttempt::Failed
    })
}

fn verify_crack_attempt(
    attempt: CrackAttempt,
    job: &RecoveryJob,
    tools: &RecoveryToolPaths,
    cancellation: &CancellationToken,
    report: &mut impl FnMut(RecoveryUpdate),
    verified_candidates: &mut HashSet<String>,
    engine: &str,
) -> Result<Option<RecoveryResult>, RecoveryError> {
    let CrackAttempt::Found(password) = attempt else {
        return Ok(None);
    };
    if !verified_candidates.insert(password.clone()) {
        return Ok(None);
    }

    report(RecoveryUpdate::stage(
        RecoveryPhase::Verifying,
        Some("7-Zip"),
        format!("{engine} 已找到候选密码，正在用 7-Zip 复验。"),
    ));
    if !verify_password(&job.archive_path, &password, tools, cancellation)? {
        return Ok(None);
    }
    extract_with_password(job, tools, &password, cancellation, report)?;
    Ok(Some(success_result(
        job,
        Some(password),
        engine,
        &format!("{engine} 找到的密码已通过 7-Zip 复验并完成解压。"),
    )))
}

/// Build the 7-Zip `-p{Password}` switch as a single argv entry.
///
/// 7-Zip 26.x does **not** read the password from stdin when given a bare `-p`
/// (it expects a console prompt via ReadConsole). Piping the secret therefore
/// fails under `CREATE_NO_WINDOW` / redirected stdio. Embedding the password in
/// the switch is the only reliable non-interactive interface on Windows.
fn seven_zip_password_arg(password: &str) -> OsString {
    let mut arg = OsString::from("-p");
    arg.push(password);
    arg
}

fn validate_archive_container(
    archive: &Path,
    expected_format: ArchiveFormat,
    tools: &RecoveryToolPaths,
    cancellation: &CancellationToken,
) -> Result<(), RecoveryError> {
    let mut request = ProcessRequest::new(&tools.seven_zip);
    request.args = vec![
        OsString::from("l"),
        OsString::from("-slt"),
        OsString::from("-y"),
        OsString::from("-bd"),
        OsString::from("-p__arcrecall_probe__"),
        archive.as_os_str().to_owned(),
    ];
    request.current_dir = tools.seven_zip.parent().map(Path::to_path_buf);
    request.timeout = Duration::from_secs(2 * 60);
    request.max_output_bytes = 1024 * 1024;
    let output = run_checked(&request, cancellation)?;
    let detected_types = seven_zip_archive_types(&output);

    if detected_types
        .iter()
        .any(|detected| archive_type_matches(expected_format, detected))
        || (detected_types.is_empty() && is_password_rejection(&output))
    {
        return Ok(());
    }

    if !detected_types.is_empty() {
        return Err(RecoveryError::InvalidArchive(format!(
            "7-Zip 将候选识别为 {}，不是受支持的 {} 归档",
            detected_types.join(" / "),
            expected_format.label()
        )));
    }
    Err(RecoveryError::InvalidArchive(process_failure_detail(
        &output,
    )))
}

fn seven_zip_archive_types(output: &ProcessOutput) -> Vec<String> {
    output
        .stdout
        .lines()
        .chain(output.stderr.lines())
        .filter_map(|line| {
            line.trim()
                .strip_prefix("Type = ")
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        })
        .collect()
}

fn archive_type_matches(format: ArchiveFormat, detected: &str) -> bool {
    match format {
        ArchiveFormat::SevenZip => detected.eq_ignore_ascii_case("7z"),
        ArchiveFormat::Zip => detected.eq_ignore_ascii_case("zip"),
        ArchiveFormat::Rar3 | ArchiveFormat::Rar5 => detected
            .get(..3)
            .is_some_and(|value| value.eq_ignore_ascii_case("rar")),
    }
}

fn verify_password(
    archive: &Path,
    password: &str,
    tools: &RecoveryToolPaths,
    cancellation: &CancellationToken,
) -> Result<bool, RecoveryError> {
    let mut request = ProcessRequest::new(&tools.seven_zip);
    request.args = vec![
        OsString::from("t"),
        OsString::from("-y"),
        OsString::from("-bd"),
        OsString::from("-bso0"),
        seven_zip_password_arg(password),
        archive.as_os_str().to_owned(),
    ];
    request.current_dir = tools.seven_zip.parent().map(Path::to_path_buf);
    request.timeout = Duration::from_secs(5 * 60);
    request.max_output_bytes = 1024 * 1024;
    let output = run_checked(&request, cancellation)?;
    if output.success {
        return Ok(true);
    }
    if is_password_rejection(&output) {
        return Ok(false);
    }
    Err(RecoveryError::InvalidArchive(process_failure_detail(
        &output,
    )))
}

fn extract_with_password(
    job: &RecoveryJob,
    tools: &RecoveryToolPaths,
    password: &str,
    cancellation: &CancellationToken,
    report: &mut impl FnMut(RecoveryUpdate),
) -> Result<(), RecoveryError> {
    ensure_not_cancelled(cancellation)?;
    report(RecoveryUpdate::stage(
        RecoveryPhase::Extracting,
        Some("7-Zip"),
        format!(
            "正在安全解压到 {}。",
            path_for_display(&job.output_directory)
        ),
    ));
    fs::create_dir_all(&job.output_directory)?;
    let mut request = ProcessRequest::new(&tools.seven_zip);
    request.args = vec![
        OsString::from("x"),
        OsString::from("-y"),
        // Rename incoming files on collision instead of silently overwriting
        // anything already present in a custom output directory.
        OsString::from("-aou"),
        OsString::from("-bd"),
        OsString::from("-bso0"),
        seven_zip_password_arg(password),
        OsString::from(format!("-o{}", job.output_directory.display())),
        job.archive_path.as_os_str().to_owned(),
    ];
    request.current_dir = tools.seven_zip.parent().map(Path::to_path_buf);
    request.timeout = Duration::from_secs(24 * 60 * 60);
    request.max_output_bytes = 4 * 1024 * 1024;
    let output = run_checked(&request, cancellation)?;
    if !output.success {
        return Err(process_failure("7-Zip 解压", &output));
    }
    Ok(())
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
    archive_path: &Path,
) -> RecoveryResult {
    if result.success {
        result.recovered_archive =
            fingerprint_file_sha256(archive_path)
                .ok()
                .map(|fingerprint_sha256| RecoveredArchive {
                    fingerprint_sha256,
                    archive_format: analysis.format,
                    file_size: analysis.file_size,
                    volume_count: 1,
                    password: result.password.clone().filter(|value| !value.is_empty()),
                });
    }
    result
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

fn parse_hash_records(output: &str) -> Vec<HashRecord> {
    let mut records = Vec::new();
    let mut seen = HashSet::new();
    for line in output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        // rar2john prints diagnostics such as "! WARNING ..." on stdout.
        .filter(|line| !line.starts_with('!'))
    {
        let Some(hash) = extract_hash(line) else {
            continue;
        };
        if seen.insert(hash.clone()) {
            records.push(HashRecord {
                // Rebuild the john line so Windows absolute paths (drive letters
                // contain `:`) never sit in the leading label field. John splits
                // on `:` and would otherwise report "No password hashes loaded".
                john_line: normalize_john_line(line, &hash),
                hash,
            });
        }
    }
    records
}

/// Keep john's trailing GECOS fields, but replace any leading path label with a
/// colon-free name so `F:\...` archive paths do not break field parsing.
fn normalize_john_line(line: &str, hash: &str) -> String {
    let hash_at = line.find(hash).unwrap_or(0);
    let suffix = &line[hash_at + hash.len()..];
    format!("archive:{hash}{suffix}")
}

fn extract_hash(line: &str) -> Option<String> {
    for marker in ["$7z$", "$rar5$", "$RAR3$"] {
        if let Some(index) = line.find(marker) {
            let tail = &line[index..];
            let end = tail
                .find(|character: char| character == ':' || character.is_whitespace())
                .unwrap_or(tail.len());
            return Some(tail[..end].to_owned());
        }
    }
    for (marker, ending) in [("$pkzip2$", "$/pkzip2$"), ("$zip2$", "$/zip2$")] {
        if let Some(index) = line.find(marker) {
            let tail = &line[index..];
            let end = tail.find(ending)? + ending.len();
            return Some(tail[..end].to_owned());
        }
    }
    None
}

fn read_first_password(path: &Path) -> Result<Option<String>, RecoveryError> {
    let content = fs::read_to_string(path)?;
    Ok(content.lines().next().and_then(decode_password))
}

fn password_from_pot_line(line: &str, hashes: &[&str]) -> Option<String> {
    for hash in hashes {
        let prefix = format!("{hash}:");
        if let Some(value) = line.strip_prefix(&prefix) {
            return decode_password(value);
        }
    }
    None
}

fn decode_password(value: &str) -> Option<String> {
    if let Some(hex_value) = value
        .strip_prefix("$HEX[")
        .and_then(|tail| tail.strip_suffix(']'))
        .or_else(|| value.strip_prefix("$HEX$"))
    {
        let bytes = hex::decode(hex_value).ok()?;
        String::from_utf8(bytes).ok()
    } else {
        Some(value.to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashcat_plan_only_selects_available_devices() {
        let both = HashcatDeviceAvailability {
            gpu: true,
            cpu: true,
        };
        assert_eq!(
            hashcat_device_plan(RecoveryComputeMode::GpuPreferred, both),
            [HashcatComputeDevice::Gpu, HashcatComputeDevice::Cpu]
        );
        assert_eq!(
            hashcat_device_plan(RecoveryComputeMode::CpuOnly, both),
            [HashcatComputeDevice::Cpu]
        );

        let gpu_only = HashcatDeviceAvailability {
            gpu: true,
            cpu: false,
        };
        assert_eq!(
            hashcat_device_plan(RecoveryComputeMode::GpuPreferred, gpu_only),
            [HashcatComputeDevice::Gpu]
        );
        assert!(hashcat_device_plan(RecoveryComputeMode::CpuOnly, gpu_only).is_empty());

        let cpu_only = HashcatDeviceAvailability {
            gpu: false,
            cpu: true,
        };
        assert_eq!(
            hashcat_device_plan(RecoveryComputeMode::GpuPreferred, cpu_only),
            [HashcatComputeDevice::Cpu]
        );
        assert_eq!(
            hashcat_device_plan(RecoveryComputeMode::CpuOnly, cpu_only),
            [HashcatComputeDevice::Cpu]
        );

        let none = HashcatDeviceAvailability::default();
        assert!(hashcat_device_plan(RecoveryComputeMode::GpuPreferred, none).is_empty());
        assert!(hashcat_device_plan(RecoveryComputeMode::CpuOnly, none).is_empty());
    }

    #[test]
    fn parses_hashcat_device_types_from_backend_info() {
        let output = r#"
Device ID #1
  Type...........: GPU
Device ID #2
  Type...........: CPU
"#;
        assert_eq!(parse_hashcat_device_types(output), (true, true));
        assert_eq!(
            parse_hashcat_device_types("Type...........: GPU"),
            (true, false)
        );
        assert_eq!(parse_hashcat_device_types("no devices"), (false, false));
    }

    #[test]
    fn signature_detection_does_not_depend_on_extension() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("without-extension");
        fs::write(&path, [0u8, 1, 2, 0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]).unwrap();

        assert_eq!(
            detect_archive_format(&path).unwrap(),
            ArchiveFormat::SevenZip
        );
    }

    #[test]
    fn detects_and_materializes_lz4_wrapped_archive() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("inner.rar");
        let wrapped = dir.path().join("renamed.lz4");
        let work_directory = dir.path().join("work");
        let mut contents = RAR5_SIGNATURE.to_vec();
        contents.extend_from_slice(b"arc-recall-lz4-fixture");
        fs::write(&archive, &contents).unwrap();
        write_lz4_frame(&archive, &wrapped);
        fs::create_dir_all(&work_directory).unwrap();

        assert_eq!(
            detect_archive_format(&wrapped).unwrap(),
            ArchiveFormat::Rar5
        );
        let normalized = materialize_lz4_archive(
            &wrapped,
            ArchiveFormat::Rar5,
            &work_directory,
            &CancellationToken::default(),
        )
        .unwrap()
        .expect("LZ4 wrapper should be materialized");

        assert_eq!(
            normalized.extension().and_then(|value| value.to_str()),
            Some("rar")
        );
        assert_eq!(fs::read(normalized).unwrap(), contents);
    }

    #[test]
    fn cancelled_lz4_materialization_removes_partial_output() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("inner.rar");
        let wrapped = dir.path().join("wrapped.lz4");
        let work_directory = dir.path().join("work");
        fs::write(&archive, RAR5_SIGNATURE).unwrap();
        write_lz4_frame(&archive, &wrapped);
        fs::create_dir_all(&work_directory).unwrap();
        let cancellation = CancellationToken::default();
        cancellation.cancel();

        assert!(matches!(
            materialize_lz4_archive(
                &wrapped,
                ArchiveFormat::Rar5,
                &work_directory,
                &cancellation,
            ),
            Err(RecoveryError::Cancelled)
        ));
        assert!(!work_directory.join("lz4-decoded.partial").exists());
        assert!(!work_directory.join("lz4-decoded.rar").exists());
    }

    #[test]
    fn content_fingerprint_is_stable_after_rename() {
        let directory = tempfile::tempdir().unwrap();
        let original = directory.path().join("original.bin");
        let renamed = directory.path().join("renamed.jpg");
        fs::write(&original, b"arc-recall fingerprint fixture").unwrap();

        let before = fingerprint_file_sha256(&original).unwrap();
        fs::rename(&original, &renamed).unwrap();
        let after = fingerprint_file_sha256(&renamed).unwrap();

        assert_eq!(before, after);
        assert_eq!(before.len(), 64);
    }

    #[test]
    fn large_file_fingerprint_reads_only_bounded_samples() {
        let file_size = 8 * 1024 * 1024 * 1024u64;
        let ranges = fingerprint_sample_ranges(file_size);

        assert_eq!(ranges.len(), FINGERPRINT_SAMPLE_COUNT as usize);
        assert_eq!(ranges.first().map(|range| range.0), Some(0));
        assert_eq!(
            ranges.last().map(|range| range.0),
            Some(file_size - FINGERPRINT_SAMPLE_SIZE)
        );
        assert!(
            ranges.iter().map(|range| range.1 as u64).sum::<u64>()
                <= FINGERPRINT_SAMPLE_COUNT * FINGERPRINT_SAMPLE_SIZE
        );
    }

    #[test]
    fn sampled_fingerprint_changes_when_a_sample_changes() {
        let directory = tempfile::tempdir().unwrap();
        let first = directory.path().join("first.bin");
        let second = directory.path().join("second.bin");
        let mut contents = vec![0u8; (2 * 1024 * 1024) as usize];
        fs::write(&first, &contents).unwrap();
        let sample_offset = fingerprint_sample_ranges(contents.len() as u64)[2].0 as usize;
        contents[sample_offset] = 1;
        fs::write(&second, &contents).unwrap();

        assert_ne!(
            fingerprint_file_sha256(&first).unwrap(),
            fingerprint_file_sha256(&second).unwrap()
        );
    }

    #[test]
    fn nested_detection_is_content_driven_and_ignores_extensions() {
        let dir = tempfile::tempdir().unwrap();
        let mut carrier = vec![0u8; 256 * 1024];
        carrier[..4].copy_from_slice(b"\xff\xd8\xff\xe0");
        let signature_offset = 128 * 1024;
        carrier[signature_offset..signature_offset + SEVEN_ZIP_SIGNATURE.len()]
            .copy_from_slice(SEVEN_ZIP_SIGNATURE);

        let image_path = dir.path().join("carrier.unexpected-suffix");
        fs::write(&image_path, &carrier).unwrap();
        assert_eq!(
            detect_nested_archive_format(&image_path).unwrap(),
            ArchiveFormat::SevenZip
        );

        let mut arbitrary_prefix = vec![0u8; 64 * 1024];
        arbitrary_prefix[32 * 1024..32 * 1024 + SEVEN_ZIP_SIGNATURE.len()]
            .copy_from_slice(SEVEN_ZIP_SIGNATURE);
        let arbitrary_path = dir.path().join("asset.rpgmvp");
        fs::write(&arbitrary_path, arbitrary_prefix).unwrap();
        assert!(matches!(
            detect_nested_archive_format(&arbitrary_path),
            Err(RecoveryError::UnsupportedFormat)
        ));

        let mut pe = minimal_pe_fixture();
        pe[4 * 1024..4 * 1024 + ZIP_SIGNATURES[0].len()].copy_from_slice(ZIP_SIGNATURES[0]);
        let dll_path = dir.path().join("MonoPosixHelper.dll");
        fs::write(&dll_path, &pe).unwrap();
        assert!(matches!(
            detect_nested_archive_format(&dll_path),
            Err(RecoveryError::UnsupportedFormat)
        ));

        pe.extend_from_slice(SEVEN_ZIP_SIGNATURE);
        let sfx_path = dir.path().join("self-extracting.exe");
        fs::write(&sfx_path, pe).unwrap();
        assert_eq!(
            detect_nested_archive_format(&sfx_path).unwrap(),
            ArchiveFormat::SevenZip
        );

        for file_name in [
            "test.jpg",
            "test.png",
            "test.pdf",
            "test",
            "test.anything",
            "test.7z.jpg",
            "test.7z11",
            "test.7z.1",
        ] {
            let renamed_archive_path = dir.path().join(file_name);
            fs::write(&renamed_archive_path, SEVEN_ZIP_SIGNATURE).unwrap();
            assert_eq!(
                detect_nested_archive_format(&renamed_archive_path).unwrap(),
                ArchiveFormat::SevenZip,
                "failed to detect {file_name}"
            );
        }
    }

    #[test]
    fn nested_output_transaction_publishes_only_after_commit() {
        let dir = tempfile::tempdir().unwrap();
        let destination = dir.path().join("nested-output");
        let mut transaction = NestedOutputTransaction::new(destination.clone());
        fs::create_dir_all(transaction.staging_directory()).unwrap();
        fs::write(transaction.staging_directory().join("payload.txt"), b"ok").unwrap();

        assert!(!destination.exists());
        transaction.commit().unwrap();
        assert_eq!(
            fs::read_to_string(destination.join("payload.txt")).unwrap(),
            "ok"
        );
    }

    #[test]
    fn nested_output_transaction_removes_uncommitted_staging() {
        let dir = tempfile::tempdir().unwrap();
        let destination = dir.path().join("nested-output");
        let staging = {
            let transaction = NestedOutputTransaction::new(destination.clone());
            let staging = transaction.staging_directory().to_path_buf();
            fs::create_dir_all(&staging).unwrap();
            fs::write(staging.join("partial.txt"), b"partial").unwrap();
            staging
        };

        assert!(!staging.exists());
        assert!(!destination.exists());
    }

    #[test]
    fn user_facing_paths_hide_windows_verbatim_prefixes() {
        assert_eq!(
            path_for_display(Path::new(r"\\?\F:\Download\archive.7z")),
            r"F:\Download\archive.7z"
        );
        assert_eq!(
            path_for_display(Path::new(r"\\?\UNC\server\share\archive.7z")),
            r"\\server\share\archive.7z"
        );
        assert_eq!(
            path_for_display(Path::new(r"F:\Download\archive.7z")),
            r"F:\Download\archive.7z"
        );
    }

    #[test]
    fn parses_all_supported_john_hash_families() {
        let output = concat!(
            "a.7z:$7z$0$19$0$abc:meta\n",
            "b.rar:$rar5$16$aaa$15$bbb\n",
            "c.rar:$RAR3$*0*abc:0::::\n",
            "d.zip:$pkzip2$1*2*3$/pkzip2$::::\n",
            "e.zip:$zip2$*0*3*abc$/zip2$:meta\n"
        );

        let records = parse_hash_records(output);

        assert_eq!(records.len(), 5);
        assert_eq!(records[0].hash, "$7z$0$19$0$abc");
        assert_eq!(records[0].john_line, "archive:$7z$0$19$0$abc:meta");
        assert_eq!(records[1].hash, "$rar5$16$aaa$15$bbb");
        assert_eq!(records[1].john_line, "archive:$rar5$16$aaa$15$bbb");
        assert_eq!(records[2].hash, "$RAR3$*0*abc");
        assert_eq!(records[2].john_line, "archive:$RAR3$*0*abc:0::::");
        assert_eq!(records[3].hash, "$pkzip2$1*2*3$/pkzip2$");
        assert_eq!(records[4].hash, "$zip2$*0*3*abc$/zip2$");
    }

    #[test]
    fn normalizes_windows_drive_paths_out_of_john_labels() {
        let line = r"F:\data\sample.rar:$rar5$16$aaa$15$bbb$8$ccc";
        let records = parse_hash_records(line);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].hash, "$rar5$16$aaa$15$bbb$8$ccc");
        assert_eq!(records[0].john_line, "archive:$rar5$16$aaa$15$bbb$8$ccc");
        assert!(!records[0].john_line.contains(r"F:\"));
    }

    #[test]
    fn fallback_modes_cover_7z_zip_rar3_and_rar5() {
        assert_eq!(fallback_hashcat_modes("$7z$abc"), [11600]);
        assert_eq!(fallback_hashcat_modes("$rar5$abc"), [13000]);
        assert_eq!(fallback_hashcat_modes("$RAR3$*0*abc"), [12500]);
        assert_eq!(fallback_hashcat_modes("$RAR3$*1*abc"), [23700, 23800]);
        assert_eq!(fallback_hashcat_modes("$zip2$abc"), [13600]);
        assert_eq!(
            fallback_hashcat_modes("$pkzip2$abc"),
            [17200, 17210, 17220, 17225, 17230, 17240, 17250]
        );
    }

    #[test]
    fn decodes_hashcat_and_john_hex_passwords() {
        assert_eq!(decode_password("$HEX[70c3a47373]"), Some("päss".to_owned()));
        assert_eq!(decode_password("$HEX$70c3a47373"), Some("päss".to_owned()));
    }

    #[test]
    fn seven_zip_password_arg_embeds_secret_in_single_switch() {
        assert_eq!(
            seven_zip_password_arg("secret123"),
            OsString::from("-psecret123")
        );
        assert_eq!(seven_zip_password_arg(""), OsString::from("-p"));
        assert_eq!(
            seven_zip_password_arg("p@ss word!#%"),
            OsString::from("-pp@ss word!#%")
        );
    }

    #[test]
    fn seven_zip_diagnostics_distinguish_wrong_password_from_broken_archive() {
        let wrong_password = ProcessOutput {
            exit_code: Some(2),
            success: false,
            stdout: String::new(),
            stderr: "Cannot open encrypted archive. Wrong password?".into(),
            stdout_truncated: false,
            stderr_truncated: false,
        };
        let broken_archive = ProcessOutput {
            exit_code: Some(2),
            success: false,
            stdout: String::new(),
            stderr: "Unexpected end of archive".into(),
            stdout_truncated: false,
            stderr_truncated: false,
        };

        assert!(is_password_rejection(&wrong_password));
        assert!(!is_password_rejection(&broken_archive));
    }

    #[test]
    fn seven_zip_type_probe_rejects_pe_and_accepts_supported_archives() {
        let pe = ProcessOutput {
            exit_code: Some(0),
            success: true,
            stdout: "Path = helper.dll\nType = PE\nPhysical Size = 780288\n".into(),
            stderr: String::new(),
            stdout_truncated: false,
            stderr_truncated: false,
        };
        let archives = ProcessOutput {
            exit_code: Some(0),
            success: true,
            stdout: "Type = 7z\nType = zip\nType = Rar5\n".into(),
            stderr: String::new(),
            stdout_truncated: false,
            stderr_truncated: false,
        };

        assert_eq!(seven_zip_archive_types(&pe), ["PE"]);
        assert!(!archive_type_matches(ArchiveFormat::Zip, "PE"));
        assert!(archive_type_matches(ArchiveFormat::SevenZip, "7z"));
        assert!(archive_type_matches(ArchiveFormat::Zip, "zip"));
        assert!(archive_type_matches(ArchiveFormat::Rar5, "Rar5"));
        assert_eq!(seven_zip_archive_types(&archives), ["7z", "zip", "Rar5"]);
    }

    /// Real 7-Zip CLI checks. Skipped when no 7z.exe is available.
    #[test]
    fn seven_zip_verifies_and_extracts_encrypted_7z_and_zip() {
        let Some(seven_zip) = locate_seven_zip() else {
            eprintln!("skip: 7z.exe not found");
            return;
        };

        let dir = tempfile::tempdir().unwrap();
        let payload = dir.path().join("payload.txt");
        fs::write(&payload, b"arc-recall-payload").unwrap();
        let password = "s3cret-pass!";
        let tools = RecoveryToolPaths {
            seven_zip: seven_zip.clone(),
            hashcat: PathBuf::from("hashcat-not-required"),
            john_tools_directory: PathBuf::from("john-not-required"),
            perl: PathBuf::from("perl-not-required"),
        };
        let cancellation = CancellationToken::default();

        for (name, format_flag) in [("enc.7z", "-t7z"), ("enc.zip", "-tzip")] {
            let archive = dir.path().join(name);
            create_encrypted_archive(&seven_zip, format_flag, password, &archive, &payload);

            assert!(
                verify_password(&archive, password, &tools, &cancellation).unwrap(),
                "{name}: correct password should verify"
            );
            assert!(
                !verify_password(&archive, "wrong-password", &tools, &cancellation).unwrap(),
                "{name}: wrong password must fail"
            );

            let output_directory = dir.path().join(format!("{name}-out"));
            let job = RecoveryJob {
                archive_path: archive.clone(),
                output_directory: output_directory.clone(),
                dictionary_path: dir.path().join("empty.dict"),
                dictionary_count: 0,
                known_password: Some(password.into()),
                work_directory: dir.path().join(format!("{name}-work")),
            };
            fs::create_dir_all(&job.work_directory).unwrap();

            let result = recover_and_extract_lazy(
                &job,
                &tools,
                &cancellation,
                || panic!("known-password recovery must not prepare the dictionary"),
                |_| {},
            )
            .expect("recover");
            assert!(result.success, "{name}: {}", result.message);
            assert_eq!(result.password.as_deref(), Some(password));
            assert_eq!(
                fs::read_to_string(output_directory.join("payload.txt")).unwrap(),
                "arc-recall-payload"
            );
        }
    }

    #[test]
    fn recovery_decodes_lz4_before_known_password_extraction() {
        let Some(seven_zip) = locate_seven_zip() else {
            eprintln!("skip: 7z.exe not found");
            return;
        };

        let dir = tempfile::tempdir().unwrap();
        let payload = dir.path().join("payload.txt");
        let archive = dir.path().join("encrypted.7z");
        let wrapped = dir.path().join("encrypted.7z.lz4");
        let output_directory = dir.path().join("out");
        let work_directory = dir.path().join("work");
        let password = "lz4-known-password";
        fs::write(&payload, b"lz4-recovery-ok").unwrap();
        create_encrypted_archive(&seven_zip, "-t7z", password, &archive, &payload);
        write_lz4_frame(&archive, &wrapped);

        let tools = RecoveryToolPaths {
            seven_zip,
            hashcat: PathBuf::from("hashcat-not-required"),
            john_tools_directory: PathBuf::from("john-not-required"),
            perl: PathBuf::from("perl-not-required"),
        };
        let job = RecoveryJob {
            archive_path: wrapped,
            output_directory: output_directory.clone(),
            dictionary_path: dir.path().join("unused.dict"),
            dictionary_count: 0,
            known_password: Some(password.into()),
            work_directory,
        };
        let mut updates = Vec::new();
        let result = recover_and_extract_lazy(
            &job,
            &tools,
            &CancellationToken::default(),
            || panic!("known-password recovery must not prepare the dictionary"),
            |update| updates.push(update),
        )
        .expect("recover LZ4-wrapped archive");

        assert!(result.success, "{}", result.message);
        assert_eq!(
            fs::read_to_string(output_directory.join("payload.txt")).unwrap(),
            "lz4-recovery-ok"
        );
        assert!(updates.iter().any(|update| {
            update.phase == RecoveryPhase::Preparing && update.engine.as_deref() == Some("LZ4")
        }));
    }

    #[test]
    fn seven_zip_extracts_unencrypted_archive_without_password() {
        let Some(seven_zip) = locate_seven_zip() else {
            eprintln!("skip: 7z.exe not found");
            return;
        };

        let dir = tempfile::tempdir().unwrap();
        let payload = dir.path().join("plain.txt");
        fs::write(&payload, b"no-password").unwrap();
        let archive = dir.path().join("plain.7z");
        run_seven_zip(
            &seven_zip,
            &[
                "a",
                "-t7z",
                "-y",
                archive.to_str().unwrap(),
                payload.to_str().unwrap(),
            ],
        );

        let tools = RecoveryToolPaths {
            seven_zip,
            hashcat: PathBuf::from("hashcat-not-required"),
            john_tools_directory: PathBuf::from("john-not-required"),
            perl: PathBuf::from("perl-not-required"),
        };
        let cancellation = CancellationToken::default();
        let output_directory = dir.path().join("plain-out");
        let job = RecoveryJob {
            archive_path: archive,
            output_directory: output_directory.clone(),
            dictionary_path: dir.path().join("empty.dict"),
            dictionary_count: 0,
            known_password: None,
            work_directory: dir.path().join("plain-work"),
        };
        fs::create_dir_all(&job.work_directory).unwrap();

        let result = recover_and_extract_lazy(
            &job,
            &tools,
            &cancellation,
            || panic!("unencrypted recovery must not prepare the dictionary"),
            |_| {},
        )
        .expect("recover");
        assert!(result.success, "{}", result.message);
        assert!(result.password.is_none());
        assert_eq!(
            fs::read_to_string(output_directory.join("plain.txt")).unwrap(),
            "no-password"
        );
    }

    #[test]
    fn seven_zip_container_validation_rejects_pe_with_zip_bytes() {
        let Some(seven_zip) = locate_seven_zip() else {
            eprintln!("skip: 7z.exe not found");
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        let dll_path = dir.path().join("MonoPosixHelper.dll");
        let mut pe = minimal_pe_fixture();
        pe[4 * 1024..4 * 1024 + ZIP_SIGNATURES[0].len()].copy_from_slice(ZIP_SIGNATURES[0]);
        fs::write(&dll_path, pe).unwrap();
        let tools = RecoveryToolPaths {
            seven_zip,
            hashcat: PathBuf::from("hashcat-not-required"),
            john_tools_directory: PathBuf::from("john-not-required"),
            perl: PathBuf::from("perl-not-required"),
        };

        assert!(matches!(
            validate_archive_container(
                &dll_path,
                ArchiveFormat::Zip,
                &tools,
                &CancellationToken::default(),
            ),
            Err(RecoveryError::InvalidArchive(message)) if message.contains("PE")
        ));
    }

    #[test]
    fn recursively_extracts_misleading_suffix_archive_with_inherited_password() {
        let Some(seven_zip) = locate_seven_zip() else {
            eprintln!("skip: 7z.exe not found");
            return;
        };

        let dir = tempfile::tempdir().unwrap();
        let payload = dir.path().join("nested-payload.txt");
        fs::write(&payload, b"recursive-password-ok").unwrap();
        let password = "shared-nested-pass";
        let inner_archive = dir.path().join("inner.7z11");
        create_encrypted_archive(&seven_zip, "-t7z", password, &inner_archive, &payload);
        let outer_archive = dir.path().join("outer.7z");
        create_encrypted_archive(&seven_zip, "-t7z", password, &outer_archive, &inner_archive);
        let output_directory = dir.path().join("recursive-out");
        let job = RecoveryJob {
            archive_path: outer_archive,
            output_directory: output_directory.clone(),
            dictionary_path: dir.path().join("unused.dict"),
            dictionary_count: 0,
            known_password: Some(password.into()),
            work_directory: dir.path().join("recursive-work"),
        };
        let tools = RecoveryToolPaths {
            seven_zip,
            hashcat: dir.path().join("missing-hashcat"),
            john_tools_directory: dir.path().join("missing-john"),
            perl: dir.path().join("missing-perl"),
        };

        let mut updates = Vec::new();
        let result = recover_and_extract_recursive_lazy(
            &job,
            &tools,
            &CancellationToken::default(),
            RecursiveRecoveryOptions::default(),
            || panic!("inherited password must avoid dictionary preparation"),
            |update| updates.push(update),
        )
        .expect("recursive recovery");

        assert!(result.root.success, "{}", result.root.message);
        assert_eq!(result.discovered_nested_archives, 1);
        assert_eq!(result.extracted_nested_archives, 1);
        assert_eq!(result.skipped_nested_archives, 0);
        assert!(result.scanned_files > 0);
        assert!(updates.iter().any(|update| {
            update.phase == RecoveryPhase::Recursive
                && update.scanned_file_count.is_some_and(|count| count > 0)
        }));
        assert_eq!(
            fs::read_to_string(output_directory.join("inner").join("nested-payload.txt")).unwrap(),
            "recursive-password-ok"
        );
    }

    #[test]
    fn recursively_uses_dictionary_once_for_different_nested_password() {
        let Some(seven_zip) = locate_seven_zip() else {
            eprintln!("skip: 7z.exe not found");
            return;
        };

        let dir = tempfile::tempdir().unwrap();
        let payload = dir.path().join("different-password.txt");
        fs::write(&payload, b"nested-dictionary-ok").unwrap();
        let nested_password = "nested-only-pass";
        let inner_archive = dir.path().join("dictionary-inner.7z");
        create_encrypted_archive(
            &seven_zip,
            "-t7z",
            nested_password,
            &inner_archive,
            &payload,
        );
        let outer_archive = dir.path().join("plain-outer.7z");
        create_plain_archive(&seven_zip, &outer_archive, &inner_archive);
        let dictionary_path = dir.path().join("nested.dict");
        fs::write(
            &dictionary_path,
            format!("wrong-one\n{nested_password}\nwrong-two\n"),
        )
        .unwrap();
        let output_directory = dir.path().join("dictionary-recursive-out");
        let job = RecoveryJob {
            archive_path: outer_archive,
            output_directory: output_directory.clone(),
            dictionary_path: dictionary_path.clone(),
            dictionary_count: 3,
            known_password: None,
            work_directory: dir.path().join("dictionary-recursive-work"),
        };
        let tools = RecoveryToolPaths {
            seven_zip,
            hashcat: dir.path().join("missing-hashcat"),
            john_tools_directory: dir.path().join("missing-john"),
            perl: dir.path().join("missing-perl"),
        };
        let preparation_count = std::cell::Cell::new(0);

        let result = recover_and_extract_recursive_lazy(
            &job,
            &tools,
            &CancellationToken::default(),
            RecursiveRecoveryOptions::default(),
            || {
                preparation_count.set(preparation_count.get() + 1);
                Ok(RecoveryDictionary {
                    path: dictionary_path,
                    candidate_count: 3,
                })
            },
            |_| {},
        )
        .expect("recursive dictionary recovery");

        assert!(result.root.success, "{}", result.root.message);
        assert_eq!(preparation_count.get(), 1);
        assert_eq!(result.extracted_nested_archives, 1);
        assert!(
            result
                .recovered_passwords
                .iter()
                .any(|password| password == nested_password)
        );
        assert_eq!(
            fs::read_to_string(
                output_directory
                    .join("dictionary-inner")
                    .join("different-password.txt")
            )
            .unwrap(),
            "nested-dictionary-ok"
        );
    }

    #[test]
    fn recursive_extraction_enforces_depth_limit() {
        let Some(seven_zip) = locate_seven_zip() else {
            eprintln!("skip: 7z.exe not found");
            return;
        };

        let dir = tempfile::tempdir().unwrap();
        let payload = dir.path().join("depth-payload.txt");
        fs::write(&payload, b"depth-limit").unwrap();
        let level_two = dir.path().join("level-two.7z");
        create_plain_archive(&seven_zip, &level_two, &payload);
        let level_one = dir.path().join("level-one.7z");
        create_plain_archive(&seven_zip, &level_one, &level_two);
        let outer_archive = dir.path().join("depth-outer.7z");
        create_plain_archive(&seven_zip, &outer_archive, &level_one);
        let output_directory = dir.path().join("depth-out");
        let job = RecoveryJob {
            archive_path: outer_archive,
            output_directory: output_directory.clone(),
            dictionary_path: dir.path().join("unused.dict"),
            dictionary_count: 0,
            known_password: None,
            work_directory: dir.path().join("depth-work"),
        };
        let tools = RecoveryToolPaths {
            seven_zip,
            hashcat: dir.path().join("missing-hashcat"),
            john_tools_directory: dir.path().join("missing-john"),
            perl: dir.path().join("missing-perl"),
        };

        let result = recover_and_extract_recursive_lazy(
            &job,
            &tools,
            &CancellationToken::default(),
            RecursiveRecoveryOptions {
                enabled: true,
                max_depth: 1,
                max_nested_archives: 100,
                compute_mode: RecoveryComputeMode::GpuPreferred,
            },
            || panic!("plain archives must avoid dictionary preparation"),
            |_| {},
        )
        .expect("depth-limited recursive recovery");

        assert!(result.root.success, "{}", result.root.message);
        assert_eq!(result.discovered_nested_archives, 2);
        assert_eq!(result.extracted_nested_archives, 1);
        assert_eq!(result.skipped_nested_archives, 1);
        assert!(result.depth_limit_reached);
        assert!(
            output_directory
                .join("level-one")
                .join("level-two.7z")
                .is_file()
        );
        assert!(
            !output_directory
                .join("level-one")
                .join("level-two")
                .exists()
        );
    }

    #[test]
    fn recursive_extraction_ignores_preexisting_output_archives() {
        let Some(seven_zip) = locate_seven_zip() else {
            eprintln!("skip: 7z.exe not found");
            return;
        };

        let dir = tempfile::tempdir().unwrap();
        let old_payload = dir.path().join("old-payload.txt");
        fs::write(&old_payload, b"must-not-be-recursed").unwrap();
        let old_archive = dir.path().join("old.7z");
        create_plain_archive(&seven_zip, &old_archive, &old_payload);
        let root_payload = dir.path().join("root-payload.txt");
        fs::write(&root_payload, b"root-only").unwrap();
        let outer_archive = dir.path().join("snapshot-outer.7z");
        create_plain_archive(&seven_zip, &outer_archive, &root_payload);
        let output_directory = dir.path().join("existing-output");
        fs::create_dir_all(&output_directory).unwrap();
        fs::copy(&old_archive, output_directory.join("old.7z")).unwrap();
        let job = RecoveryJob {
            archive_path: outer_archive,
            output_directory: output_directory.clone(),
            dictionary_path: dir.path().join("unused.dict"),
            dictionary_count: 0,
            known_password: None,
            work_directory: dir.path().join("snapshot-work"),
        };
        let tools = RecoveryToolPaths {
            seven_zip,
            hashcat: dir.path().join("missing-hashcat"),
            john_tools_directory: dir.path().join("missing-john"),
            perl: dir.path().join("missing-perl"),
        };

        let result = recover_and_extract_recursive_lazy(
            &job,
            &tools,
            &CancellationToken::default(),
            RecursiveRecoveryOptions::default(),
            || panic!("plain archive must avoid dictionary preparation"),
            |_| {},
        )
        .expect("snapshot-aware recursive recovery");

        assert!(result.root.success, "{}", result.root.message);
        assert_eq!(result.discovered_nested_archives, 0);
        assert!(!output_directory.join("old").exists());
        assert_eq!(
            fs::read_to_string(output_directory.join("root-payload.txt")).unwrap(),
            "root-only"
        );
    }

    #[test]
    fn dictionary_recovery_falls_back_to_seven_zip_when_external_tools_are_missing() {
        let Some(seven_zip) = locate_seven_zip() else {
            eprintln!("skip: 7z.exe not found");
            return;
        };

        let dir = tempfile::tempdir().unwrap();
        let payload = dir.path().join("fallback.txt");
        fs::write(&payload, b"internal-fallback-ok").unwrap();
        let password = "fallback-pass-42";
        let archive = dir.path().join("fallback.7z");
        create_encrypted_archive(&seven_zip, "-t7z", password, &archive, &payload);
        let dictionary_path = dir.path().join("fallback.dict");
        fs::write(
            &dictionary_path,
            format!("wrong-one\nwrong-two\n{password}\n"),
        )
        .unwrap();

        let tools = RecoveryToolPaths {
            seven_zip,
            hashcat: dir.path().join("missing-hashcat"),
            john_tools_directory: dir.path().join("missing-john"),
            perl: dir.path().join("missing-perl"),
        };
        let output_directory = dir.path().join("fallback-out");
        let job = RecoveryJob {
            archive_path: archive,
            output_directory: output_directory.clone(),
            dictionary_path,
            dictionary_count: 3,
            known_password: None,
            work_directory: dir.path().join("fallback-work"),
        };
        let mut updates = Vec::new();

        let result = recover_and_extract(&job, &tools, &CancellationToken::default(), |update| {
            updates.push(update)
        })
        .expect("fallback recovery");

        assert!(result.success, "{}", result.message);
        assert_eq!(result.password.as_deref(), Some(password));
        assert_eq!(result.engine.as_deref(), Some("7-Zip CPU"));
        assert!(
            updates
                .iter()
                .any(|update| update.phase == RecoveryPhase::Internal)
        );
        assert!(
            updates
                .iter()
                .any(|update| update.attempted_count.is_some())
        );
        assert_eq!(
            fs::read_to_string(output_directory.join("fallback.txt")).unwrap(),
            "internal-fallback-ok"
        );
    }

    #[test]
    fn cancellation_stops_before_external_engines() {
        let cancellation = CancellationToken::default();
        cancellation.cancel();
        assert!(matches!(
            ensure_not_cancelled(&cancellation),
            Err(RecoveryError::Cancelled)
        ));
    }

    /// openwall/john-samples RAR fixtures (password = `password`).
    #[test]
    fn recovers_openwall_rar3_and_rar5_with_known_password() {
        let Some(seven_zip) = locate_seven_zip() else {
            eprintln!("skip: 7z.exe not found");
            return;
        };
        let fixtures = rar_fixture_dir();
        if !fixtures.is_dir() {
            eprintln!("skip: RAR fixtures missing at {}", fixtures.display());
            return;
        }

        let tools = RecoveryToolPaths {
            seven_zip,
            hashcat: PathBuf::from("hashcat-not-required"),
            john_tools_directory: PathBuf::from("john-not-required"),
            perl: PathBuf::from("perl-not-required"),
        };
        let password = "password";
        let cases = [
            ("rar3-p0.rar", ArchiveFormat::Rar3),
            ("rar3-hp0.rar", ArchiveFormat::Rar3),
            ("rar5-p0-password.rar", ArchiveFormat::Rar5),
            ("rar5-hp0-password.rar", ArchiveFormat::Rar5),
        ];

        let dir = tempfile::tempdir().unwrap();
        for (name, expected_format) in cases {
            let archive = fixtures.join(name);
            assert!(archive.is_file(), "missing fixture {name}");
            assert_eq!(
                detect_archive_format(&archive).unwrap(),
                expected_format,
                "{name} format"
            );

            let output_directory = dir.path().join(format!("{name}-out"));
            let job = RecoveryJob {
                archive_path: archive,
                output_directory: output_directory.clone(),
                dictionary_path: dir.path().join("empty.dict"),
                dictionary_count: 0,
                known_password: Some(password.into()),
                work_directory: dir.path().join(format!("{name}-work")),
            };
            fs::write(&job.dictionary_path, b"").unwrap();
            fs::create_dir_all(&job.work_directory).unwrap();

            let result = recover_and_extract(&job, &tools, &CancellationToken::default(), |_| {})
                .expect(name);
            assert!(result.success, "{name}: {}", result.message);
            assert_eq!(result.password.as_deref(), Some(password));
            assert!(
                output_directory.read_dir().unwrap().next().is_some(),
                "{name}: expected extracted files in {}",
                output_directory.display()
            );
        }
    }

    /// Full dictionary path: *2john → Hashcat/John → 7-Zip re-verify + extract.
    ///
    /// Requires the prepared Windows engine bundle (see `engine-bundle:prepare`).
    #[test]
    #[ignore = "expands the large real tool bundle and runs Hashcat/John"]
    fn dictionary_recovery_cracks_encrypted_7z_and_zip() {
        if !cfg!(all(windows, target_arch = "x86_64")) {
            return;
        }

        let resource_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("src-tauri")
            .join("resources");
        let tools_root = tempfile::tempdir().unwrap();
        let manager = super::super::FullEngineBundleManager::new(&resource_dir, tools_root.path());
        assert!(
            manager.status().bundled,
            "run `pnpm engine-bundle:prepare` first"
        );
        manager.install().expect("install engine bundle");

        let tools = RecoveryToolPaths {
            seven_zip: manager.seven_zip_executable(),
            hashcat: manager.hashcat_executable(),
            john_tools_directory: manager.john_tools_directory(),
            perl: manager.perl_executable(),
        };
        assert!(tools.john_tools_directory.join("rar2john.exe").is_file());
        assert!(tools.john_tools_directory.join("zip2john.exe").is_file());
        assert!(tools.john_tools_directory.join("7z2john.pl").is_file());

        let dir = tempfile::tempdir().unwrap();
        let payload = dir.path().join("payload.txt");
        fs::write(&payload, b"dictionary-recovery-ok").unwrap();
        let password = "dict-pass-42";
        let dictionary_path = dir.path().join("wordlist.txt");
        fs::write(&dictionary_path, "wrong1\nwrong2\ndict-pass-42\nwrong3\n").unwrap();

        for (name, format_flag) in [("dict.7z", "-t7z"), ("dict.zip", "-tzip")] {
            let archive = dir.path().join(name);
            create_encrypted_archive(&tools.seven_zip, format_flag, password, &archive, &payload);

            // Converter smoke check before the full recovery pipeline.
            let format = detect_archive_format(&archive).unwrap();
            let convert_job = RecoveryJob {
                archive_path: archive.clone(),
                output_directory: dir.path().join(format!("{name}-unused-out")),
                dictionary_path: dictionary_path.clone(),
                dictionary_count: 4,
                known_password: None,
                work_directory: dir.path().join(format!("{name}-convert-work")),
            };
            fs::create_dir_all(&convert_job.work_directory).unwrap();
            let records =
                extract_hashes(&convert_job, &tools, format, &CancellationToken::default())
                    .expect("converter should emit hash lines");
            assert!(
                !records.is_empty(),
                "{name}: converter produced no hash records"
            );

            let output_directory = dir.path().join(format!("{name}-out"));
            let job = RecoveryJob {
                archive_path: archive,
                output_directory: output_directory.clone(),
                dictionary_path: dictionary_path.clone(),
                dictionary_count: 4,
                known_password: None,
                work_directory: dir.path().join(format!("{name}-work")),
            };
            fs::create_dir_all(&job.work_directory).unwrap();
            let cancellation = CancellationToken::default();
            let mut phases = Vec::new();
            let result = recover_and_extract(&job, &tools, &cancellation, |update| {
                phases.push(update.phase);
            })
            .expect("dictionary recovery");

            assert!(result.success, "{name}: {}", result.message);
            assert_eq!(result.password.as_deref(), Some(password));
            assert_eq!(
                fs::read_to_string(output_directory.join("payload.txt")).unwrap(),
                "dictionary-recovery-ok"
            );
            assert!(
                phases.contains(&RecoveryPhase::Converting),
                "{name}: expected converting phase, got {phases:?}"
            );
        }
    }

    /// RAR dictionary recovery using openwall fixtures + rar2john.
    #[test]
    #[ignore = "expands the large real tool bundle and runs Hashcat/John"]
    fn dictionary_recovery_cracks_openwall_rar_samples() {
        if !cfg!(all(windows, target_arch = "x86_64")) {
            return;
        }
        let fixtures = rar_fixture_dir();
        if !fixtures.is_dir() {
            eprintln!("skip: RAR fixtures missing");
            return;
        }

        let resource_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("src-tauri")
            .join("resources");
        let tools_root = tempfile::tempdir().unwrap();
        let manager = super::super::FullEngineBundleManager::new(&resource_dir, tools_root.path());
        assert!(manager.status().bundled, "run engine-bundle:prepare first");
        manager.install().expect("install engine bundle");

        let tools = RecoveryToolPaths {
            seven_zip: manager.seven_zip_executable(),
            hashcat: manager.hashcat_executable(),
            john_tools_directory: manager.john_tools_directory(),
            perl: manager.perl_executable(),
        };

        let dir = tempfile::tempdir().unwrap();
        let dictionary_path = dir.path().join("wordlist.txt");
        fs::write(&dictionary_path, "wrong\npassword\nnope\n").unwrap();
        let password = "password";

        // rar3-p0.rar is intentionally excluded: rar2john emits a "too small"
        // $RAR3$*1* candidate that this John build will not load. Known-password
        // extraction via 7-Zip still covers that fixture.
        for name in [
            "rar3-hp0.rar",
            "rar5-p0-password.rar",
            "rar5-hp0-password.rar",
        ] {
            let archive = fixtures.join(name);
            let format = detect_archive_format(&archive).unwrap();
            let convert_job = RecoveryJob {
                archive_path: archive.clone(),
                output_directory: dir.path().join(format!("{name}-unused")),
                dictionary_path: dictionary_path.clone(),
                dictionary_count: 3,
                known_password: None,
                work_directory: dir.path().join(format!("{name}-convert")),
            };
            fs::create_dir_all(&convert_job.work_directory).unwrap();
            let records =
                extract_hashes(&convert_job, &tools, format, &CancellationToken::default())
                    .unwrap_or_else(|error| panic!("{name} rar2john failed: {error}"));
            assert!(!records.is_empty(), "{name}: rar2john produced no hashes");

            let output_directory = dir.path().join(format!("{name}-out"));
            let job = RecoveryJob {
                archive_path: archive,
                output_directory: output_directory.clone(),
                dictionary_path: dictionary_path.clone(),
                dictionary_count: 3,
                known_password: None,
                work_directory: dir.path().join(format!("{name}-work")),
            };
            fs::create_dir_all(&job.work_directory).unwrap();
            let result = recover_and_extract(&job, &tools, &CancellationToken::default(), |_| {})
                .unwrap_or_else(|error| panic!("{name} recovery failed: {error}"));
            assert!(result.success, "{name}: {}", result.message);
            assert_eq!(result.password.as_deref(), Some(password));
            assert!(
                output_directory.read_dir().unwrap().next().is_some(),
                "{name}: empty extract dir"
            );
        }
    }

    #[test]
    #[ignore = "expands the large real tool bundle"]
    fn cancel_token_kills_long_running_hashcat_attempt() {
        if !cfg!(all(windows, target_arch = "x86_64")) {
            return;
        }

        let resource_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("src-tauri")
            .join("resources");
        let tools_root = tempfile::tempdir().unwrap();
        let manager = super::super::FullEngineBundleManager::new(&resource_dir, tools_root.path());
        if !manager.status().bundled {
            return;
        }
        manager.install().expect("install engine bundle");

        let tools = RecoveryToolPaths {
            seven_zip: manager.seven_zip_executable(),
            hashcat: manager.hashcat_executable(),
            john_tools_directory: manager.john_tools_directory(),
            perl: manager.perl_executable(),
        };

        let dir = tempfile::tempdir().unwrap();
        let payload = dir.path().join("payload.txt");
        fs::write(&payload, b"cancel-me").unwrap();
        // Strong password unlikely to appear early in a tiny wrong wordlist.
        let password = "cancel-target-password-zz9";
        let archive = dir.path().join("cancel.7z");
        create_encrypted_archive(&tools.seven_zip, "-t7z", password, &archive, &payload);

        // Large-ish wrong dictionary so Hashcat has work to do before exhausting.
        let dictionary_path = dir.path().join("wrong.txt");
        let mut dict = String::new();
        for index in 0..5_000 {
            dict.push_str(&format!("not-the-password-{index}\n"));
        }
        fs::write(&dictionary_path, dict).unwrap();

        let job = RecoveryJob {
            archive_path: archive,
            output_directory: dir.path().join("cancel-out"),
            dictionary_path,
            dictionary_count: 5_000,
            known_password: None,
            work_directory: dir.path().join("cancel-work"),
        };
        fs::create_dir_all(&job.work_directory).unwrap();

        let cancellation = CancellationToken::default();
        let cancel_flag = cancellation.clone();
        let worker =
            std::thread::spawn(move || recover_and_extract(&job, &tools, &cancellation, |_| {}));
        std::thread::sleep(Duration::from_millis(800));
        cancel_flag.cancel();
        let outcome = worker.join().expect("worker panicked");
        assert!(
            matches!(outcome, Err(RecoveryError::Cancelled))
                || matches!(
                    outcome,
                    Ok(RecoveryResult {
                        cancelled: true,
                        ..
                    })
                ),
            "expected cancel, got {outcome:?}"
        );
    }

    fn rar_fixture_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("rar")
    }

    fn write_lz4_frame(source: &Path, destination: &Path) {
        let mut input = BufReader::new(fs::File::open(source).unwrap());
        let output = BufWriter::new(fs::File::create(destination).unwrap());
        let mut encoder = lz4::EncoderBuilder::new().build(output).unwrap();
        std::io::copy(&mut input, &mut encoder).unwrap();
        let (mut output, result) = encoder.finish();
        result.unwrap();
        output.flush().unwrap();
    }

    fn minimal_pe_fixture() -> Vec<u8> {
        const PE_OFFSET: usize = 0x80;
        const OPTIONAL_HEADER_SIZE: usize = 0xf0;
        const SECTION_RAW_OFFSET: usize = 0x400;
        const SECTION_RAW_SIZE: usize = 0x2000;
        let section_table_offset = PE_OFFSET + 24 + OPTIONAL_HEADER_SIZE;
        let mut bytes = vec![0u8; SECTION_RAW_OFFSET + SECTION_RAW_SIZE];
        bytes[..2].copy_from_slice(b"MZ");
        bytes[0x3c..0x40].copy_from_slice(&(PE_OFFSET as u32).to_le_bytes());
        bytes[PE_OFFSET..PE_OFFSET + 4].copy_from_slice(b"PE\0\0");
        bytes[PE_OFFSET + 4..PE_OFFSET + 6].copy_from_slice(&0x8664u16.to_le_bytes());
        bytes[PE_OFFSET + 6..PE_OFFSET + 8].copy_from_slice(&1u16.to_le_bytes());
        bytes[PE_OFFSET + 20..PE_OFFSET + 22]
            .copy_from_slice(&(OPTIONAL_HEADER_SIZE as u16).to_le_bytes());
        bytes[PE_OFFSET + 22..PE_OFFSET + 24].copy_from_slice(&0x2022u16.to_le_bytes());
        bytes[PE_OFFSET + 24..PE_OFFSET + 26].copy_from_slice(&0x20bu16.to_le_bytes());
        bytes[section_table_offset + 16..section_table_offset + 20]
            .copy_from_slice(&(SECTION_RAW_SIZE as u32).to_le_bytes());
        bytes[section_table_offset + 20..section_table_offset + 24]
            .copy_from_slice(&(SECTION_RAW_OFFSET as u32).to_le_bytes());
        bytes
    }

    fn locate_seven_zip() -> Option<PathBuf> {
        let candidates = [
            PathBuf::from(r"C:\Program Files\7-Zip\7z.exe"),
            PathBuf::from(r"C:\Program Files (x86)\7-Zip\7z.exe"),
        ];
        for candidate in candidates {
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        std::env::var_os("PATH").and_then(|paths| {
            for dir in std::env::split_paths(&paths) {
                let candidate = dir.join(if cfg!(windows) { "7z.exe" } else { "7z" });
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
            None
        })
    }

    fn create_encrypted_archive(
        seven_zip: &Path,
        format_flag: &str,
        password: &str,
        archive: &Path,
        payload: &Path,
    ) {
        let password_arg = format!("-p{password}");
        let mut args = vec![
            "a".to_owned(),
            format_flag.to_owned(),
            "-y".to_owned(),
            password_arg,
        ];
        if format_flag == "-t7z" {
            args.push("-mhe=on".into());
        }
        args.push(archive.display().to_string());
        args.push(payload.display().to_string());
        let owned: Vec<&str> = args.iter().map(String::as_str).collect();
        run_seven_zip(seven_zip, &owned);
    }

    fn create_plain_archive(seven_zip: &Path, archive: &Path, payload: &Path) {
        run_seven_zip(
            seven_zip,
            &[
                "a",
                "-t7z",
                "-y",
                archive.to_str().unwrap(),
                payload.to_str().unwrap(),
            ],
        );
    }

    fn run_seven_zip(seven_zip: &Path, args: &[&str]) {
        let mut request = ProcessRequest::new(seven_zip);
        request.args = args.iter().map(OsString::from).collect();
        request.timeout = Duration::from_secs(60);
        let output = run_process(&request, None).expect("spawn 7z");
        assert!(
            output.success,
            "7z {:?} failed: stdout={} stderr={}",
            args, output.stdout, output.stderr
        );
    }
}
