use std::collections::HashSet;
use std::ffi::OsString;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use super::super::john::{SevenZipConverter, resolve_seven_zip_converter};
use super::super::runner::{
    CancellationToken, ProcessRequest, run_process, strawberry_perl_path_entries,
};
use super::{
    ArchiveFormat, RecoveryCapabilities, RecoveryComputeDevice, RecoveryComputeMode, RecoveryError,
    RecoveryInput, RecoveryJob, RecoveryMethodCapability, RecoveryPhase, RecoveryResult,
    RecoveryToolPaths, RecoveryUpdate, ensure_not_cancelled, exhausted_result,
    extract_with_password, path_for_display, process_failure, run_checked, success_result,
    verify_password,
};

const HASHCAT_ARCHIVE_MODES: [u32; 13] = [
    11600, 12500, 13000, 13600, 17200, 17210, 17220, 17225, 17230, 17240, 17250, 23700, 23800,
];

#[derive(Debug, Clone)]
pub(super) struct HashRecord {
    pub(super) john_line: String,
    pub(super) hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum CrackAttempt {
    Found(String),
    Exhausted,
    Failed,
}

pub(super) fn recover_with_dictionary(
    input: &RecoveryInput<'_>,
    tools: &RecoveryToolPaths,
    format: ArchiveFormat,
    archive_paths: &[PathBuf],
    cancellation: &CancellationToken,
    compute_mode: RecoveryComputeMode,
    report: &mut impl FnMut(RecoveryUpdate),
) -> Result<RecoveryResult, RecoveryError> {
    let job = input.job;
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
        match extract_hashes(job, tools, format, archive_paths, cancellation) {
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
                        report(
                            RecoveryUpdate::stage(
                                RecoveryPhase::Hashcat,
                                Some(engine),
                                format!(
                                    "{engine} 正在尝试模式 {mode}（{} 条候选）。",
                                    job.dictionary_count
                                ),
                            )
                            .with_compute_device(device.recovery_device()),
                        );
                        hashcat_attempted = true;
                        match run_hashcat(job, tools, &hash_file, mode, device, cancellation) {
                            Ok(attempt) => {
                                let completed = attempt == CrackAttempt::Exhausted;
                                device_completed |= completed;
                                hashcat_completed |= completed;
                                if let Some(result) = verify_crack_attempt(
                                    attempt,
                                    input,
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
                        input,
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
        run_internal_dictionary(input, tools, cancellation, report, &verified_candidates)?
    {
        return Ok(result);
    }
    Ok(exhausted_result(
        job,
        "外部引擎不可用或未能完成，7-Zip CPU 兜底也未在当前字典中找到密码。",
    ))
}

pub(super) fn validate_base_job_inputs(
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

pub(super) fn validate_dictionary_input(job: &RecoveryJob) -> Result<(), RecoveryError> {
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
            resolve_seven_zip_converter(&tools.john_tools_directory, &tools.perl).is_some()
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
pub(super) enum HashcatComputeDevice {
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

    const fn recovery_device(self) -> RecoveryComputeDevice {
        match self {
            Self::Gpu => RecoveryComputeDevice::Gpu,
            Self::Cpu => RecoveryComputeDevice::Cpu,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) struct HashcatDeviceAvailability {
    pub(super) gpu: bool,
    pub(super) cpu: bool,
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

pub(super) fn hashcat_device_plan(
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

pub(super) fn parse_hashcat_device_types(output: &str) -> (bool, bool) {
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
    input: &RecoveryInput<'_>,
    tools: &RecoveryToolPaths,
    cancellation: &CancellationToken,
    report: &mut impl FnMut(RecoveryUpdate),
    already_verified: &HashSet<String>,
) -> Result<Option<RecoveryResult>, RecoveryError> {
    let job = input.job;
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
            extract_with_password(input, tools, &line, cancellation, report)?;
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

pub(super) fn extract_hashes(
    job: &RecoveryJob,
    tools: &RecoveryToolPaths,
    format: ArchiveFormat,
    archive_paths: &[PathBuf],
    cancellation: &CancellationToken,
) -> Result<Vec<HashRecord>, RecoveryError> {
    let request = hash_extraction_request(job, tools, format, archive_paths)?;
    let output = run_checked(&request, cancellation)?;
    if !output.success && output.stdout.trim().is_empty() {
        return Err(process_failure(converter_name(format), &output));
    }
    Ok(parse_hash_records(&output.stdout))
}

fn hash_extraction_request(
    job: &RecoveryJob,
    tools: &RecoveryToolPaths,
    format: ArchiveFormat,
    archive_paths: &[PathBuf],
) -> Result<ProcessRequest, RecoveryError> {
    let john_dir = &tools.john_tools_directory;
    let (program, args, uses_perl) = match format {
        ArchiveFormat::SevenZip => {
            let converter =
                resolve_seven_zip_converter(john_dir, &tools.perl).ok_or_else(|| {
                    RecoveryError::MissingTool("7z2john.exe 或 7z2john.pl + Perl".into())
                })?;
            let archive_args = seven_zip_converter_archive_args(archive_paths);
            match converter {
                SevenZipConverter::Executable(program) => (program, archive_args, false),
                SevenZipConverter::PerlScript { perl, script } => {
                    let mut args = vec![script.into_os_string()];
                    args.extend(archive_args);
                    (perl, args, true)
                }
            }
        }
        ArchiveFormat::Zip => (
            john_dir.join("zip2john.exe"),
            vec![job.archive_path.as_os_str().to_owned()],
            false,
        ),
        ArchiveFormat::Rar3 | ArchiveFormat::Rar5 => (
            john_dir.join("rar2john.exe"),
            vec![job.archive_path.as_os_str().to_owned()],
            false,
        ),
    };
    if !program.is_file() {
        return Err(RecoveryError::MissingTool(path_for_display(&program)));
    }

    let mut request = ProcessRequest::new(program);
    request.args = args;
    request.current_dir = Some(john_dir.clone());
    if uses_perl {
        // Portable Strawberry needs c\bin (liblzma) on PATH for Compress::Raw::Lzma.
        request.path_prepend = strawberry_perl_path_entries(&tools.perl);
    }
    request.timeout = Duration::from_secs(10 * 60);
    request.max_output_bytes = 16 * 1024 * 1024;
    Ok(request)
}

pub(super) fn seven_zip_converter_archive_args(archive_paths: &[PathBuf]) -> Vec<OsString> {
    // Strawberry Perl/File::Glob cannot open Windows verbatim paths
    // (`\\?\E:\...`). Keep every resolved path explicit, but remove that
    // namespace prefix before handing the exact volume sequence to 7z2john.
    archive_paths
        .iter()
        .map(|path| OsString::from(path_for_display(path)))
        .collect()
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

pub(super) fn fallback_hashcat_modes(hash: &str) -> Vec<u32> {
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
    input: &RecoveryInput<'_>,
    tools: &RecoveryToolPaths,
    cancellation: &CancellationToken,
    report: &mut impl FnMut(RecoveryUpdate),
    verified_candidates: &mut HashSet<String>,
    engine: &str,
) -> Result<Option<RecoveryResult>, RecoveryError> {
    let job = input.job;
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
    extract_with_password(input, tools, &password, cancellation, report)?;
    Ok(Some(success_result(
        job,
        Some(password),
        engine,
        &format!("{engine} 找到的密码已通过 7-Zip 复验并完成解压。"),
    )))
}

pub(super) fn parse_hash_records(output: &str) -> Vec<HashRecord> {
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

pub(super) fn decode_password(value: &str) -> Option<String> {
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
    use crate::tools::probe_john_perl;

    #[test]
    fn converter_readiness_matches_the_program_and_exact_volume_arguments() {
        let directory = tempfile::tempdir().unwrap();
        let john_dir = directory.path().join("john");
        fs::create_dir(&john_dir).unwrap();
        let tools = RecoveryToolPaths {
            seven_zip: directory.path().join("unused-7z"),
            hashcat: directory.path().join("unused-hashcat"),
            john_tools_directory: john_dir.clone(),
            perl: directory.path().join("perl.exe"),
        };
        let job = RecoveryJob {
            archive_path: PathBuf::from(r"\\?\E:\data\archive.7z.001"),
            output_directory: directory.path().join("output"),
            dictionary_path: directory.path().join("dictionary"),
            dictionary_count: 0,
            known_password: None,
            work_directory: directory.path().join("work"),
        };
        let volumes = vec![
            job.archive_path.clone(),
            PathBuf::from(r"\\?\E:\data\archive.7z.002"),
        ];
        let archive_args = seven_zip_converter_archive_args(&volumes);
        let ready = || {
            probe_john_perl(john_dir.to_str().unwrap(), tools.perl.to_str().unwrap())
                .seven_zip_converter_ready
        };
        let request = || hash_extraction_request(&job, &tools, ArchiveFormat::SevenZip, &volumes);

        assert!(!ready());
        assert!(request().is_err());
        let script = john_dir.join("7z2john.pl");
        fs::write(&script, b"fixture").unwrap();
        assert!(!ready());
        assert!(request().is_err());

        fs::write(&tools.perl, b"fixture").unwrap();
        assert!(ready());
        let perl_request = request().unwrap();
        assert_eq!(perl_request.program, tools.perl);
        assert_eq!(perl_request.args[0], script.as_os_str());
        assert_eq!(&perl_request.args[1..], archive_args);
        assert!(!perl_request.path_prepend.is_empty());

        let executable = john_dir.join(if cfg!(windows) {
            "7z2john.exe"
        } else {
            "7z2john"
        });
        fs::write(&executable, b"fixture").unwrap();
        assert!(ready());
        let exe_request = request().unwrap();
        assert_eq!(exe_request.program, executable);
        assert_eq!(exe_request.args, archive_args);
        assert!(exe_request.path_prepend.is_empty());

        fs::remove_file(script).unwrap();
        fs::remove_file(&tools.perl).unwrap();
        assert!(ready());
        assert!(converter_is_available(&tools, ArchiveFormat::SevenZip));
        assert_eq!(request().unwrap().program, executable);
    }
}
