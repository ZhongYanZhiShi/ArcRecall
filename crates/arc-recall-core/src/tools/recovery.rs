use std::collections::HashSet;
use std::ffi::OsString;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::runner::{
    CancellationToken, ProcessOutput, ProcessRequest, ProcessRunnerError, run_process,
    strawberry_perl_path_entries,
};

const SEVEN_ZIP_SIGNATURE: &[u8] = b"\x37\x7a\xbc\xaf\x27\x1c";
const RAR3_SIGNATURE: &[u8] = b"Rar!\x1a\x07\x00";
const RAR5_SIGNATURE: &[u8] = b"Rar!\x1a\x07\x01\x00";
const ZIP_SIGNATURES: [&[u8]; 3] = [b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08"];
const SIGNATURE_SCAN_LIMIT: u64 = 4 * 1024 * 1024;

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
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RecoveryPhase {
    Preparing,
    Verifying,
    Converting,
    Hashcat,
    John,
    Extracting,
    Completed,
    Cancelled,
    Failed,
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryResult {
    pub success: bool,
    pub cancelled: bool,
    pub password: Option<String>,
    pub engine: Option<String>,
    pub output_directory: PathBuf,
    pub message: String,
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

pub fn analyze_archive(path: impl AsRef<Path>) -> Result<ArchiveAnalysis, RecoveryError> {
    let path = path.as_ref();
    if !path.is_file() {
        return Err(RecoveryError::NotFound(path.display().to_string()));
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
        archive_path: absolute.display().to_string(),
        file_name,
        format,
        format_label: format.label().into(),
        file_size: metadata.len(),
        suggested_output_directory: suggested_output_directory.display().to_string(),
    })
}

pub fn detect_archive_format(path: &Path) -> Result<ArchiveFormat, RecoveryError> {
    if !path.is_file() {
        return Err(RecoveryError::NotFound(path.display().to_string()));
    }
    let file = fs::File::open(path)?;
    let mut buffer = Vec::new();
    file.take(SIGNATURE_SCAN_LIMIT).read_to_end(&mut buffer)?;

    let mut matches = Vec::new();
    if let Some(index) = find_signature(&buffer, SEVEN_ZIP_SIGNATURE) {
        matches.push((index, ArchiveFormat::SevenZip));
    }
    if let Some(index) = find_signature(&buffer, RAR5_SIGNATURE) {
        matches.push((index, ArchiveFormat::Rar5));
    }
    if let Some(index) = find_signature(&buffer, RAR3_SIGNATURE) {
        matches.push((index, ArchiveFormat::Rar3));
    }
    for signature in ZIP_SIGNATURES {
        if let Some(index) = find_signature(&buffer, signature) {
            matches.push((index, ArchiveFormat::Zip));
        }
    }
    matches.sort_by_key(|(index, _)| *index);
    matches
        .first()
        .map(|(_, format)| *format)
        .ok_or(RecoveryError::UnsupportedFormat)
}

pub fn recover_and_extract(
    job: &RecoveryJob,
    tools: &RecoveryToolPaths,
    cancellation: &CancellationToken,
    mut report: impl FnMut(RecoveryUpdate),
) -> Result<RecoveryResult, RecoveryError> {
    validate_job_inputs(job, tools)?;
    let analysis = analyze_archive(&job.archive_path)?;
    fs::create_dir_all(&job.work_directory)?;

    report(RecoveryUpdate {
        phase: RecoveryPhase::Verifying,
        engine: Some("7-Zip".into()),
        message: "正在检查归档是否无需密码。".into(),
    });
    if verify_password(&job.archive_path, "", tools, cancellation)? {
        extract_with_password(job, tools, "", cancellation, &mut report)?;
        return Ok(success_result(
            job,
            None,
            "7-Zip",
            "归档无需密码，已直接解压。",
        ));
    }

    if let Some(password) = job
        .known_password
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        report(RecoveryUpdate {
            phase: RecoveryPhase::Verifying,
            engine: Some("7-Zip".into()),
            message: "正在验证手动输入的密码。".into(),
        });
        if verify_password(&job.archive_path, password, tools, cancellation)? {
            extract_with_password(job, tools, password, cancellation, &mut report)?;
            return Ok(success_result(
                job,
                Some(password.to_owned()),
                "手动密码",
                "手动密码验证通过，归档已解压。",
            ));
        }
    }

    if job.dictionary_count == 0 {
        return Ok(exhausted_result(
            job,
            "全局字典没有可供 Hashcat/John 使用的候选密码。",
        ));
    }

    // Dictionary recovery needs the full *2john + Hashcat + John stack.
    validate_recovery_engines(tools, analysis.format)?;

    report(RecoveryUpdate {
        phase: RecoveryPhase::Converting,
        engine: Some(converter_name(analysis.format).into()),
        message: format!(
            "正在使用 {} 提取 {} 验密哈希。",
            converter_name(analysis.format),
            analysis.format_label
        ),
    });
    let records = extract_hashes(job, tools, analysis.format, cancellation)?;
    if records.is_empty() {
        return Err(RecoveryError::Message(format!(
            "{} 未生成可用的归档哈希。",
            converter_name(analysis.format)
        )));
    }

    let mut verified_candidates = HashSet::new();
    for (record_index, record) in records.iter().enumerate() {
        ensure_not_cancelled(cancellation)?;
        let hash_file = job
            .work_directory
            .join(format!("hashcat-{record_index}.hash"));
        fs::write(&hash_file, format!("{}\n", record.hash))?;
        let modes = identify_hashcat_modes(&hash_file, &record.hash, tools, cancellation);

        for mode in modes {
            ensure_not_cancelled(cancellation)?;
            report(RecoveryUpdate {
                phase: RecoveryPhase::Hashcat,
                engine: Some("Hashcat GPU".into()),
                message: format!(
                    "Hashcat GPU 正在尝试模式 {mode}（{} 条候选）。",
                    job.dictionary_count
                ),
            });
            let gpu = run_hashcat(job, tools, &hash_file, mode, "2", cancellation)?;
            if let Some(result) = verify_crack_attempt(
                gpu,
                job,
                tools,
                cancellation,
                &mut report,
                &mut verified_candidates,
                "Hashcat GPU",
            )? {
                return Ok(result);
            }
        }
    }

    // Hashcat CPU is used as a fallback only after the GPU pass. On systems
    // without an OpenCL CPU backend this fails quickly and John remains the
    // guaranteed bundled CPU implementation.
    for (record_index, record) in records.iter().enumerate() {
        ensure_not_cancelled(cancellation)?;
        let hash_file = job
            .work_directory
            .join(format!("hashcat-{record_index}.hash"));
        let modes = identify_hashcat_modes(&hash_file, &record.hash, tools, cancellation);
        for mode in modes {
            report(RecoveryUpdate {
                phase: RecoveryPhase::Hashcat,
                engine: Some("Hashcat CPU".into()),
                message: format!(
                    "Hashcat CPU 正在尝试模式 {mode}（{} 条候选）。",
                    job.dictionary_count
                ),
            });
            let cpu = run_hashcat(job, tools, &hash_file, mode, "1", cancellation)?;
            if let Some(result) = verify_crack_attempt(
                cpu,
                job,
                tools,
                cancellation,
                &mut report,
                &mut verified_candidates,
                "Hashcat CPU",
            )? {
                return Ok(result);
            }
        }
    }

    report(RecoveryUpdate {
        phase: RecoveryPhase::John,
        engine: Some("John CPU".into()),
        message: format!(
            "Hashcat 未找到可用密码，正在用 John CPU 复跑 {} 条候选。",
            job.dictionary_count
        ),
    });
    let john = run_john(job, tools, &records, cancellation)?;
    if let Some(result) = verify_crack_attempt(
        john,
        job,
        tools,
        cancellation,
        &mut report,
        &mut verified_candidates,
        "John CPU",
    )? {
        return Ok(result);
    }

    Ok(exhausted_result(
        job,
        "Hashcat GPU/CPU 与 John CPU 均已完成，当前字典未命中密码。",
    ))
}

fn validate_job_inputs(job: &RecoveryJob, tools: &RecoveryToolPaths) -> Result<(), RecoveryError> {
    if !tools.seven_zip.is_file() {
        return Err(RecoveryError::MissingTool(format!(
            "7-Zip（{}）",
            tools.seven_zip.display()
        )));
    }
    if !job.archive_path.is_file() {
        return Err(RecoveryError::NotFound(
            job.archive_path.display().to_string(),
        ));
    }
    if !job.dictionary_path.is_file() {
        return Err(RecoveryError::NotFound(
            job.dictionary_path.display().to_string(),
        ));
    }
    Ok(())
}

fn validate_recovery_engines(
    tools: &RecoveryToolPaths,
    format: ArchiveFormat,
) -> Result<(), RecoveryError> {
    for (name, path) in [
        ("Hashcat", tools.hashcat.clone()),
        ("John", tools.john_tools_directory.join("john.exe")),
    ] {
        if !path.is_file() {
            return Err(RecoveryError::MissingTool(format!(
                "{name}（{}）",
                path.display()
            )));
        }
    }

    let converter = match format {
        ArchiveFormat::SevenZip => {
            let script = tools.john_tools_directory.join("7z2john.pl");
            if !tools.perl.is_file() {
                return Err(RecoveryError::MissingTool(format!(
                    "Perl（{}）",
                    tools.perl.display()
                )));
            }
            if !script.is_file() {
                return Err(RecoveryError::MissingTool(format!(
                    "7z2john.pl（{}）",
                    script.display()
                )));
            }
            None
        }
        ArchiveFormat::Zip => Some(tools.john_tools_directory.join("zip2john.exe")),
        ArchiveFormat::Rar3 | ArchiveFormat::Rar5 => {
            Some(tools.john_tools_directory.join("rar2john.exe"))
        }
    };
    if let Some(path) = converter
        && !path.is_file()
    {
        return Err(RecoveryError::MissingTool(format!(
            "{}（{}）",
            converter_name(format),
            path.display()
        )));
    }
    Ok(())
}

fn converter_name(format: ArchiveFormat) -> &'static str {
    match format {
        ArchiveFormat::SevenZip => "7z2john",
        ArchiveFormat::Zip => "zip2john",
        ArchiveFormat::Rar3 | ArchiveFormat::Rar5 => "rar2john",
    }
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
        return Err(RecoveryError::MissingTool(program.display().to_string()));
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
    device_type: &str,
    cancellation: &CancellationToken,
) -> Result<CrackAttempt, RecoveryError> {
    let output_file = job
        .work_directory
        .join(format!("hashcat-{mode}-{device_type}.found"));
    let _ = fs::remove_file(&output_file);
    let mut request = ProcessRequest::new(&tools.hashcat);
    request.args = vec![
        OsString::from("-m"),
        OsString::from(mode.to_string()),
        OsString::from("-a"),
        OsString::from("0"),
        OsString::from("-D"),
        OsString::from(device_type),
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
        Some(0 | 1) => CrackAttempt::Exhausted,
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

    report(RecoveryUpdate {
        phase: RecoveryPhase::Verifying,
        engine: Some("7-Zip".into()),
        message: format!("{engine} 已找到候选密码，正在用 7-Zip 复验。"),
    });
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
    Ok(run_checked(&request, cancellation)?.success)
}

fn extract_with_password(
    job: &RecoveryJob,
    tools: &RecoveryToolPaths,
    password: &str,
    cancellation: &CancellationToken,
    report: &mut impl FnMut(RecoveryUpdate),
) -> Result<(), RecoveryError> {
    ensure_not_cancelled(cancellation)?;
    report(RecoveryUpdate {
        phase: RecoveryPhase::Extracting,
        engine: Some("7-Zip".into()),
        message: format!("正在解压到 {}。", job.output_directory.display()),
    });
    fs::create_dir_all(&job.output_directory)?;
    let mut request = ProcessRequest::new(&tools.seven_zip);
    request.args = vec![
        OsString::from("x"),
        OsString::from("-y"),
        OsString::from("-aoa"),
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
    }
}

fn process_failure(tool: &str, output: &ProcessOutput) -> RecoveryError {
    let detail = if output.stderr.trim().is_empty() {
        output.stdout.trim()
    } else {
        output.stderr.trim()
    };
    RecoveryError::Process(format!(
        "{tool} 退出码 {:?}：{}",
        output.exit_code,
        if detail.is_empty() {
            "未返回诊断信息"
        } else {
            detail
        }
    ))
}

fn find_signature(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
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
            fs::write(&job.dictionary_path, b"").unwrap();
            fs::create_dir_all(&job.work_directory).unwrap();

            let result = recover_and_extract(&job, &tools, &cancellation, |_| {}).expect("recover");
            assert!(result.success, "{name}: {}", result.message);
            assert_eq!(result.password.as_deref(), Some(password));
            assert_eq!(
                fs::read_to_string(output_directory.join("payload.txt")).unwrap(),
                "arc-recall-payload"
            );
        }
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
        fs::write(&job.dictionary_path, b"").unwrap();
        fs::create_dir_all(&job.work_directory).unwrap();

        let result = recover_and_extract(&job, &tools, &cancellation, |_| {}).expect("recover");
        assert!(result.success, "{}", result.message);
        assert!(result.password.is_none());
        assert_eq!(
            fs::read_to_string(output_directory.join("plain.txt")).unwrap(),
            "no-password"
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
