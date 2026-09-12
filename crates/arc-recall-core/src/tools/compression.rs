use std::collections::HashSet;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::runner::{CancellationToken, ProcessRequest, ProcessRunnerError, run_process};

const COMPRESSION_TIMEOUT: Duration = Duration::from_secs(24 * 60 * 60);
const COMPRESSION_OUTPUT_LIMIT: usize = 256 * 1024;
const SUPPORTED_LEVELS: [u8; 6] = [0, 1, 3, 5, 7, 9];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum CompressionFormat {
    #[default]
    SevenZip,
    Zip,
}

impl CompressionFormat {
    pub const fn extension(self) -> &'static str {
        match self {
            Self::SevenZip => "7z",
            Self::Zip => "zip",
        }
    }

    const fn seven_zip_type(self) -> &'static str {
        match self {
            Self::SevenZip => "-t7z",
            Self::Zip => "-tzip",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CompressionPhase {
    Preparing,
    Compressing,
    Completed,
    Cancelled,
    Failed,
}

#[derive(Clone)]
pub struct CompressionJob {
    pub sources: Vec<PathBuf>,
    pub output_directory: Option<PathBuf>,
    pub base_name: String,
    pub format: CompressionFormat,
    pub level: u8,
    pub password: Option<String>,
    pub encrypt_file_names: bool,
    pub work_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompressionUpdate {
    pub phase: CompressionPhase,
    pub message: String,
    pub processed_source_count: u64,
    pub total_source_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompressionResult {
    pub output_path: PathBuf,
    pub source_count: u64,
}

pub struct PreparedCompressionJob {
    source_groups: Vec<CompressionSourceGroup>,
    output_path: PathBuf,
    temporary_path: PathBuf,
    format: CompressionFormat,
    level: u8,
    password: Option<String>,
    encrypt_file_names: bool,
    source_count: u64,
}

impl PreparedCompressionJob {
    pub fn output_path(&self) -> &Path {
        &self.output_path
    }

    pub const fn source_count(&self) -> u64 {
        self.source_count
    }
}

struct CompressionSourceGroup {
    current_directory: PathBuf,
    source_names: Vec<OsString>,
}

#[derive(Debug, thiserror::Error)]
pub enum CompressionError {
    #[error("{0}")]
    InvalidRequest(String),
    #[error("无法访问压缩源“{path}”：{source}")]
    SourceIo {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("无法准备输出目录：{0}")]
    OutputIo(#[source] std::io::Error),
    #[error("7-Zip 执行失败：{0}")]
    Process(#[from] ProcessRunnerError),
    #[error("7-Zip 压缩失败：{0}")]
    SevenZip(String),
    #[error("压缩任务已取消")]
    Cancelled,
}

pub fn prepare_compression(
    job: CompressionJob,
) -> Result<PreparedCompressionJob, CompressionError> {
    if job.sources.is_empty() {
        return Err(CompressionError::InvalidRequest(
            "请至少选择一个文件或文件夹。".into(),
        ));
    }
    if !SUPPORTED_LEVELS.contains(&job.level) {
        return Err(CompressionError::InvalidRequest(
            "压缩级别必须是 0、1、3、5、7 或 9。".into(),
        ));
    }
    if job.encrypt_file_names && job.format != CompressionFormat::SevenZip {
        return Err(CompressionError::InvalidRequest(
            "仅 7z 格式支持文件名加密。".into(),
        ));
    }
    if job.encrypt_file_names && job.password.as_deref().is_none_or(str::is_empty) {
        return Err(CompressionError::InvalidRequest(
            "开启文件名加密前需要设置密码。".into(),
        ));
    }
    if job.password.as_deref().is_some_and(str::is_empty) {
        return Err(CompressionError::InvalidRequest(
            "压缩密码不能为空。".into(),
        ));
    }

    let base_name = sanitize_archive_base_name(&job.base_name)?;
    let canonical_sources = canonicalize_sources(&job.sources)?;
    let first_source_parent = canonical_sources[0]
        .parent()
        .ok_or_else(|| CompressionError::InvalidRequest("无法确定首个来源的上级目录。".into()))?
        .to_path_buf();
    let sources = remove_nested_sources(canonical_sources);
    validate_unique_root_names(&sources)?;
    let source_count = sources.len() as u64;
    let source_groups = group_sources_by_parent(&sources)?;

    let output_directory = job.output_directory.unwrap_or(first_source_parent);
    if !output_directory.is_absolute() {
        return Err(CompressionError::InvalidRequest(
            "输出目录必须使用绝对路径。".into(),
        ));
    }
    fs::create_dir_all(&output_directory).map_err(CompressionError::OutputIo)?;
    if !output_directory.is_dir() {
        return Err(CompressionError::InvalidRequest(
            "输出位置不是目录。".into(),
        ));
    }

    let preferred_output = output_directory.join(format!("{base_name}.{}", job.format.extension()));
    let output_path = resolve_available_archive_path(&preferred_output);
    let temporary_path = temporary_archive_path(&output_path, &job.work_id);

    Ok(PreparedCompressionJob {
        source_groups,
        output_path,
        temporary_path,
        format: job.format,
        level: job.level,
        password: job.password,
        encrypt_file_names: job.encrypt_file_names,
        source_count,
    })
}

pub fn compress_archive(
    job: PreparedCompressionJob,
    seven_zip: &Path,
    cancellation: &CancellationToken,
    mut on_update: impl FnMut(CompressionUpdate),
) -> Result<CompressionResult, CompressionError> {
    if !seven_zip.is_file() {
        return Err(CompressionError::InvalidRequest(
            "7-Zip 引擎不存在或不可运行。".into(),
        ));
    }
    if cancellation.is_cancelled() {
        return Err(CompressionError::Cancelled);
    }

    let partial = tempfile::TempPath::try_from_path(job.temporary_path.clone())
        .map_err(CompressionError::OutputIo)?;
    let total = job.source_count;
    on_update(CompressionUpdate {
        phase: CompressionPhase::Preparing,
        message: format!("已准备 {total} 个来源，正在创建临时归档。"),
        processed_source_count: 0,
        total_source_count: total,
    });

    let mut processed = 0_u64;
    for group in &job.source_groups {
        if cancellation.is_cancelled() {
            return Err(CompressionError::Cancelled);
        }
        let mut request = ProcessRequest::new(seven_zip);
        request.current_dir = Some(group.current_directory.clone());
        request.timeout = COMPRESSION_TIMEOUT;
        request.max_output_bytes = COMPRESSION_OUTPUT_LIMIT;
        request.args = compression_arguments(&job, group);

        on_update(CompressionUpdate {
            phase: CompressionPhase::Compressing,
            message: format!("正在写入归档：{processed} / {total} 个来源。"),
            processed_source_count: processed,
            total_source_count: total,
        });
        let output = run_process(&request, Some(cancellation)).map_err(|error| match error {
            ProcessRunnerError::Cancelled => CompressionError::Cancelled,
            other => CompressionError::Process(other),
        })?;
        if !output.success {
            return Err(CompressionError::SevenZip(concise_process_error(
                &output.stderr,
                &output.stdout,
            )));
        }
        processed = processed.saturating_add(group.source_names.len() as u64);
        on_update(CompressionUpdate {
            phase: CompressionPhase::Compressing,
            message: format!("已写入 {processed} / {total} 个来源。"),
            processed_source_count: processed,
            total_source_count: total,
        });
    }

    if cancellation.is_cancelled() {
        return Err(CompressionError::Cancelled);
    }
    if !job.temporary_path.is_file() {
        return Err(CompressionError::SevenZip(
            "7-Zip 未生成预期的临时归档。".into(),
        ));
    }
    let output_path = publish_archive(partial, &job.output_path)?;
    on_update(CompressionUpdate {
        phase: CompressionPhase::Completed,
        message: "压缩完成。".into(),
        processed_source_count: total,
        total_source_count: total,
    });
    Ok(CompressionResult {
        output_path,
        source_count: total,
    })
}

pub fn sanitize_archive_base_name(value: &str) -> Result<String, CompressionError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(CompressionError::InvalidRequest(
            "请输入归档基础名称。".into(),
        ));
    }
    let without_extension = ["7z", "zip"]
        .iter()
        .find_map(|extension| {
            trimmed
                .strip_suffix(&format!(".{extension}"))
                .or_else(|| trimmed.strip_suffix(&format!(".{}", extension.to_uppercase())))
        })
        .unwrap_or(trimmed)
        .trim();
    let sanitized = without_extension
        .chars()
        .map(|character| {
            if character.is_control() || r#"<>:"/\|?*"#.contains(character) {
                '_'
            } else {
                character
            }
        })
        .collect::<String>()
        .trim_matches([' ', '.'])
        .to_owned();
    if sanitized.is_empty() {
        return Err(CompressionError::InvalidRequest(
            "归档名称不能只包含空格、点或无效字符。".into(),
        ));
    }
    let stem = sanitized.split('.').next().unwrap_or_default();
    if is_windows_reserved_name(stem) {
        return Err(CompressionError::InvalidRequest(
            "归档名称不能使用 Windows 保留名称。".into(),
        ));
    }
    Ok(sanitized)
}

pub fn resolve_available_archive_path(preferred: &Path) -> PathBuf {
    if preferred.symlink_metadata().is_err() {
        return preferred.to_path_buf();
    }
    let parent = preferred.parent().unwrap_or_else(|| Path::new(""));
    let stem = preferred
        .file_stem()
        .and_then(OsStr::to_str)
        .unwrap_or("archive");
    let extension = preferred.extension().and_then(OsStr::to_str);
    for index in 1_u32.. {
        let file_name = match extension {
            Some(extension) => format!("{stem} ({index}).{extension}"),
            None => format!("{stem} ({index})"),
        };
        let candidate = parent.join(file_name);
        if candidate.symlink_metadata().is_err() {
            return candidate;
        }
    }
    unreachable!("u32 archive suffix space exhausted")
}

fn canonicalize_sources(sources: &[PathBuf]) -> Result<Vec<PathBuf>, CompressionError> {
    let mut canonical = Vec::with_capacity(sources.len());
    let mut seen = HashSet::new();
    for source in sources {
        let resolved = fs::canonicalize(source).map_err(|error| CompressionError::SourceIo {
            path: source.display().to_string(),
            source: error,
        })?;
        if seen.insert(path_identity(&resolved)) {
            canonical.push(resolved);
        }
    }
    Ok(canonical)
}

fn remove_nested_sources(sources: Vec<PathBuf>) -> Vec<PathBuf> {
    let directories: HashSet<_> = sources
        .iter()
        .filter(|source| source.is_dir())
        .map(|source| path_identity(source))
        .collect();
    sources
        .into_iter()
        .filter(|candidate| {
            !candidate
                .ancestors()
                .skip(1)
                .any(|parent| directories.contains(&path_identity(parent)))
        })
        .collect()
}

fn validate_unique_root_names(sources: &[PathBuf]) -> Result<(), CompressionError> {
    let mut roots = HashSet::new();
    for source in sources {
        let name = source.file_name().ok_or_else(|| {
            CompressionError::InvalidRequest(format!(
                "无法把“{}”作为归档根项目。",
                source.display()
            ))
        })?;
        let identity = name.to_string_lossy().to_lowercase();
        if !roots.insert(identity) {
            return Err(CompressionError::InvalidRequest(format!(
                "不同目录中存在同名根项目“{}”，请调整来源后重试。",
                name.to_string_lossy()
            )));
        }
    }
    Ok(())
}

fn group_sources_by_parent(
    sources: &[PathBuf],
) -> Result<Vec<CompressionSourceGroup>, CompressionError> {
    let mut groups: Vec<CompressionSourceGroup> = Vec::new();
    for source in sources {
        let parent = source.parent().ok_or_else(|| {
            CompressionError::InvalidRequest(format!(
                "无法确定压缩源“{}”的上级目录。",
                source.display()
            ))
        })?;
        let name = source.file_name().ok_or_else(|| {
            CompressionError::InvalidRequest(format!(
                "无法确定压缩源“{}”的名称。",
                source.display()
            ))
        })?;
        if let Some(group) = groups
            .iter_mut()
            .find(|group| group.current_directory == parent)
        {
            group.source_names.push(name.to_os_string());
        } else {
            groups.push(CompressionSourceGroup {
                current_directory: parent.to_path_buf(),
                source_names: vec![name.to_os_string()],
            });
        }
    }
    Ok(groups)
}

fn compression_arguments(
    job: &PreparedCompressionJob,
    group: &CompressionSourceGroup,
) -> Vec<OsString> {
    let mut args = vec![
        OsString::from("a"),
        job.temporary_path.as_os_str().to_os_string(),
        OsString::from(job.format.seven_zip_type()),
        OsString::from(format!("-mx={}", job.level)),
        OsString::from("-y"),
        OsString::from("-bb0"),
    ];
    if let Some(password) = job.password.as_deref() {
        args.push(OsString::from(format!("-p{password}")));
        match job.format {
            CompressionFormat::SevenZip if job.encrypt_file_names => {
                args.push(OsString::from("-mhe=on"));
            }
            CompressionFormat::Zip => {
                args.push(OsString::from("-mem=AES256"));
            }
            CompressionFormat::SevenZip => {}
        }
    }
    // Stop 7-Zip switch/list-file parsing before user-controlled basenames.
    // Names beginning with '-' or '@' must remain literal source entries.
    args.push(OsString::from("--"));
    args.extend(group.source_names.iter().cloned());
    args
}

fn temporary_archive_path(output_path: &Path, work_id: &str) -> PathBuf {
    let parent = output_path.parent().unwrap_or_else(|| Path::new(""));
    let file_name = output_path
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or("archive");
    let safe_work_id = work_id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '-')
        .collect::<String>();
    parent.join(format!(".{file_name}.arc-recall-{safe_work_id}.part"))
}

fn concise_process_error(stderr: &str, stdout: &str) -> String {
    let message = if stderr.trim().is_empty() {
        stdout.trim()
    } else {
        stderr.trim()
    };
    if message.is_empty() {
        "外部进程未提供错误信息。".into()
    } else {
        message.chars().take(500).collect()
    }
}

fn path_identity(path: &Path) -> String {
    let value = path.to_string_lossy();
    if cfg!(windows) {
        value.to_lowercase()
    } else {
        value.into_owned()
    }
}

fn is_windows_reserved_name(value: &str) -> bool {
    let uppercase = value.to_ascii_uppercase();
    matches!(
        uppercase.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

fn publish_archive(
    mut partial: tempfile::TempPath,
    preferred: &Path,
) -> Result<PathBuf, CompressionError> {
    let mut candidate = preferred.to_path_buf();
    loop {
        match partial.persist_noclobber(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) => {
                // The OS publication operation, rather than an earlier existence check,
                // guarantees that a concurrently created archive is never replaced.
                if error.error.kind() != std::io::ErrorKind::AlreadyExists {
                    return Err(CompressionError::OutputIo(error.error));
                }
                partial = error.path;
                candidate = resolve_available_archive_path(preferred);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_name_and_strips_known_extension() {
        assert_eq!(
            sanitize_archive_base_name("  项目:备份.7z  ").unwrap(),
            "项目_备份"
        );
        assert_eq!(
            sanitize_archive_base_name("Release.ZIP").unwrap(),
            "Release"
        );
    }

    #[test]
    fn rejects_empty_and_reserved_names() {
        assert!(sanitize_archive_base_name("  ...  ").is_err());
        assert!(sanitize_archive_base_name("CON.zip").is_err());
    }

    #[test]
    fn archive_collision_starts_at_one() {
        let directory = tempfile::tempdir().unwrap();
        let preferred = directory.path().join("backup.7z");
        fs::write(&preferred, b"first").unwrap();
        fs::write(directory.path().join("backup (1).7z"), b"second").unwrap();

        assert_eq!(
            resolve_available_archive_path(&preferred),
            directory.path().join("backup (2).7z")
        );
    }

    #[test]
    fn publication_preserves_late_collisions_and_cleans_up_on_failure() {
        let directory = tempfile::tempdir().unwrap();
        let preferred = directory.path().join("backup.7z");
        assert_eq!(resolve_available_archive_path(&preferred), preferred);
        fs::write(&preferred, b"other task").unwrap();
        fs::create_dir(directory.path().join("backup (1).7z")).unwrap();
        let temporary = directory.path().join("partial");
        fs::write(&temporary, b"new archive").unwrap();
        let published = publish_archive(
            tempfile::TempPath::try_from_path(&temporary).unwrap(),
            &preferred,
        )
        .unwrap();
        assert_eq!(published, directory.path().join("backup (2).7z"));
        assert_eq!(fs::read(&preferred).unwrap(), b"other task");
        assert_eq!(fs::read(published).unwrap(), b"new archive");
        assert!(!temporary.exists());

        fs::write(&temporary, b"failed archive").unwrap();
        assert!(
            publish_archive(
                tempfile::TempPath::try_from_path(&temporary).unwrap(),
                &directory.path().join("missing/archive.7z")
            )
            .is_err()
        );
        assert!(!temporary.exists());
    }

    #[test]
    fn nested_sources_are_removed_and_grouped_relatively() {
        let directory = tempfile::tempdir().unwrap();
        let folder = directory.path().join("folder");
        fs::create_dir_all(folder.join("nested")).unwrap();
        fs::write(folder.join("nested").join("file.txt"), b"content").unwrap();
        let sibling = directory.path().join("sibling.txt");
        fs::write(&sibling, b"content").unwrap();

        let prepared = prepare_compression(CompressionJob {
            sources: vec![folder.join("nested").join("file.txt"), folder, sibling],
            output_directory: Some(directory.path().join("out")),
            base_name: "bundle".into(),
            format: CompressionFormat::SevenZip,
            level: 5,
            password: None,
            encrypt_file_names: false,
            work_id: "test".into(),
        })
        .unwrap();

        assert_eq!(prepared.source_count(), 2);
        assert_eq!(prepared.source_groups.len(), 1);
        assert_eq!(
            prepared.source_groups[0].source_names,
            [OsString::from("folder"), OsString::from("sibling.txt")]
        );
    }

    #[test]
    fn source_deduplication_preserves_order_and_sibling_prefixes() {
        let directory = tempfile::tempdir().unwrap();
        let parent = directory.path().join("folder");
        let child = parent.join("nested").join("file.txt");
        let sibling = directory.path().join("folder-backup");
        fs::create_dir_all(child.parent().unwrap()).unwrap();
        fs::create_dir_all(&sibling).unwrap();
        fs::write(&child, b"nested").unwrap();
        let mut sources = vec![child, sibling.clone(), parent.clone()];
        let mut expected = vec![sibling, parent];
        for index in 0..256 {
            let path = directory.path().join(format!("file-{index}.txt"));
            fs::write(&path, b"payload").unwrap();
            sources.push(path.clone());
            expected.push(path);
        }

        assert_eq!(remove_nested_sources(sources), expected);
    }

    #[test]
    fn rejects_duplicate_root_names_from_different_directories() {
        let directory = tempfile::tempdir().unwrap();
        let left = directory.path().join("left");
        let right = directory.path().join("right");
        fs::create_dir_all(&left).unwrap();
        fs::create_dir_all(&right).unwrap();
        fs::write(left.join("same.txt"), b"left").unwrap();
        fs::write(right.join("same.txt"), b"right").unwrap();

        let error = prepare_compression(CompressionJob {
            sources: vec![left.join("same.txt"), right.join("same.txt")],
            output_directory: None,
            base_name: "bundle".into(),
            format: CompressionFormat::Zip,
            level: 5,
            password: None,
            encrypt_file_names: false,
            work_id: "test".into(),
        })
        .err()
        .unwrap();

        assert!(error.to_string().contains("同名根项目"));
    }

    #[test]
    fn builds_encrypted_arguments_without_exposing_them_in_status() {
        let group = CompressionSourceGroup {
            current_directory: PathBuf::from("C:\\data"),
            source_names: vec![OsString::from("source")],
        };
        let job = PreparedCompressionJob {
            source_groups: Vec::new(),
            output_path: PathBuf::from("C:\\out\\archive.7z"),
            temporary_path: PathBuf::from("C:\\out\\.archive.part"),
            format: CompressionFormat::SevenZip,
            level: 7,
            password: Some("secret".into()),
            encrypt_file_names: true,
            source_count: 1,
        };

        let args = compression_arguments(&job, &group);
        assert!(args.contains(&OsString::from("-psecret")));
        assert!(args.contains(&OsString::from("-mhe=on")));
        assert_eq!(
            args.iter().position(|arg| arg == "--"),
            Some(args.len() - group.source_names.len() - 1)
        );
        assert!(
            !format!(
                "{:?}",
                CompressionUpdate {
                    phase: CompressionPhase::Compressing,
                    message: "working".into(),
                    processed_source_count: 0,
                    total_source_count: 1,
                }
            )
            .contains("secret")
        );
    }

    #[test]
    fn terminates_switch_parsing_before_untrusted_source_names() {
        let group = CompressionSourceGroup {
            current_directory: PathBuf::from("C:\\data"),
            source_names: vec![OsString::from("@list.txt"), OsString::from("-mhe=off")],
        };
        let job = PreparedCompressionJob {
            source_groups: Vec::new(),
            output_path: PathBuf::from("C:\\out\\archive.7z"),
            temporary_path: PathBuf::from("C:\\out\\.archive.part"),
            format: CompressionFormat::SevenZip,
            level: 5,
            password: None,
            encrypt_file_names: false,
            source_count: 2,
        };

        let args = compression_arguments(&job, &group);
        let delimiter = args.iter().position(|arg| arg == "--").unwrap();

        assert_eq!(
            &args[delimiter + 1..],
            [OsString::from("@list.txt"), OsString::from("-mhe=off")]
        );
    }
}
