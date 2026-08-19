use std::ffi::OsString;
use std::fs;
use std::path::Path;
use std::time::Duration;

use super::super::runner::{CancellationToken, ProcessOutput, ProcessRequest};
use super::{
    ArchiveFormat, RecoveryError, RecoveryJob, RecoveryPhase, RecoveryToolPaths, RecoveryUpdate,
    ensure_not_cancelled, is_password_rejection, path_for_display, process_failure,
    process_failure_detail, run_checked,
};

const MAX_EXTRACTED_ENTRY_COUNT: u64 = 100_000;
const MAX_EXTRACTED_TOTAL_BYTES: u64 = 100 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_EXPANSION_RATIO: u64 = 10_000;
const SEVEN_ZIP_LIST_OUTPUT_LIMIT: usize = 32 * 1024 * 1024;

/// Build the 7-Zip `-p{Password}` switch as a single argv entry.
///
/// 7-Zip 26.x does **not** read the password from stdin when given a bare `-p`
/// (it expects a console prompt via ReadConsole). Piping the secret therefore
/// fails under `CREATE_NO_WINDOW` / redirected stdio. Embedding the password in
/// the switch is the only reliable non-interactive interface on Windows.
pub(super) fn seven_zip_password_arg(password: &str) -> OsString {
    let mut arg = OsString::from("-p");
    arg.push(password);
    arg
}

pub(super) fn validate_archive_container(
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

pub(super) fn seven_zip_archive_types(output: &ProcessOutput) -> Vec<String> {
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

pub(super) fn archive_type_matches(format: ArchiveFormat, detected: &str) -> bool {
    match format {
        ArchiveFormat::SevenZip => detected.eq_ignore_ascii_case("7z"),
        ArchiveFormat::Zip => detected.eq_ignore_ascii_case("zip"),
        ArchiveFormat::Rar3 | ArchiveFormat::Rar5 => detected
            .get(..3)
            .is_some_and(|value| value.eq_ignore_ascii_case("rar")),
    }
}

pub(super) fn verify_password(
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

pub(super) fn extract_with_password(
    job: &RecoveryJob,
    tools: &RecoveryToolPaths,
    password: &str,
    cancellation: &CancellationToken,
    report: &mut impl FnMut(RecoveryUpdate),
) -> Result<(), RecoveryError> {
    ensure_not_cancelled(cancellation)?;
    validate_extraction_budget(&job.archive_path, password, tools, cancellation)?;
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct ArchiveExtractionBudget {
    pub(super) entry_count: u64,
    pub(super) total_bytes: u64,
}

fn validate_extraction_budget(
    archive: &Path,
    password: &str,
    tools: &RecoveryToolPaths,
    cancellation: &CancellationToken,
) -> Result<(), RecoveryError> {
    let mut request = ProcessRequest::new(&tools.seven_zip);
    request.args = vec![
        OsString::from("l"),
        OsString::from("-slt"),
        OsString::from("-y"),
        OsString::from("-bd"),
        seven_zip_password_arg(password),
        archive.as_os_str().to_owned(),
    ];
    request.current_dir = tools.seven_zip.parent().map(Path::to_path_buf);
    request.timeout = Duration::from_secs(5 * 60);
    request.max_output_bytes = SEVEN_ZIP_LIST_OUTPUT_LIMIT;
    let output = run_checked(&request, cancellation)?;
    if !output.success {
        return Err(process_failure("7-Zip 安全预检", &output));
    }
    let budget = parse_seven_zip_extraction_budget(&output)?;
    let archive_bytes = fs::metadata(archive)?.len().max(1);
    let ratio_limit = archive_bytes.saturating_mul(MAX_ARCHIVE_EXPANSION_RATIO);
    let byte_limit = ratio_limit.min(MAX_EXTRACTED_TOTAL_BYTES);

    if budget.entry_count > MAX_EXTRACTED_ENTRY_COUNT {
        return Err(RecoveryError::Message(format!(
            "归档包含 {} 个条目，超过 {} 个安全上限。",
            budget.entry_count, MAX_EXTRACTED_ENTRY_COUNT
        )));
    }
    if budget.total_bytes > byte_limit {
        return Err(RecoveryError::Message(format!(
            "归档声明展开后约 {} MiB，超过 {} MiB 安全上限。",
            budget.total_bytes / (1024 * 1024),
            byte_limit / (1024 * 1024)
        )));
    }
    Ok(())
}

pub(super) fn parse_seven_zip_extraction_budget(
    output: &ProcessOutput,
) -> Result<ArchiveExtractionBudget, RecoveryError> {
    if output.stdout_truncated || output.stderr_truncated {
        return Err(RecoveryError::Message(
            "归档条目清单过大，无法在安全预算内完成预检。".into(),
        ));
    }

    let mut inside_entries = false;
    let mut saw_separator = false;
    let mut entry_count = 0u64;
    let mut total_bytes = 0u64;
    for line in output.stdout.lines() {
        let line = line.trim();
        if line == "----------" {
            inside_entries = true;
            saw_separator = true;
            continue;
        }
        if !inside_entries {
            continue;
        }
        if line.strip_prefix("Path = ").is_some() {
            entry_count = entry_count.saturating_add(1);
        } else if let Some(size) = line.strip_prefix("Size = ") {
            let size = size.trim().parse::<u64>().map_err(|_| {
                RecoveryError::Message("7-Zip 返回了无法解析的归档展开大小。".into())
            })?;
            total_bytes = total_bytes.saturating_add(size);
        }
    }

    if !saw_separator {
        return Err(RecoveryError::Message(
            "7-Zip 未返回可验证的归档条目清单。".into(),
        ));
    }

    Ok(ArchiveExtractionBudget {
        entry_count,
        total_bytes,
    })
}
