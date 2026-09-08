use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU8, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

pub const DEFAULT_LOG_FILE_BYTES: u64 = 5 * 1024 * 1024;
pub const DEFAULT_LOG_TOTAL_BYTES: u64 = 25 * 1024 * 1024;
pub const DEFAULT_LOG_PAGE_SIZE: usize = 200;
pub const MAX_LOG_PAGE_SIZE: usize = 1_000;

const LOG_FILE_STEM: &str = "arcrecall";
const MAX_MANAGED_LOG_FILES: usize = 100;
const MAX_MESSAGE_CHARS: usize = 2_048;
const MAX_CONTEXT_VALUE_CHARS: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Error,
    Warn,
    Info,
    Debug,
}

impl LogLevel {
    const fn rank(self) -> u8 {
        match self {
            Self::Error => 1,
            Self::Warn => 2,
            Self::Info => 3,
            Self::Debug => 4,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub id: String,
    pub timestamp_ms: u64,
    pub level: LogLevel,
    pub source: String,
    pub event: String,
    pub message: String,
    pub context: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogQuery {
    #[serde(default)]
    pub level: Option<LogLevel>,
    #[serde(default)]
    pub attention_only: bool,
    #[serde(default)]
    pub search_text: String,
    #[serde(default)]
    pub skip: usize,
    #[serde(default = "default_take")]
    pub take: usize,
}

impl Default for LogQuery {
    fn default() -> Self {
        Self {
            level: None,
            attention_only: false,
            search_text: String::new(),
            skip: 0,
            take: DEFAULT_LOG_PAGE_SIZE,
        }
    }
}

fn default_take() -> usize {
    DEFAULT_LOG_PAGE_SIZE
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogStats {
    pub error_count: usize,
    pub warn_count: usize,
    pub info_count: usize,
    pub debug_count: usize,
    pub file_count: usize,
    pub disk_bytes: u64,
    pub unreadable_line_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogListResult {
    pub entries: Vec<LogEntry>,
    pub total_count: usize,
    pub matched_count: usize,
    pub has_more: bool,
    pub stats: LogStats,
    pub directory: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogExportResult {
    pub path: String,
    pub entry_count: usize,
    pub byte_count: u64,
    pub created_at_ms: u64,
}

pub struct LogStore {
    directory: PathBuf,
    max_file_bytes: u64,
    max_total_bytes: AtomicU64,
    sequence: AtomicU64,
    max_level: AtomicU8,
    file_lock: Mutex<()>,
    summary_cache: Mutex<HashMap<PathBuf, CachedLogFileSummary>>,
    cache_epoch: AtomicU64,
}

#[derive(Debug, Clone)]
struct CachedLogFileSummary {
    byte_count: u64,
    modified_at: Option<SystemTime>,
    entry_count: usize,
    stats: LogStats,
    ends_with_newline: bool,
}

struct LogFileSnapshot {
    path: PathBuf,
    file: File,
    byte_count: u64,
    modified_at: Option<SystemTime>,
    summary: Option<CachedLogFileSummary>,
    cache_epoch: u64,
    ends_with_newline: bool,
}

impl LogStore {
    pub fn new(directory: impl Into<PathBuf>) -> Result<Self, String> {
        Self::with_limits(directory, DEFAULT_LOG_FILE_BYTES, DEFAULT_LOG_TOTAL_BYTES)
    }

    fn with_limits(
        directory: impl Into<PathBuf>,
        max_file_bytes: u64,
        max_total_bytes: u64,
    ) -> Result<Self, String> {
        let directory = directory.into();
        fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        let max_file_bytes = max_file_bytes.max(1);
        Ok(Self {
            directory,
            max_file_bytes,
            max_total_bytes: AtomicU64::new(max_total_bytes.max(max_file_bytes)),
            sequence: AtomicU64::new(1),
            max_level: AtomicU8::new(LogLevel::Info.rank()),
            file_lock: Mutex::new(()),
            summary_cache: Mutex::new(HashMap::new()),
            cache_epoch: AtomicU64::new(0),
        })
    }

    pub fn set_max_level(&self, level: LogLevel) {
        self.max_level.store(level.rank(), Ordering::Relaxed);
    }

    pub fn set_max_total_bytes(&self, max_total_bytes: u64) -> Result<(), String> {
        let _guard = self.file_lock.lock().map_err(|error| error.to_string())?;
        self.max_total_bytes
            .store(max_total_bytes.max(self.max_file_bytes), Ordering::Relaxed);
        self.cache_epoch.fetch_add(1, Ordering::Relaxed);
        self.summary_cache
            .lock()
            .map_err(|error| error.to_string())?
            .clear();
        self.trim_to_capacity_locked()?;
        Ok(())
    }

    pub fn directory(&self) -> &Path {
        &self.directory
    }

    pub fn write(
        &self,
        level: LogLevel,
        source: &str,
        event: &str,
        message: &str,
        context: BTreeMap<String, String>,
    ) -> Result<Option<LogEntry>, String> {
        if level.rank() > self.max_level.load(Ordering::Relaxed) {
            return Ok(None);
        }

        let timestamp_ms = now_ms();
        let entry = LogEntry {
            id: format!(
                "{timestamp_ms}-{}",
                self.sequence.fetch_add(1, Ordering::Relaxed)
            ),
            timestamp_ms,
            level,
            source: sanitize_identifier(source, "application"),
            event: sanitize_identifier(event, "event"),
            message: sanitize_text(message, MAX_MESSAGE_CHARS),
            context: sanitize_context(context),
        };
        let mut line = serde_json::to_vec(&entry).map_err(|error| error.to_string())?;
        line.push(b'\n');

        let _guard = self.file_lock.lock().map_err(|error| error.to_string())?;
        fs::create_dir_all(&self.directory).map_err(|error| error.to_string())?;
        let active = self.active_path();
        let current_metadata = fs::metadata(&active).ok();
        let current_bytes = current_metadata
            .as_ref()
            .map_or(0, |metadata| metadata.len());
        if current_bytes > 0
            && current_bytes.saturating_add(line.len() as u64) > self.max_file_bytes
        {
            self.cache_epoch.fetch_add(1, Ordering::Relaxed);
            self.summary_cache
                .lock()
                .map_err(|error| error.to_string())?
                .clear();
            self.rotate_locked()?;
            self.trim_to_capacity_locked()?;
        }

        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&active)
            .map_err(|error| error.to_string())?;
        file.write_all(&line).map_err(|error| error.to_string())?;
        let metadata = file.metadata().map_err(|error| error.to_string())?;
        if let Some(cached) = self
            .summary_cache
            .lock()
            .map_err(|error| error.to_string())?
            .get_mut(&active)
            .filter(|cached| {
                cached.byte_count == current_bytes
                    && cached.ends_with_newline
                    && cached.modified_at
                        == current_metadata
                            .as_ref()
                            .and_then(|value| value.modified().ok())
            })
        {
            let mut normalized = entry.clone();
            normalize_legacy_level(&mut normalized);
            increment_level(&mut cached.stats, normalized.level);
            cached.entry_count += 1;
            cached.byte_count = metadata.len();
            cached.modified_at = metadata.modified().ok();
            cached.ends_with_newline = true;
        }
        Ok(Some(entry))
    }

    pub fn list(&self, query: &LogQuery) -> Result<LogListResult, String> {
        let mut snapshots = self.snapshot_files()?;
        let search = query.search_text.trim().to_lowercase();
        let take = query.take.clamp(1, MAX_LOG_PAGE_SIZE);
        let mut stats = LogStats::default();
        let mut total_count = 0;
        let mut entries = Vec::with_capacity(take);
        let mut matched_count = 0;
        if search.is_empty() {
            for snapshot in &mut snapshots {
                let summary = if let Some(summary) = &snapshot.summary {
                    summary.clone()
                } else {
                    let summary = scan_log_snapshot(snapshot, |_| Ok(()))?;
                    self.cache_summary(snapshot, &summary)?;
                    summary
                };
                total_count += summary.entry_count;
                add_summary_stats(&mut stats, &summary);
            }
            matched_count = matched_count_from_stats(&stats, query);
            let mut seen = 0usize;
            for snapshot in snapshots.iter_mut().rev() {
                visit_log_lines_reverse(snapshot, |line| {
                    if let Some(entry) = parse_log_entry(line)
                        && entry_matches_query(&entry, query, "")
                    {
                        if seen >= query.skip {
                            entries.push(entry);
                        }
                        seen = seen.saturating_add(1);
                    }
                    entries.len() < take
                })?;
                if entries.len() == take {
                    break;
                }
            }
        } else {
            // Newest-first traversal counts and selects the requested page in
            // one pass, keeping only `take` entries even for a large offset.
            for snapshot in snapshots.iter_mut().rev() {
                let mut summary = CachedLogFileSummary {
                    byte_count: snapshot.byte_count,
                    modified_at: snapshot.modified_at,
                    entry_count: 0,
                    stats: LogStats::default(),
                    ends_with_newline: snapshot.ends_with_newline,
                };
                visit_log_lines_reverse(snapshot, |line| {
                    if let Some(entry) = parse_log_entry(line) {
                        summary.entry_count += 1;
                        increment_level(&mut summary.stats, entry.level);
                        if entry_matches_query(&entry, query, &search) {
                            if matched_count >= query.skip && entries.len() < take {
                                entries.push(entry);
                            }
                            matched_count += 1;
                        }
                    } else {
                        summary.stats.unreadable_line_count += 1;
                    }
                    true
                })?;
                self.cache_summary(snapshot, &summary)?;
                total_count += summary.entry_count;
                add_summary_stats(&mut stats, &summary);
            }
        }
        stats.file_count = snapshots.len();

        Ok(LogListResult {
            entries,
            total_count,
            matched_count,
            has_more: query.skip.saturating_add(take) < matched_count,
            stats,
            directory: self.directory.display().to_string(),
        })
    }

    pub fn clear(&self) -> Result<usize, String> {
        let _guard = self.file_lock.lock().map_err(|error| error.to_string())?;
        self.summary_cache
            .lock()
            .map_err(|error| error.to_string())?
            .clear();
        self.cache_epoch.fetch_add(1, Ordering::Relaxed);
        let paths = self.existing_paths_locked();
        let mut removed = 0;
        for path in paths {
            fs::remove_file(&path)
                .map_err(|error| format!("无法删除日志文件 {}：{error}", path.display()))?;
            removed += 1;
        }
        Ok(removed)
    }

    pub fn export(&self, exports_directory: &Path) -> Result<LogExportResult, String> {
        let mut snapshots = self.snapshot_files()?;
        fs::create_dir_all(exports_directory).map_err(|error| error.to_string())?;
        let created_at_ms = now_ms();
        let (path, file) = create_unique_export(exports_directory, created_at_ms)?;
        let mut writer = BufWriter::new(file);
        let mut entry_count = 0usize;
        for snapshot in &mut snapshots {
            scan_log_snapshot(snapshot, |entry| {
                serde_json::to_writer(&mut writer, &entry).map_err(|error| error.to_string())?;
                writer.write_all(b"\n").map_err(|error| error.to_string())?;
                entry_count += 1;
                Ok(())
            })?;
        }
        writer.flush().map_err(|error| error.to_string())?;
        let byte_count = fs::metadata(&path)
            .map_err(|error| error.to_string())?
            .len();

        Ok(LogExportResult {
            path: path.display().to_string(),
            entry_count,
            byte_count,
            created_at_ms,
        })
    }

    fn snapshot_files(&self) -> Result<Vec<LogFileSnapshot>, String> {
        // Keep handles to the current files and cap each reader at its captured
        // length. Appends, rotation and clearing can proceed while we parse.
        let _guard = self.file_lock.lock().map_err(|error| error.to_string())?;
        let cache = self
            .summary_cache
            .lock()
            .map_err(|error| error.to_string())?;
        let cache_epoch = self.cache_epoch.load(Ordering::Relaxed);
        self.existing_paths_locked()
            .into_iter()
            .map(|path| {
                let mut file = File::open(&path).map_err(|error| error.to_string())?;
                let metadata = file.metadata().map_err(|error| error.to_string())?;
                let byte_count = metadata.len();
                let modified_at = metadata.modified().ok();
                let mut last_byte = [b'\n'];
                if byte_count > 0 {
                    file.seek(SeekFrom::Start(byte_count - 1))
                        .map_err(|error| error.to_string())?;
                    file.read_exact(&mut last_byte)
                        .map_err(|error| error.to_string())?;
                }
                let summary = cache
                    .get(&path)
                    .filter(|cached| {
                        cached.byte_count == byte_count && cached.modified_at == modified_at
                    })
                    .cloned();
                Ok(LogFileSnapshot {
                    path,
                    file,
                    byte_count,
                    modified_at,
                    summary,
                    cache_epoch,
                    ends_with_newline: last_byte[0] == b'\n',
                })
            })
            .collect()
    }

    fn cache_summary(
        &self,
        snapshot: &LogFileSnapshot,
        summary: &CachedLogFileSummary,
    ) -> Result<(), String> {
        let _guard = self.file_lock.lock().map_err(|error| error.to_string())?;
        // A writer may have replaced or extended this path since capture. Do
        // not install an old summary over the writer's incremental statistics.
        if self.cache_epoch.load(Ordering::Relaxed) == snapshot.cache_epoch
            && fs::metadata(&snapshot.path).ok().is_some_and(|metadata| {
                metadata.len() == snapshot.byte_count
                    && metadata.modified().ok() == snapshot.modified_at
            })
        {
            self.summary_cache
                .lock()
                .map_err(|error| error.to_string())?
                .insert(snapshot.path.clone(), summary.clone());
        }
        Ok(())
    }

    fn rotate_locked(&self) -> Result<(), String> {
        let archive_count = self.max_file_count().saturating_sub(1);
        if archive_count == 0 {
            let active = self.active_path();
            if active.is_file() {
                fs::remove_file(active).map_err(|error| error.to_string())?;
            }
            return Ok(());
        }

        let oldest = self.archive_path(archive_count);
        if oldest.is_file() {
            fs::remove_file(&oldest).map_err(|error| error.to_string())?;
        }
        for index in (1..archive_count).rev() {
            let from = self.archive_path(index);
            if from.is_file() {
                fs::rename(&from, self.archive_path(index + 1))
                    .map_err(|error| error.to_string())?;
            }
        }
        let active = self.active_path();
        if active.is_file() {
            fs::rename(active, self.archive_path(1)).map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    fn trim_to_capacity_locked(&self) -> Result<(), String> {
        let max_file_count = self.max_file_count();
        for index in (max_file_count..MAX_MANAGED_LOG_FILES).rev() {
            let path = self.archive_path(index);
            if path.is_file() {
                fs::remove_file(&path).map_err(|error| error.to_string())?;
            }
        }

        let max_total_bytes = self.max_total_bytes.load(Ordering::Relaxed);
        let mut disk_bytes = self
            .existing_paths_locked()
            .iter()
            .filter_map(|path| fs::metadata(path).ok())
            .map(|metadata| metadata.len())
            .sum::<u64>();
        for index in (1..max_file_count).rev() {
            if disk_bytes <= max_total_bytes {
                break;
            }
            let path = self.archive_path(index);
            if !path.is_file() {
                continue;
            }
            let bytes = fs::metadata(&path)
                .map(|metadata| metadata.len())
                .unwrap_or_default();
            fs::remove_file(&path).map_err(|error| error.to_string())?;
            disk_bytes = disk_bytes.saturating_sub(bytes);
        }
        Ok(())
    }

    fn max_file_count(&self) -> usize {
        let max_total_bytes = self.max_total_bytes.load(Ordering::Relaxed);
        max_total_bytes
            .saturating_add(self.max_file_bytes.saturating_sub(1))
            .saturating_div(self.max_file_bytes)
            .clamp(1, MAX_MANAGED_LOG_FILES as u64) as usize
    }

    fn active_path(&self) -> PathBuf {
        self.directory.join(format!("{LOG_FILE_STEM}.log"))
    }

    fn archive_path(&self, index: usize) -> PathBuf {
        self.directory.join(format!("{LOG_FILE_STEM}.{index}.log"))
    }

    fn existing_paths_locked(&self) -> Vec<PathBuf> {
        let mut paths = (1..MAX_MANAGED_LOG_FILES)
            .rev()
            .map(|index| self.archive_path(index))
            .collect::<Vec<_>>();
        paths.push(self.active_path());
        paths.into_iter().filter(|path| path.is_file()).collect()
    }
}

fn parse_log_entry(line: &[u8]) -> Option<LogEntry> {
    let mut entry = serde_json::from_slice::<LogEntry>(line).ok()?;
    normalize_legacy_level(&mut entry);
    Some(entry)
}

fn increment_level(stats: &mut LogStats, level: LogLevel) {
    match level {
        LogLevel::Error => stats.error_count += 1,
        LogLevel::Warn => stats.warn_count += 1,
        LogLevel::Info => stats.info_count += 1,
        LogLevel::Debug => stats.debug_count += 1,
    }
}

fn add_summary_stats(stats: &mut LogStats, summary: &CachedLogFileSummary) {
    stats.error_count += summary.stats.error_count;
    stats.warn_count += summary.stats.warn_count;
    stats.info_count += summary.stats.info_count;
    stats.debug_count += summary.stats.debug_count;
    stats.unreadable_line_count += summary.stats.unreadable_line_count;
    stats.disk_bytes += summary.byte_count;
}

fn scan_log_snapshot(
    snapshot: &mut LogFileSnapshot,
    mut visit: impl FnMut(LogEntry) -> Result<(), String>,
) -> Result<CachedLogFileSummary, String> {
    snapshot.file.rewind().map_err(|error| error.to_string())?;
    let mut reader = BufReader::new((&mut snapshot.file).take(snapshot.byte_count));
    let mut line = Vec::new();
    let mut summary = CachedLogFileSummary {
        byte_count: snapshot.byte_count,
        modified_at: snapshot.modified_at,
        entry_count: 0,
        stats: LogStats::default(),
        ends_with_newline: snapshot.ends_with_newline,
    };
    while reader
        .read_until(b'\n', &mut line)
        .map_err(|error| error.to_string())?
        > 0
    {
        if let Some(entry) = parse_log_entry(&line) {
            summary.entry_count += 1;
            increment_level(&mut summary.stats, entry.level);
            visit(entry)?;
        } else {
            summary.stats.unreadable_line_count += 1;
        }
        line.clear();
    }
    Ok(summary)
}

fn visit_log_lines_reverse(
    snapshot: &mut LogFileSnapshot,
    mut visit: impl FnMut(&[u8]) -> bool,
) -> Result<(), String> {
    const READ_CHUNK_BYTES: u64 = 64 * 1024;
    let mut end = snapshot.byte_count;
    let mut carry = Vec::new();
    let mut last_chunk = true;
    while end > 0 {
        let start = end.saturating_sub(READ_CHUNK_BYTES);
        let mut bytes = vec![0; (end - start) as usize];
        snapshot
            .file
            .seek(SeekFrom::Start(start))
            .map_err(|error| error.to_string())?;
        snapshot
            .file
            .read_exact(&mut bytes)
            .map_err(|error| error.to_string())?;
        bytes.extend_from_slice(&carry);
        if last_chunk {
            if bytes.last() == Some(&b'\n') {
                bytes.pop();
            }
            last_chunk = false;
        }
        let complete_start = if start == 0 {
            0
        } else if let Some(newline) = bytes.iter().position(|byte| *byte == b'\n') {
            newline + 1
        } else {
            carry = bytes;
            end = start;
            continue;
        };
        for line in bytes[complete_start..].rsplit(|byte| *byte == b'\n') {
            if !visit(line) {
                return Ok(());
            }
        }
        carry = bytes[..complete_start.saturating_sub(1)].to_vec();
        end = start;
    }
    Ok(())
}

fn matched_count_from_stats(stats: &LogStats, query: &LogQuery) -> usize {
    let level_count = |level| match level {
        LogLevel::Error => stats.error_count,
        LogLevel::Warn => stats.warn_count,
        LogLevel::Info => stats.info_count,
        LogLevel::Debug => stats.debug_count,
    };
    match (query.attention_only, query.level) {
        (true, Some(level @ (LogLevel::Error | LogLevel::Warn))) => level_count(level),
        (true, Some(LogLevel::Info | LogLevel::Debug)) => 0,
        (true, None) => stats.error_count + stats.warn_count,
        (false, Some(level)) => level_count(level),
        (false, None) => {
            stats.error_count + stats.warn_count + stats.info_count + stats.debug_count
        }
    }
}

fn entry_matches_query(entry: &LogEntry, query: &LogQuery, search: &str) -> bool {
    (!query.attention_only || matches!(entry.level, LogLevel::Error | LogLevel::Warn))
        && query.level.is_none_or(|level| level == entry.level)
        && (search.is_empty() || entry_matches(entry, search))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn create_unique_export(
    exports_directory: &Path,
    created_at_ms: u64,
) -> Result<(PathBuf, File), String> {
    for suffix in 0..100 {
        let suffix = if suffix == 0 {
            String::new()
        } else {
            format!("-{suffix}")
        };
        let path = exports_directory.join(format!("arcrecall-logs-{created_at_ms}{suffix}.jsonl"));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("无法创建唯一的日志导出文件。".into())
}

fn entry_matches(entry: &LogEntry, search: &str) -> bool {
    entry.source.to_lowercase().contains(search)
        || entry.event.to_lowercase().contains(search)
        || entry.message.to_lowercase().contains(search)
        || entry.context.iter().any(|(key, value)| {
            key.to_lowercase().contains(search) || value.to_lowercase().contains(search)
        })
}

fn sanitize_identifier(value: &str, fallback: &str) -> String {
    let sanitized = value
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        })
        .take(64)
        .collect::<String>();
    if sanitized.is_empty() {
        fallback.to_string()
    } else {
        sanitized
    }
}

fn sanitize_context(context: BTreeMap<String, String>) -> BTreeMap<String, String> {
    context
        .into_iter()
        .take(24)
        .map(|(key, value)| {
            let sanitized_key = sanitize_identifier(&key, "field");
            let sanitized_value = if is_sensitive_key(&key) {
                "[已隐藏]".to_string()
            } else {
                sanitize_text(&value, MAX_CONTEXT_VALUE_CHARS)
            };
            (sanitized_key, sanitized_value)
        })
        .collect()
}

fn is_sensitive_key(key: &str) -> bool {
    let normalized = key.to_lowercase();
    if normalized.ends_with("_count") || normalized.ends_with("_bytes") {
        return false;
    }
    [
        "api_key",
        "api-key",
        "apikey",
        "access_key",
        "access-key",
        "accesskey",
        "private_key",
        "private-key",
        "privatekey",
        "authorization",
        "password",
        "passwd",
        "secret",
        "token",
        "credential",
        "email",
        "e-mail",
        "phone",
        "mobile",
        "telephone",
        "user_name",
        "username",
        "candidate",
        "archive_path",
        "output_path",
        "file_path",
        "directory",
        "明文",
        "密码",
        "口令",
        "候选",
        "路径",
    ]
    .iter()
    .any(|term| normalized.contains(term))
}

fn sanitize_text(value: &str, max_chars: usize) -> String {
    let normalized = value.replace(['\r', '\n', '\0'], " ");
    let lowered = normalized.to_lowercase();
    if [
        "known_password",
        "recovered_password",
        "candidate_text",
        "authorization:",
        "bearer ",
        "明文密码",
    ]
    .iter()
    .any(|term| lowered.contains(term))
    {
        return "[敏感信息已隐藏]".into();
    }
    if contains_absolute_path(&normalized) {
        return "[路径信息已隐藏]".into();
    }

    let mut chars = normalized.chars();
    let mut result = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        result.push('…');
    }
    result
}

fn contains_absolute_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    if value.to_ascii_lowercase().contains("file:///") {
        return true;
    }
    for index in 0..bytes.len() {
        if index + 2 < bytes.len()
            && bytes[index].is_ascii_alphabetic()
            && bytes[index + 1] == b':'
            && matches!(bytes[index + 2], b'\\' | b'/')
            && (index == 0 || !bytes[index - 1].is_ascii_alphanumeric())
        {
            return true;
        }
        if index + 1 < bytes.len() && bytes[index] == b'\\' && bytes[index + 1] == b'\\' {
            return true;
        }
        if index + 1 < bytes.len()
            && bytes[index] == b'~'
            && matches!(bytes[index + 1], b'/' | b'\\')
            && (index == 0 || !bytes[index - 1].is_ascii_alphanumeric())
        {
            return true;
        }
        if index + 1 < bytes.len()
            && bytes[index] == b'/'
            && bytes[index + 1].is_ascii_alphabetic()
            && (index == 0
                || (!bytes[index - 1].is_ascii_alphanumeric()
                    && !matches!(bytes[index - 1], b'/' | b'.')))
        {
            return true;
        }
    }
    false
}

fn normalize_legacy_level(entry: &mut LogEntry) {
    if entry.level == LogLevel::Warn
        && matches!(
            entry.event.as_str(),
            "recovery.cancel_requested" | "recovery.cancelled"
        )
    {
        entry.level = LogLevel::Info;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(max_bytes: u64, retained_files: usize) -> (tempfile::TempDir, LogStore) {
        let directory = tempfile::tempdir().unwrap();
        let store = LogStore::with_limits(
            directory.path().join("logs"),
            max_bytes,
            max_bytes * retained_files as u64,
        )
        .unwrap();
        store.set_max_level(LogLevel::Debug);
        (directory, store)
    }

    #[test]
    fn writes_filters_and_returns_newest_first() {
        let (_directory, store) = store(1024 * 1024, 3);
        store
            .write(
                LogLevel::Info,
                "desktop",
                "app.started",
                "应用启动",
                BTreeMap::new(),
            )
            .unwrap();
        store
            .write(
                LogLevel::Error,
                "recovery",
                "recovery.failed",
                "恢复任务失败",
                BTreeMap::new(),
            )
            .unwrap();

        let result = store
            .list(&LogQuery {
                level: Some(LogLevel::Error),
                search_text: "恢复".into(),
                ..LogQuery::default()
            })
            .unwrap();

        assert_eq!(result.total_count, 2);
        assert_eq!(result.matched_count, 1);
        assert_eq!(result.entries[0].event, "recovery.failed");
        assert_eq!(result.stats.error_count, 1);
    }

    #[test]
    fn filters_attention_levels_together() {
        let (_directory, store) = store(1024 * 1024, 3);
        for (level, event) in [
            (LogLevel::Info, "info"),
            (LogLevel::Warn, "warn"),
            (LogLevel::Error, "error"),
        ] {
            store
                .write(level, "test", event, event, BTreeMap::new())
                .unwrap();
        }

        let result = store
            .list(&LogQuery {
                attention_only: true,
                ..LogQuery::default()
            })
            .unwrap();

        assert_eq!(result.total_count, 3);
        assert_eq!(result.matched_count, 2);
        assert_eq!(
            result
                .entries
                .iter()
                .map(|entry| entry.level)
                .collect::<Vec<_>>(),
            vec![LogLevel::Error, LogLevel::Warn]
        );
    }

    #[test]
    fn treats_legacy_recovery_cancellation_as_information() {
        let (_directory, store) = store(1024 * 1024, 3);
        store
            .write(
                LogLevel::Warn,
                "recovery",
                "recovery.cancelled",
                "恢复任务已取消",
                BTreeMap::new(),
            )
            .unwrap();

        let result = store
            .list(&LogQuery {
                attention_only: true,
                ..LogQuery::default()
            })
            .unwrap();

        assert_eq!(result.total_count, 1);
        assert_eq!(result.matched_count, 0);
        assert_eq!(result.stats.warn_count, 0);
        assert_eq!(result.stats.info_count, 1);
    }

    #[test]
    fn redacts_sensitive_context_and_message_content() {
        let (_directory, store) = store(1024 * 1024, 3);
        let context = BTreeMap::from([
            ("known_password".into(), "hunter2".into()),
            ("apiKey".into(), "sk-private".into()),
            ("contact_email".into(), "private@example.com".into()),
            ("candidate_count".into(), "42".into()),
        ]);
        let entry = store
            .write(
                LogLevel::Info,
                "frontend",
                "ui.error",
                "known_password=hunter2",
                context,
            )
            .unwrap()
            .unwrap();

        assert_eq!(entry.message, "[敏感信息已隐藏]");
        assert_eq!(entry.context["known_password"], "[已隐藏]");
        assert_eq!(entry.context["apiKey"], "[已隐藏]");
        assert_eq!(entry.context["contact_email"], "[已隐藏]");
        assert_eq!(entry.context["candidate_count"], "42");
    }

    #[test]
    fn redacts_absolute_paths_but_not_urls_or_separator_text() {
        assert_eq!(
            sanitize_text(concat!(r"failed at C:\", "Users", r"\alice\archive.7z"), 512),
            "[路径信息已隐藏]"
        );
        assert_eq!(
            sanitize_text(concat!("failed at /", "home", "/alice/archive.7z"), 512),
            "[路径信息已隐藏]"
        );
        assert_eq!(
            sanitize_text(concat!(r#"{"path":"/"#, "home", r#"/alice/archive.7z"}"#), 512),
            "[路径信息已隐藏]"
        );
        assert_eq!(
            sanitize_text(concat!("file:///", "home", "/alice/archive.7z"), 512),
            "[路径信息已隐藏]"
        );
        assert_eq!(
            sanitize_text("failed at ~/private/archive.7z", 512),
            "[路径信息已隐藏]"
        );
        assert_eq!(
            sanitize_text("Hashcat / John · https://example.com", 512),
            "Hashcat / John · https://example.com"
        );
    }

    #[test]
    fn rotates_and_keeps_configured_number_of_files() {
        let (_directory, store) = store(220, 3);
        for index in 0..20 {
            store
                .write(
                    LogLevel::Info,
                    "test",
                    "rotation",
                    &format!("entry-{index}-{}", "x".repeat(80)),
                    BTreeMap::new(),
                )
                .unwrap();
        }

        assert!(store.existing_paths_locked().len() <= 3);
        assert!(store.active_path().is_file());
        assert!(store.archive_path(1).is_file());
    }

    #[test]
    fn lowering_total_capacity_removes_oldest_archives() {
        let (_directory, store) = store(220, 3);
        for index in 0..20 {
            store
                .write(
                    LogLevel::Info,
                    "test",
                    "capacity",
                    &format!("entry-{index}-{}", "x".repeat(80)),
                    BTreeMap::new(),
                )
                .unwrap();
        }
        assert!(store.existing_paths_locked().len() > 1);

        store.set_max_total_bytes(220).unwrap();

        assert_eq!(store.existing_paths_locked(), vec![store.active_path()]);
    }

    #[test]
    fn clear_removes_all_rotated_files() {
        let (_directory, store) = store(220, 3);
        for index in 0..10 {
            store
                .write(
                    LogLevel::Warn,
                    "test",
                    "clear",
                    &format!("entry-{index}-{}", "x".repeat(80)),
                    BTreeMap::new(),
                )
                .unwrap();
        }

        let removed = store.clear().unwrap();
        let result = store.list(&LogQuery::default()).unwrap();

        assert!(removed > 0);
        assert_eq!(result.total_count, 0);
        assert_eq!(result.stats.file_count, 0);
    }

    #[test]
    fn pagination_can_reach_entries_after_the_first_thousand() {
        let (_directory, store) = store(1024 * 1024, 3);
        for index in 0..1_250 {
            store
                .write(
                    LogLevel::Info,
                    "test",
                    &format!("entry-{index}"),
                    "matching",
                    BTreeMap::new(),
                )
                .unwrap();
        }

        for search in ["", "matching"] {
            let page = store
                .list(&LogQuery {
                    search_text: search.into(),
                    skip: 1_000,
                    take: 1_000,
                    ..LogQuery::default()
                })
                .unwrap();
            assert_eq!(page.total_count, 1_250);
            assert_eq!(page.matched_count, 1_250);
            assert_eq!(page.entries.len(), 250);
            assert_eq!(page.entries[0].event, "entry-249");
            assert_eq!(page.entries[249].event, "entry-0");
            assert!(!page.has_more);
        }
    }

    #[test]
    fn snapshot_readers_release_writer_lock_and_exclude_later_appends() {
        let (_directory, store) = store(1024 * 1024, 3);
        store
            .write(LogLevel::Info, "test", "before", "before", BTreeMap::new())
            .unwrap();
        let mut snapshots = store.snapshot_files().unwrap();

        assert!(store.file_lock.try_lock().is_ok());
        store
            .write(LogLevel::Info, "test", "after", "after", BTreeMap::new())
            .unwrap();
        let mut events = Vec::new();
        scan_log_snapshot(&mut snapshots[0], |entry| {
            // This callback can itself log; parsing owns no file_lock.
            store.write(
                LogLevel::Debug,
                "test",
                "during-read",
                "read",
                BTreeMap::new(),
            )?;
            events.push(entry.event);
            Ok(())
        })
        .unwrap();

        assert_eq!(events, ["before"]);
        assert_eq!(store.list(&LogQuery::default()).unwrap().total_count, 3);
    }

    #[test]
    fn captured_file_survives_rotation_and_does_not_repopulate_stale_cache() {
        let (_directory, store) = store(220, 3);
        store
            .write(
                LogLevel::Info,
                "test",
                "original",
                &"x".repeat(100),
                BTreeMap::new(),
            )
            .unwrap();
        let mut snapshots = store.snapshot_files().unwrap();
        for index in 0..10 {
            store
                .write(
                    LogLevel::Info,
                    "test",
                    &format!("later-{index}"),
                    &"x".repeat(100),
                    BTreeMap::new(),
                )
                .unwrap();
        }

        let mut events = Vec::new();
        let summary = scan_log_snapshot(&mut snapshots[0], |entry| {
            events.push(entry.event);
            Ok(())
        })
        .unwrap();
        store.cache_summary(&snapshots[0], &summary).unwrap();

        assert_eq!(events, ["original"]);
        assert!(
            !store
                .summary_cache
                .lock()
                .unwrap()
                .contains_key(&snapshots[0].path)
        );
        let current = store.list(&LogQuery::default()).unwrap();
        assert_eq!(current.entries[0].event, "later-9");
    }

    #[test]
    fn appending_updates_cached_statistics_and_preserves_legacy_level_mapping() {
        let (_directory, store) = store(1024 * 1024, 3);
        store
            .write(LogLevel::Info, "test", "first", "first", BTreeMap::new())
            .unwrap();
        store.list(&LogQuery::default()).unwrap();
        store
            .write(
                LogLevel::Warn,
                "recovery",
                "recovery.cancelled",
                "cancelled",
                BTreeMap::new(),
            )
            .unwrap();

        let snapshots = store.snapshot_files().unwrap();
        let summary = snapshots[0]
            .summary
            .as_ref()
            .expect("append should update the existing summary");
        assert_eq!(summary.entry_count, 2);
        assert_eq!(summary.stats.info_count, 2);
        assert_eq!(summary.stats.warn_count, 0);
        let latest = store
            .list(&LogQuery {
                take: 1,
                ..LogQuery::default()
            })
            .unwrap();
        assert_eq!(latest.entries[0].event, "recovery.cancelled");
        assert_eq!(latest.matched_count, 2);
    }

    #[test]
    fn reverse_reader_handles_utf8_across_chunks_and_malformed_lines() {
        let (_directory, store) = store(1024 * 1024, 3);
        let entry = LogEntry {
            id: "large".into(),
            timestamp_ms: 1,
            level: LogLevel::Info,
            source: "test".into(),
            event: "large".into(),
            message: "跨块".repeat(30_000),
            context: BTreeMap::new(),
        };
        let mut last = entry.clone();
        last.id = "last".into();
        last.event = "last".into();
        last.message = "跨块 end".into();
        let content = format!(
            "\n{}\r\ninvalid\n{}",
            serde_json::to_string(&entry).unwrap(),
            serde_json::to_string(&last).unwrap()
        );
        fs::write(store.active_path(), content).unwrap();

        let plain = store.list(&LogQuery::default()).unwrap();
        let searched = store
            .list(&LogQuery {
                search_text: "跨块".into(),
                ..LogQuery::default()
            })
            .unwrap();

        assert_eq!(
            plain
                .entries
                .iter()
                .map(|entry| entry.event.as_str())
                .collect::<Vec<_>>(),
            ["last", "large"]
        );
        assert_eq!(searched.entries, plain.entries);
        assert_eq!(searched.total_count, 2);
        assert_eq!(searched.stats.unreadable_line_count, 2);
        assert_eq!(searched.stats, plain.stats);
    }

    #[test]
    fn appending_after_an_unterminated_record_rebuilds_statistics() {
        let (_directory, store) = store(1024 * 1024, 3);
        fs::write(store.active_path(), b"unfinished-record").unwrap();
        assert_eq!(
            store
                .list(&LogQuery::default())
                .unwrap()
                .stats
                .unreadable_line_count,
            1
        );

        store
            .write(
                LogLevel::Info,
                "test",
                "appended",
                "appended",
                BTreeMap::new(),
            )
            .unwrap();

        let listed = store.list(&LogQuery::default()).unwrap();
        let searched = store
            .list(&LogQuery {
                search_text: "appended".into(),
                ..LogQuery::default()
            })
            .unwrap();
        assert_eq!(listed.total_count, 0);
        assert_eq!(listed.stats.unreadable_line_count, 1);
        assert_eq!(listed.stats, searched.stats);
    }

    #[test]
    fn reverse_reader_handles_newlines_exactly_at_chunk_boundaries() {
        let (_directory, store) = store(1024 * 1024, 3);
        for length in [65_534, 65_535, 65_536, 65_537] {
            for suffix in [
                b"\nlast".as_slice(),
                b"\nlast\n".as_slice(),
                b"\n\nlast\n".as_slice(),
            ] {
                let mut content = vec![b'x'; length];
                content.extend_from_slice(suffix);
                fs::write(store.active_path(), &content).unwrap();
                let mut snapshot = store.snapshot_files().unwrap().remove(0);
                let mut reversed = Vec::new();
                visit_log_lines_reverse(&mut snapshot, |line| {
                    reversed.push(line.to_vec());
                    true
                })
                .unwrap();
                let mut expected = BufReader::new(content.as_slice())
                    .split(b'\n')
                    .map(Result::unwrap)
                    .collect::<Vec<_>>();
                expected.reverse();
                assert_eq!(reversed, expected, "length: {length}, suffix: {suffix:?}");
            }
        }
    }
}
