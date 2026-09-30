use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use super::super::runner::CancellationToken;
use super::{
    RecoveryDictionary, RecoveryError, RecoveryJob, RecoveryOperation, RecoveryPhase,
    RecoveryToolPaths, RecoveryUpdate, RecursiveRecoveryOptions, RecursiveRecoveryResult,
    SkippedScanDirectory, detect_nested_archive_format, ensure_not_cancelled, path_for_display,
    recover_single_archive, timed_operation,
};

const SCAN_PROGRESS_INTERVAL_FILES: u64 = 128;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct NestedArchiveTask {
    pub(super) archive_path: PathBuf,
    pub(super) depth: u32,
    pub(super) inherited_password: Option<String>,
}

pub(super) struct NestedOutputTransaction {
    destination: PathBuf,
    staging: PathBuf,
    committed: bool,
}

impl NestedOutputTransaction {
    pub(super) fn new(destination: PathBuf) -> Self {
        let staging = resolve_nested_staging_directory(&destination);
        Self {
            destination,
            staging,
            committed: false,
        }
    }

    pub(super) fn staging_directory(&self) -> &Path {
        &self.staging
    }

    pub(super) fn commit(&mut self) -> Result<(), RecoveryError> {
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct FileSnapshot {
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
pub(super) struct RecursiveProgressSnapshot {
    pub(super) discovered_nested_archives: u32,
    pub(super) extracted_nested_archives: u32,
    pub(super) skipped_nested_archives: u32,
    pub(super) scanned_files: u64,
}

struct RecursiveRecoveryState {
    options: RecursiveRecoveryOptions,
    processed_archives: HashSet<PathBuf>,
    queued_tasks: HashMap<PathBuf, NestedArchiveTask>,
    discovered_nested_archives: u32,
    extracted_nested_archives: u32,
    skipped_nested_archives: u32,
    scanned_files: u64,
    skipped_directories: Vec<SkippedScanDirectory>,
    depth_limit_reached: bool,
    count_limit_reached: bool,
}

impl RecursiveRecoveryState {
    fn new(options: RecursiveRecoveryOptions) -> Self {
        Self {
            options,
            processed_archives: HashSet::new(),
            queued_tasks: HashMap::new(),
            discovered_nested_archives: 0,
            extracted_nested_archives: 0,
            skipped_nested_archives: 0,
            scanned_files: 0,
            skipped_directories: Vec::new(),
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
        RecoveryUpdate::stage(RecoveryPhase::Recursive, None::<String>, message)
            .with_recursive_context(depth, archive_path, &self.progress_snapshot())
    }
}

pub fn recover_and_extract_recursive_lazy(
    job: &RecoveryJob,
    tools: &RecoveryToolPaths,
    cancellation: &CancellationToken,
    options: RecursiveRecoveryOptions,
    precomputed_root_fingerprint_sha256: Option<String>,
    prepare_dictionary: impl FnOnce() -> Result<RecoveryDictionary, RecoveryError>,
    report: impl FnMut(RecoveryUpdate),
) -> Result<RecursiveRecoveryResult, RecoveryError> {
    run_recursive_recovery(
        job,
        tools,
        cancellation,
        options,
        precomputed_root_fingerprint_sha256,
        None,
        prepare_dictionary,
        report,
    )
}

/// Scan previously omitted output directories, retaining the original depth and
/// archive-count limits. The outer archive is neither read nor extracted again.
pub fn resume_recursive_scan_lazy(
    job: &RecoveryJob,
    tools: &RecoveryToolPaths,
    cancellation: &CancellationToken,
    mut options: RecursiveRecoveryOptions,
    previous: RecursiveRecoveryResult,
    prepare_dictionary: impl FnOnce() -> Result<RecoveryDictionary, RecoveryError>,
    report: impl FnMut(RecoveryUpdate),
) -> Result<RecursiveRecoveryResult, RecoveryError> {
    if !previous.root.success || previous.skipped_scan_directories.is_empty() {
        return Err(RecoveryError::Message("没有可补扫的已解压目录。".into()));
    }
    options.enabled = true;
    options.max_files_per_directory = 0;
    run_recursive_recovery(
        job,
        tools,
        cancellation,
        options,
        None,
        Some(previous),
        prepare_dictionary,
        report,
    )
}

#[allow(clippy::too_many_arguments)]
fn run_recursive_recovery(
    job: &RecoveryJob,
    tools: &RecoveryToolPaths,
    cancellation: &CancellationToken,
    options: RecursiveRecoveryOptions,
    precomputed_root_fingerprint_sha256: Option<String>,
    previous: Option<RecursiveRecoveryResult>,
    prepare_dictionary: impl FnOnce() -> Result<RecoveryDictionary, RecoveryError>,
    mut report: impl FnMut(RecoveryUpdate),
) -> Result<RecursiveRecoveryResult, RecoveryError> {
    let before_root_extraction = if let Some(previous) = &previous {
        previous.resume_baseline.clone()
    } else if options.enabled {
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

    let (remaining_bytes, remaining_entries) = previous
        .as_ref()
        .map(|previous| previous.remaining_disk_budget)
        .unwrap_or((options.max_total_bytes, options.max_total_entries));
    let disk_budget = super::TaskDiskBudget::new(
        remaining_bytes.min(options.max_total_bytes),
        remaining_entries.min(options.max_total_entries),
    );
    let mut root = if let Some(previous) = &previous {
        let mut root = previous.root.clone();
        root.cancelled = false;
        root.recovered_archive = None;
        root.message = "已对现有输出补扫。".into();
        root
    } else {
        recover_single_archive(
            job,
            tools,
            cancellation,
            options.compute_mode,
            &disk_budget,
            precomputed_root_fingerprint_sha256.as_deref(),
            &mut dictionary_provider,
            &mut report,
        )?
    };
    let mut recovered_passwords = Vec::new();
    if let Some(password) = root.password.as_ref() {
        recovered_passwords.push(password.clone());
    }
    let mut recovered_archives = root
        .recovered_archive
        .clone()
        .into_iter()
        .collect::<Vec<_>>();
    let mut completed_archive_paths = if root.success {
        vec![job.archive_path.clone()]
    } else {
        Vec::new()
    };
    let mut skipped_archive_paths = Vec::new();
    let mut pending_archive_paths = Vec::new();
    let mut scan_interrupted = false;
    let mut budget_limit_reached = false;
    let mut content_directories = vec![job.output_directory.clone()];
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
            completed_archive_paths,
            skipped_archive_paths,
            pending_archive_paths,
            scan_interrupted,
            budget_limit_reached,
            skipped_scan_directories: Vec::new(),
            content_directories,
            remaining_disk_budget: disk_budget.remaining(),
            resume_baseline: HashMap::new(),
            pending_tasks: Vec::new(),
        });
    }

    let mut state = RecursiveRecoveryState::new(options);
    let mut pending = VecDeque::new();
    let scan_roots = if let Some(previous) = previous {
        recovered_passwords.clear();
        state.discovered_nested_archives = previous.discovered_nested_archives;
        state.extracted_nested_archives = previous.extracted_nested_archives;
        state.skipped_nested_archives = previous.skipped_nested_archives;
        state.scanned_files = previous.scanned_files;
        state.depth_limit_reached = previous.depth_limit_reached;
        state.count_limit_reached = previous.count_limit_reached;
        completed_archive_paths = previous.completed_archive_paths;
        state
            .processed_archives
            .extend(completed_archive_paths.iter().cloned());
        skipped_archive_paths = previous.skipped_archive_paths;
        pending_archive_paths = previous.pending_archive_paths;
        content_directories = previous.content_directories;
        for task in previous.pending_tasks {
            state
                .queued_tasks
                .insert(task.archive_path.clone(), task.clone());
            pending.push_back(task);
        }
        previous.skipped_scan_directories
    } else {
        vec![SkippedScanDirectory {
            path: job.output_directory.clone(),
            depth: 1,
            inherited_password: root.password.clone().or_else(|| job.known_password.clone()),
        }]
    };
    // Keep published outputs and their credentials outside the cancellable work.
    let recursive_outcome = (|| -> Result<(), RecoveryError> {
        for (index, scan_root) in scan_roots.iter().enumerate() {
            report(
                state
                    .update(
                        format!("正在扫描第 {} 层已有输出。", scan_root.depth),
                        scan_root.depth,
                        &scan_root.path,
                    )
                    .with_root_extraction_completed(),
            );
            let initial_scan = scan_output(
                scan_root,
                &before_root_extraction,
                &mut state,
                cancellation,
                &mut report,
            )?;
            pending_archive_paths.extend(initial_scan.archives.iter().cloned());
            if initial_scan.cancelled {
                state
                    .skipped_directories
                    .extend(scan_roots[index..].iter().cloned());
                scan_interrupted = true;
                return Err(RecoveryError::Cancelled);
            }
            for archive_path in initial_scan.archives {
                let task = NestedArchiveTask {
                    archive_path,
                    depth: scan_root.depth,
                    inherited_password: scan_root.inherited_password.clone(),
                };
                state
                    .queued_tasks
                    .insert(task.archive_path.clone(), task.clone());
                pending.push_back(task);
            }
        }

        while let Some(nested) = pending.pop_front() {
            ensure_not_cancelled(cancellation)?;
            if !nested.archive_path.is_file() {
                pending_archive_paths.retain(|path| path != &nested.archive_path);
                skipped_archive_paths.push(nested.archive_path.clone());
                state.skipped_nested_archives = state.skipped_nested_archives.saturating_add(1);
                report(state.update(
                    "嵌套压缩包已不存在，已跳过。",
                    nested.depth,
                    &nested.archive_path,
                ));
                continue;
            }
            if !state.processed_archives.insert(nested.archive_path.clone()) {
                pending_archive_paths.retain(|path| path != &nested.archive_path);
                continue;
            }
            if state.discovered_nested_archives >= state.options.max_nested_archives {
                pending_archive_paths.retain(|path| path != &nested.archive_path);
                skipped_archive_paths.push(nested.archive_path.clone());
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
                pending_archive_paths.retain(|path| path != &nested.archive_path);
                skipped_archive_paths.push(nested.archive_path.clone());
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
                &disk_budget,
                None,
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
                Ok(result) if result.success => {
                    if let Err(error) = output_transaction.commit() {
                        pending_archive_paths.retain(|path| path != &nested.archive_path);
                        skipped_archive_paths.push(nested.archive_path.clone());
                        state.skipped_nested_archives =
                            state.skipped_nested_archives.saturating_add(1);
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
                    pending_archive_paths.retain(|path| path != &nested.archive_path);
                    completed_archive_paths.push(nested.archive_path.clone());
                    state.extracted_nested_archives =
                        state.extracted_nested_archives.saturating_add(1);
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
                    content_directories.retain(|path| !nested_output.starts_with(path));
                    content_directories.push(nested_output.clone());
                    report(state.update(
                        format!(
                            "已解开第 {} 层嵌套压缩包：{}。",
                            nested.depth,
                            archive_display_name(&nested.archive_path)
                        ),
                        nested.depth,
                        &nested.archive_path,
                    ));
                    let next_depth = nested.depth.saturating_add(1);
                    let scan_root = SkippedScanDirectory {
                        path: nested_output,
                        depth: next_depth,
                        inherited_password: child_password.clone(),
                    };
                    let child_scan = scan_output(
                        &scan_root,
                        &before_nested_extraction,
                        &mut state,
                        cancellation,
                        &mut report,
                    )?;
                    pending_archive_paths.extend(child_scan.archives.iter().cloned());
                    if child_scan.cancelled {
                        state.skipped_directories.push(scan_root);
                        scan_interrupted = true;
                        return Err(RecoveryError::Cancelled);
                    }
                    for archive_path in child_scan.archives {
                        let task = NestedArchiveTask {
                            archive_path,
                            depth: next_depth,
                            inherited_password: child_password.clone(),
                        };
                        state
                            .queued_tasks
                            .insert(task.archive_path.clone(), task.clone());
                        pending.push_back(task);
                    }
                }
                Ok(_) => {
                    pending_archive_paths.retain(|path| path != &nested.archive_path);
                    skipped_archive_paths.push(nested.archive_path.clone());
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
                Err(error @ RecoveryError::BudgetExceeded(_)) => return Err(error),
                Err(error) => {
                    pending_archive_paths.retain(|path| path != &nested.archive_path);
                    skipped_archive_paths.push(nested.archive_path.clone());
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
        ensure_not_cancelled(cancellation)
    })();
    match recursive_outcome {
        Err(RecoveryError::Cancelled) => root.cancelled = true,
        Err(RecoveryError::BudgetExceeded(message)) => {
            budget_limit_reached = true;
            root.message.push_str(&format!(" {message}"));
        }
        Err(error) => return Err(error),
        Ok(()) => {}
    }

    let mut seen_directories = HashSet::new();
    state
        .skipped_directories
        .retain(|directory| seen_directories.insert(directory.path.clone()));
    let mut seen_pending = HashSet::new();
    pending_archive_paths.retain(|path| seen_pending.insert(path.clone()));
    let mut summary = format!(
        "{}，共检查 {} 个文件，已自动解开 {} 个嵌套压缩包",
        if budget_limit_reached {
            "达到累计磁盘预算，已停止递归；已完成输出保留"
        } else if root.cancelled {
            "递归处理已取消；主归档及已完成的输出已保留"
        } else if !state.skipped_directories.is_empty()
            || state.depth_limit_reached
            || state.count_limit_reached
        {
            "解压完成，递归扫描未覆盖全部目录"
        } else {
            "递归扫描完成"
        },
        state.scanned_files,
        state.extracted_nested_archives
    );
    if state.skipped_nested_archives > 0 {
        summary.push_str(&format!("，跳过 {} 个", state.skipped_nested_archives));
    }
    if !state.skipped_directories.is_empty() {
        summary.push_str(&format!(
            "；仍有 {} 个目录及其子目录未完成嵌套扫描",
            state.skipped_directories.len()
        ));
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
        completed_archive_paths,
        skipped_archive_paths,
        pending_tasks: pending_archive_paths
            .iter()
            .filter_map(|path| state.queued_tasks.get(path).cloned())
            .collect(),
        pending_archive_paths,
        scan_interrupted,
        budget_limit_reached,
        remaining_disk_budget: disk_budget.remaining(),
        resume_baseline: before_root_extraction
            .into_iter()
            .filter(|(path, _)| {
                state
                    .skipped_directories
                    .iter()
                    .any(|directory| path.starts_with(&directory.path))
            })
            .collect(),
        skipped_scan_directories: state.skipped_directories,
        content_directories: content_directories
            .into_iter()
            .map(resolve_content_directory)
            .collect(),
    })
}

fn scan_output(
    scan_root: &SkippedScanDirectory,
    before: &HashMap<PathBuf, FileSnapshot>,
    state: &mut RecursiveRecoveryState,
    cancellation: &CancellationToken,
    report: &mut impl FnMut(RecoveryUpdate),
) -> Result<ArchiveScanResult, RecoveryError> {
    let base = state.scanned_files;
    let depth = scan_root.depth;
    let limit = state.options.max_files_per_directory;
    let excluded = state
        .processed_archives
        .iter()
        .chain(state.queued_tasks.keys())
        .cloned()
        .collect();
    let result = timed_operation(RecoveryOperation::Scan, report, |report| {
        if !fs::symlink_metadata(&scan_root.path)?.is_dir() {
            return Err(RecoveryError::Message("目录已不存在或已被替换。".into()));
        }
        find_new_or_changed_archives(
            &scan_root.path,
            before,
            &excluded,
            state.collection_limit(),
            limit,
            cancellation,
            |scanned, found, skipped| {
                state.scanned_files = base.saturating_add(scanned);
                if let Some(path) = skipped {
                    state.skipped_directories.push(SkippedScanDirectory {
                        path: path.to_path_buf(),
                        depth,
                        inherited_password: scan_root.inherited_password.clone(),
                    });
                    report(state.update(scan_skip_message(path, limit), depth, path));
                } else {
                    report(state.update(
                        format!("正在扫描第 {depth} 层输出：已检查 {scanned} 个文件，发现 {found} 个归档。"),
                        depth, &scan_root.path,
                    ).with_scan_progress());
                }
            },
        )
    });
    match result {
        Err(error) if !matches!(error, RecoveryError::Cancelled) => {
            state.skipped_directories.push(scan_root.clone());
            report(state.update(
                format!(
                    "目录 {} 未能完整扫描，已保留补扫入口：{error}",
                    path_for_display(&scan_root.path)
                ),
                depth,
                &scan_root.path,
            ));
            Ok(ArchiveScanResult {
                archives: Vec::new(),
                cancelled: false,
            })
        }
        other => other,
    }
}

// Follow only unambiguous directory wrappers. Never move files, follow symlinks,
// or hide a sibling file/directory from the default open action.
fn resolve_content_directory(mut directory: PathBuf) -> PathBuf {
    for _ in 0..64 {
        let Ok(mut entries) = fs::read_dir(&directory) else {
            break;
        };
        let Some(Ok(entry)) = entries.next() else {
            break;
        };
        if entries.next().is_some() {
            break;
        }
        if !entry
            .file_type()
            .is_ok_and(|kind| kind.is_dir() && !kind.is_symlink())
        {
            break;
        }
        directory = entry.path();
    }
    directory
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

struct ArchiveScanResult {
    archives: Vec<PathBuf>,
    cancelled: bool,
}

fn find_new_or_changed_archives(
    directory: &Path,
    before: &HashMap<PathBuf, FileSnapshot>,
    excluded: &HashSet<PathBuf>,
    max_archives: usize,
    max_files_per_directory: u32,
    cancellation: &CancellationToken,
    mut report_progress: impl FnMut(u64, usize, Option<&Path>),
) -> Result<ArchiveScanResult, RecoveryError> {
    if max_archives == 0 {
        return Ok(ArchiveScanResult {
            archives: Vec::new(),
            cancelled: false,
        });
    }
    let mut archives = Vec::with_capacity(max_archives.min(16));
    let mut zip_archives = HashSet::new();
    let mut scanned_files = 0u64;
    let mut last_reported = 0u64;
    let mut last_report_at = Instant::now();
    let scan_result =
        visit_file_entries(directory, cancellation, max_files_per_directory, |entry| {
            let path = match entry {
                FileVisit::File(path) => path,
                FileVisit::SkippedDirectory(path) => {
                    report_progress(scanned_files, archives.len(), Some(&path));
                    return true;
                }
            };
            scanned_files = scanned_files.saturating_add(1);
            if let Some(current) = capture_file_state(&path)
                && before
                    .get(&path)
                    .is_none_or(|previous| current.has_changed_since(previous))
            {
                match super::archive::resolve_zip_archive_path(&path) {
                    Ok(Some(primary))
                        if !excluded.contains(&primary) && zip_archives.insert(primary.clone()) =>
                    {
                        archives.push(primary)
                    }
                    Ok(None)
                        if !excluded.contains(&path)
                            && detect_nested_archive_format(&path).is_ok() =>
                    {
                        archives.push(path)
                    }
                    _ => {}
                }
            }
            if scanned_files == 1
                || scanned_files.is_multiple_of(SCAN_PROGRESS_INTERVAL_FILES)
                || last_report_at.elapsed() >= Duration::from_millis(250)
            {
                report_progress(scanned_files, archives.len(), None);
                last_reported = scanned_files;
                last_report_at = Instant::now();
            }
            archives.len() < max_archives
        });
    let cancelled = match scan_result {
        Err(RecoveryError::Cancelled) => true,
        Err(error) => return Err(error),
        Ok(()) => cancellation.is_cancelled(),
    };
    if scanned_files != last_reported {
        report_progress(scanned_files, archives.len(), None);
    }
    Ok(ArchiveScanResult {
        archives,
        cancelled,
    })
}

fn visit_files(
    directory: &Path,
    cancellation: &CancellationToken,
    mut visit: impl FnMut(PathBuf) -> bool,
) -> Result<(), RecoveryError> {
    // Snapshots must remain exhaustive so pre-existing files cannot become
    // "new" if a directory crosses the threshold during extraction.
    visit_file_entries(directory, cancellation, 0, |entry| match entry {
        FileVisit::File(path) => visit(path),
        FileVisit::SkippedDirectory(_) => unreachable!("unlimited snapshot"),
    })
}

enum FileVisit {
    File(PathBuf),
    SkippedDirectory(PathBuf),
}

fn scan_skip_message(directory: &Path, limit: u32) -> String {
    format!(
        "目录 {} 的直属文件超过 {limit} 个，已跳过该目录及其子目录的嵌套压缩包扫描；已解压内容保留。",
        path_for_display(directory)
    )
}

fn visit_file_entries(
    directory: &Path,
    cancellation: &CancellationToken,
    max_files_per_directory: u32,
    mut visit: impl FnMut(FileVisit) -> bool,
) -> Result<(), RecoveryError> {
    if !directory.is_dir() {
        return Ok(());
    }
    let mut pending = vec![directory.to_path_buf()];
    'directories: while let Some(current) = pending.pop() {
        ensure_not_cancelled(cancellation)?;
        let entries = fs::read_dir(&current)?;
        let mut files = Vec::new();
        let mut children = Vec::new();
        for entry in entries {
            ensure_not_cancelled(cancellation)?;
            let entry = entry?;
            let file_type = entry.file_type()?;
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                children.push(entry.path());
            } else if file_type.is_file() {
                if max_files_per_directory == 0 {
                    if !visit(FileVisit::File(entry.path())) {
                        return Ok(());
                    }
                } else {
                    files.push(entry.path());
                    if files.len() > max_files_per_directory as usize {
                        // Decide before inspecting any file contents or descending.
                        // Enumerating limit + 1 direct files is sufficient.
                        if !visit(FileVisit::SkippedDirectory(current)) {
                            return Ok(());
                        }
                        continue 'directories;
                    }
                }
            }
        }
        pending.extend(children);
        for file in files {
            ensure_not_cancelled(cancellation)?;
            if !visit(FileVisit::File(file)) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_directory_follows_single_wrappers_but_preserves_branches_and_files() {
        let directory = tempfile::tempdir().unwrap();
        let wrapper = directory.path().join("wrapper");
        let content = wrapper.join("game");
        fs::create_dir_all(&content).unwrap();
        fs::write(content.join("payload.txt"), b"content").unwrap();
        assert_eq!(
            resolve_content_directory(directory.path().to_path_buf()),
            content
        );
        fs::write(wrapper.join("readme.txt"), b"keep visible").unwrap();
        assert_eq!(
            resolve_content_directory(directory.path().to_path_buf()),
            wrapper
        );
        fs::create_dir(directory.path().join("other")).unwrap();
        assert_eq!(
            resolve_content_directory(directory.path().to_path_buf()),
            directory.path()
        );
        assert!(content.join("payload.txt").is_file());
    }

    fn write_files(directory: &Path, count: usize) {
        fs::create_dir_all(directory).unwrap();
        for index in 0..count {
            fs::write(
                directory.join(format!("{index}.jpg")),
                super::super::archive::SEVEN_ZIP_SIGNATURE,
            )
            .unwrap();
        }
    }

    fn scan(directory: &Path, limit: u32) -> (Vec<PathBuf>, Vec<PathBuf>, u64) {
        let mut skipped = Vec::new();
        let mut scanned = 0;
        let result = find_new_or_changed_archives(
            directory,
            &HashMap::new(),
            &HashSet::new(),
            100,
            limit,
            &CancellationToken::default(),
            |count, _, skipped_directory| {
                scanned = count;
                if let Some(directory) = skipped_directory {
                    skipped.push(directory.to_path_buf());
                }
            },
        )
        .unwrap();
        assert!(!result.cancelled);
        (result.archives, skipped, scanned)
    }

    #[test]
    fn scan_limit_counts_direct_files_and_applies_before_content_detection() {
        for count in [0, 9, 10, 11] {
            let dir = tempfile::tempdir().unwrap();
            write_files(dir.path(), count);
            let (archives, skipped, scanned) = scan(dir.path(), 10);
            if count <= 10 {
                assert_eq!(archives.len(), count);
                assert_eq!(scanned, count as u64);
                assert!(skipped.is_empty());
            } else {
                assert!(archives.is_empty());
                assert_eq!(scanned, 0);
                assert_eq!(skipped, [dir.path()]);
            }
        }
    }

    #[test]
    fn scan_limit_skips_descendants_but_continues_other_directories() {
        let dir = tempfile::tempdir().unwrap();
        let crowded = dir.path().join("crowded");
        write_files(&crowded, 11);
        write_files(&crowded.join("nested"), 1);
        // Subdirectories do not count towards the direct file limit.
        for index in 0..12 {
            write_files(&dir.path().join(format!("sibling-{index}")), 1);
        }
        let (archives, skipped, scanned) = scan(dir.path(), 10);
        assert_eq!(skipped.as_slice(), std::slice::from_ref(&crowded));
        assert_eq!(archives.len(), 12);
        assert_eq!(scanned, 12);
        assert!(archives.iter().all(|path| !path.starts_with(&crowded)));
    }

    #[test]
    fn scan_limit_can_be_disabled_or_customized_and_snapshots_stay_complete() {
        let dir = tempfile::tempdir().unwrap();
        write_files(dir.path(), 11);
        assert_eq!(scan(dir.path(), 0).0.len(), 11);
        assert_eq!(scan(dir.path(), 11).0.len(), 11);
        assert_eq!(scan(dir.path(), 2).2, 0);
        let before = capture_file_snapshot(dir.path(), &CancellationToken::default()).unwrap();
        assert_eq!(before.len(), 11);
        fs::remove_file(dir.path().join("10.jpg")).unwrap();
        let result = find_new_or_changed_archives(
            dir.path(),
            &before,
            &HashSet::new(),
            100,
            10,
            &CancellationToken::default(),
            |_, _, _| {},
        )
        .unwrap();
        assert!(
            result.archives.is_empty(),
            "pre-existing archives must not become new when a directory shrinks"
        );
    }

    #[test]
    fn scan_limit_still_observes_cancellation() {
        let dir = tempfile::tempdir().unwrap();
        write_files(dir.path(), 11);
        let cancellation = CancellationToken::default();
        cancellation.cancel();
        let result = find_new_or_changed_archives(
            dir.path(),
            &HashMap::new(),
            &HashSet::new(),
            100,
            10,
            &cancellation,
            |_, _, _| {},
        )
        .unwrap();
        assert!(result.cancelled);
        assert!(result.archives.is_empty());
    }
}
