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
    Exhausted(usize),
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
    let records = if format == ArchiveFormat::Zip && archive_paths.len() > 1 {
        // zip2john's central-directory reader only supports single-file ZIPs.
        // A hash obtained from one part is not evidence about the whole set.
        fallback_reasons.push("zip2john 不支持 ZIP 分卷，改用 7-Zip CPU 对完整分卷组验密".into());
        None
    } else if converter_is_available(tools, format) {
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
    let mut hashcat_covered_bytes: Option<usize> = None;
    let mut hashcat_attempted = false;
    if let Some(records) = records.as_ref() {
        if tools.hashcat.is_file() {
            let hashcat_probe = probe_hashcat_devices(&tools.hashcat, Some(cancellation))?;
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
                        match run_hashcat(
                            job,
                            tools,
                            &hash_file,
                            mode,
                            device,
                            cancellation,
                            report,
                        ) {
                            Ok(attempt) => {
                                if let CrackAttempt::Exhausted(limit) = &attempt {
                                    device_completed = true;
                                    hashcat_covered_bytes =
                                        Some(hashcat_covered_bytes.unwrap_or(0).max(*limit));
                                }
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

    if let Some(limit) = hashcat_covered_bytes {
        return finish_external_dictionary(
            input,
            tools,
            cancellation,
            report,
            &verified_candidates,
            limit,
            "Hashcat",
        );
    }

    let mut john_covered_bytes = None;
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
                    if let CrackAttempt::Exhausted(limit) = &attempt {
                        john_covered_bytes = Some(*limit);
                    }
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

    if let Some(limit) = john_covered_bytes {
        return finish_external_dictionary(
            input,
            tools,
            cancellation,
            report,
            &verified_candidates,
            limit,
            "John CPU",
        );
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
    if let Some(result) = run_internal_dictionary(
        input,
        tools,
        cancellation,
        report,
        &verified_candidates,
        None,
    )? {
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
    let hashcat_probe =
        probe_hashcat_devices(&tools.hashcat, None).unwrap_or_else(|error| HashcatDeviceProbe {
            availability: HashcatDeviceAvailability::default(),
            failure: Some(error.to_string()),
        });
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

fn probe_hashcat_devices(
    hashcat: &Path,
    cancellation: Option<&CancellationToken>,
) -> Result<HashcatDeviceProbe, RecoveryError> {
    if let Some(cancellation) = cancellation {
        ensure_not_cancelled(cancellation)?;
    }
    if !hashcat.is_file() {
        return Ok(HashcatDeviceProbe {
            availability: HashcatDeviceAvailability::default(),
            failure: Some("Hashcat 尚未安装。".into()),
        });
    }
    let mut request = ProcessRequest::new(hashcat);
    request.args = vec![OsString::from("-I")];
    request.current_dir = hashcat.parent().map(Path::to_path_buf);
    request.timeout = Duration::from_secs(15);
    request.max_output_bytes = 512 * 1024;
    run_hashcat_probe(&request, cancellation)
}

fn run_hashcat_probe(
    request: &ProcessRequest,
    cancellation: Option<&CancellationToken>,
) -> Result<HashcatDeviceProbe, RecoveryError> {
    match run_process(request, cancellation) {
        Ok(output) => {
            let combined = format!("{}\n{}", output.stdout, output.stderr);
            let (gpu, cpu) = parse_hashcat_device_types(&combined);
            Ok(HashcatDeviceProbe {
                availability: HashcatDeviceAvailability { gpu, cpu },
                failure: None,
            })
        }
        Err(super::super::runner::ProcessRunnerError::Cancelled) => Err(RecoveryError::Cancelled),
        Err(error) => Ok(HashcatDeviceProbe {
            availability: HashcatDeviceAvailability::default(),
            failure: Some(format!("Hashcat 计算设备探测失败：{error}")),
        }),
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

pub(super) fn finish_external_dictionary(
    input: &RecoveryInput<'_>,
    tools: &RecoveryToolPaths,
    cancellation: &CancellationToken,
    report: &mut impl FnMut(RecoveryUpdate),
    already_verified: &HashSet<String>,
    covered_password_bytes: usize,
    engine: &str,
) -> Result<RecoveryResult, RecoveryError> {
    report(RecoveryUpdate::stage(
        RecoveryPhase::Internal,
        Some("7-Zip CPU"),
        format!(
            "{engine} 已完成支持长度内的候选，正在补验超过 {covered_password_bytes} 字节的候选。"
        ),
    ));
    if let Some(result) = run_internal_dictionary(
        input,
        tools,
        cancellation,
        report,
        already_verified,
        Some(covered_password_bytes),
    )? {
        return Ok(result);
    }
    Ok(exhausted_result(
        input.job,
        "外部恢复引擎与长候选补验已完成，当前字典未命中密码。",
    ))
}

fn run_internal_dictionary(
    input: &RecoveryInput<'_>,
    tools: &RecoveryToolPaths,
    cancellation: &CancellationToken,
    report: &mut impl FnMut(RecoveryUpdate),
    already_verified: &HashSet<String>,
    covered_password_bytes: Option<usize>,
) -> Result<Option<RecoveryResult>, RecoveryError> {
    let job = input.job;
    let file = fs::File::open(&job.dictionary_path)?;
    let mut reader = BufReader::with_capacity(64 * 1024, file);
    let mut line = String::new();
    let mut attempted = 0u64;
    let mut reported_oversized_candidate = false;
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
                    "7-Zip CPU 正在检查字典：{} / {}。",
                    attempted, job.dictionary_count
                ),
                attempted,
                job.dictionary_count,
            ));
            last_reported = attempted;
            last_report_at = Instant::now();
        }

        if already_verified.contains(&line)
            || covered_password_bytes.is_some_and(|limit| line.len() <= limit)
        {
            continue;
        }
        let verified =
            match super::timed_operation(super::RecoveryOperation::Verification, report, |_| {
                verify_password(&job.archive_path, &line, tools, cancellation)
            }) {
                Ok(verified) => verified,
                // Use the actual Windows spawn limit, including argument quoting and paths.
                // Do not truncate the candidate or hide unrelated process failures.
                Err(RecoveryError::ProcessStart(error))
                    if cfg!(windows) && error.raw_os_error() == Some(206) =>
                {
                    if !reported_oversized_candidate {
                        report(RecoveryUpdate::stage(
                            RecoveryPhase::Internal,
                            Some("7-Zip CPU"),
                            "已跳过超出 Windows 命令行长度限制的候选密码，继续尝试后续候选。",
                        ));
                        reported_oversized_candidate = true;
                    }
                    continue;
                }
                Err(error) => return Err(error),
            };
        if verified {
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
                "7-Zip CPU 已完成字典检查：{} / {}。",
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

#[allow(clippy::too_many_arguments)]
fn run_hashcat(
    job: &RecoveryJob,
    tools: &RecoveryToolPaths,
    hash_file: &Path,
    mode: u32,
    device: HashcatComputeDevice,
    cancellation: &CancellationToken,
    report: &mut impl FnMut(RecoveryUpdate),
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

    let output = super::super::runner::run_process_observed(
        &request,
        Some(cancellation),
        |line| {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            if let Some(progress) = parse_hashcat_progress(line, now) {
                let mut update = RecoveryUpdate::stage(
                    RecoveryPhase::Hashcat,
                    Some(device.engine_label()),
                    "Hashcat 正在尝试候选密码。",
                );
                update.hashcat_progress = Some(progress);
                report(update);
            }
        },
        || Ok(()),
    )
    .map_err(|error| match error {
        super::super::runner::ProcessRunnerError::Cancelled => RecoveryError::Cancelled,
        other => RecoveryError::Process(other.to_string()),
    })?;
    if output_file.is_file()
        && let Some(password) = read_first_password(&output_file)?
    {
        return Ok(CrackAttempt::Found(password));
    }
    Ok(match output.exit_code {
        Some(1) => hashcat_password_limit(&output.stdout, &output.stderr)
            .map(CrackAttempt::Exhausted)
            .unwrap_or(CrackAttempt::Failed),
        _ => CrackAttempt::Failed,
    })
}

fn hashcat_password_limit(stdout: &str, stderr: &str) -> Option<usize> {
    // Hashcat 7.1.2 emits this before processing the dictionary, including in
    // --status-json mode. The runner retains the beginning of capped output.
    // Its wordlist reader also silently skips entries over PW_MAX (256 bytes),
    // before they can contribute to the status JSON's rejected count.
    stdout
        .lines()
        .chain(stderr.lines())
        .filter_map(|line| {
            line.trim()
                .strip_prefix("Maximum password length supported by kernel:")?
                .trim()
                .parse::<usize>()
                .ok()
        })
        .min()
        .map(|limit| limit.min(256))
}

fn john_password_limit(records: &[HashRecord]) -> usize {
    // Bundled John 1.9.0-jumbo-1 plaintext limits. For UTF-16 formats use the
    // SIMD character limit as a conservative byte limit: no UTF-8 candidate
    // below it can overflow the character buffer, regardless of build flags.
    records
        .iter()
        .map(|record| {
            if record.hash.starts_with("$7z$") {
                28
            } else if record.hash.starts_with("$RAR3$") {
                26
            } else if record.hash.starts_with("$rar5$") {
                32
            } else if record.hash.starts_with("$pkzip2$") {
                31
            } else if record.hash.starts_with("$zip2$") {
                125
            } else {
                0
            }
        })
        .min()
        .unwrap_or(0)
}

// Read only numeric telemetry. Never forward target hashes, candidate text,
// paths, or raw tool output into task events or application logs.
fn parse_hashcat_progress(line: &str, now: u64) -> Option<super::HashcatProgress> {
    let data: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    let progress = data.get("progress")?.as_array()?;
    let total = progress.get(1)?.as_u64()?;
    if total == 0 {
        return None;
    }
    let completed = progress.first()?.as_u64()?.min(total);
    let devices = data.get("devices")?.as_array()?;
    let speed = devices
        .iter()
        .filter_map(|device| device.get("speed")?.as_u64())
        .fold(0u64, u64::saturating_add);
    let temperature = devices
        .iter()
        .filter_map(|device| device.get("temp")?.as_u64())
        .filter(|&value| value <= 150)
        .max();
    Some(super::HashcatProgress {
        completed,
        total,
        hashes_per_second: speed,
        remaining_seconds: data
            .get("estimated_stop")
            .and_then(serde_json::Value::as_u64)
            .filter(|&end| end >= now && speed > 0)
            .map(|end| end - now),
        temperature_celsius: temperature,
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
        CrackAttempt::Exhausted(john_password_limit(records))
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
    if !super::timed_operation(super::RecoveryOperation::Verification, report, |_| {
        verify_password(&job.archive_path, &password, tools, cancellation)
    })? {
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

    #[test]
    fn cancelled_device_probe_is_not_reported_as_unavailable_hardware() {
        let cancellation = CancellationToken::default();
        cancellation.cancel();
        assert!(matches!(
            probe_hashcat_devices(Path::new("missing-hashcat"), Some(&cancellation)),
            Err(RecoveryError::Cancelled)
        ));
    }

    #[cfg(windows)]
    #[test]
    fn device_probe_cancels_a_running_native_process() {
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("started");
        let mut request = ProcessRequest::new("powershell.exe");
        request.current_dir = Some(directory.path().to_path_buf());
        request.args = ["-NoProfile", "-NonInteractive", "-Command",
            "[IO.File]::WriteAllText((Join-Path (Get-Location) 'started'), 'ready'); Start-Sleep -Seconds 30"]
            .map(OsString::from).to_vec();
        request.timeout = Duration::from_secs(15);
        let cancellation = CancellationToken::default();
        let token = cancellation.clone();
        let worker = std::thread::spawn(move || {
            let started = Instant::now();
            while !marker.exists() && started.elapsed() < Duration::from_secs(10) {
                std::thread::sleep(Duration::from_millis(10));
            }
            let child_started = marker.exists();
            let cancelled_at = Instant::now();
            token.cancel();
            (child_started, cancelled_at)
        });
        let result = run_hashcat_probe(&request, Some(&cancellation));
        let (child_started, cancelled_at) = worker.join().unwrap();
        assert!(child_started, "native probe did not start");
        assert!(matches!(result, Err(RecoveryError::Cancelled)));
        assert!(cancelled_at.elapsed() < Duration::from_secs(3));
    }
    use crate::tools::probe_john_perl;

    #[test]
    fn completed_hashcat_uses_the_reported_kernel_limit_and_wordlist_cap() {
        assert_eq!(
            hashcat_password_limit(
                "Maximum password length supported by kernel: 128\r\n{\"progress\":[1,1]}",
                "",
            ),
            Some(128)
        );
        assert_eq!(
            hashcat_password_limit("", "Maximum password length supported by kernel: 512"),
            Some(256)
        );
        assert_eq!(hashcat_password_limit("{\"progress\":[1,1]}", ""), None);
        assert_eq!(
            hashcat_password_limit("Maximum password length supported by kernel: unknown", ""),
            None
        );
    }

    #[test]
    fn completed_john_uses_the_conservative_limit_for_mixed_hashes() {
        let mut records: Vec<_> = ["$zip2$", "$pkzip2$"]
            .into_iter()
            .map(|hash| HashRecord {
                john_line: String::new(),
                hash: hash.into(),
            })
            .collect();
        assert_eq!(john_password_limit(&records), 31);
        records.push(HashRecord {
            john_line: String::new(),
            hash: "unknown".into(),
        });
        assert_eq!(john_password_limit(&records), 0);
        assert_eq!(john_password_limit(&[]), 0);
    }

    #[test]
    fn completed_external_engine_does_not_retry_covered_candidates() {
        let directory = tempfile::tempdir().unwrap();
        let job = RecoveryJob {
            archive_path: directory.path().join("unused-archive"),
            output_directory: directory.path().join("unused-output"),
            dictionary_path: directory.path().join("dictionary"),
            dictionary_count: 2,
            known_password: None,
            work_directory: directory.path().join("unused-work"),
        };
        fs::write(
            &job.dictionary_path,
            format!("{}\r\n{}", "a".repeat(256), "中".repeat(85)),
        )
        .unwrap();
        let tools = RecoveryToolPaths {
            seven_zip: directory.path().join("missing-7z"),
            hashcat: directory.path().join("missing-hashcat"),
            john_tools_directory: directory.path().join("missing-john"),
            perl: directory.path().join("missing-perl"),
        };
        let input = RecoveryInput {
            job: &job,
            archive_bytes: 0,
            disk_budget: &super::super::TaskDiskBudget::default(),
            cached_listing: None,
        };
        let result = finish_external_dictionary(
            &input,
            &tools,
            &CancellationToken::default(),
            &mut |_| {},
            &HashSet::new(),
            256,
            "Hashcat",
        )
        .expect("covered candidates must not launch missing 7-Zip");
        assert!(!result.success);

        let cancellation = CancellationToken::default();
        cancellation.cancel();
        assert!(matches!(
            finish_external_dictionary(
                &input,
                &tools,
                &cancellation,
                &mut |_| {},
                &HashSet::new(),
                256,
                "Hashcat",
            ),
            Err(RecoveryError::Cancelled)
        ));
    }

    #[test]
    fn hashcat_status_only_projects_numeric_telemetry() {
        let status = parse_hashcat_progress(r#"{"progress":[20,100],"devices":[{"speed":123,"temp":61},{"speed":7,"temp":-1}],"estimated_stop":110,"target":"sensitive-hash","guess":{"candidate":"secret"}}"#, 100).unwrap();
        assert_eq!(status.completed, 20);
        assert_eq!(status.total, 100);
        assert_eq!(status.hashes_per_second, 130);
        assert_eq!(status.temperature_celsius, Some(61));
        assert_eq!(status.remaining_seconds, Some(10));
        let serialized = serde_json::to_string(&status).unwrap();
        assert!(!serialized.contains("secret") && !serialized.contains("sensitive-hash"));
        assert!(parse_hashcat_progress("starting Hashcat", 100).is_none());
        assert!(parse_hashcat_progress(r#"{"progress":[0,0],"devices":[]}"#, 100).is_none());
        let unknown = parse_hashcat_progress(
            r#"{"progress":[120,100],"devices":[],"estimated_stop":0}"#,
            100,
        )
        .unwrap();
        assert_eq!(unknown.completed, 100);
        assert_eq!(unknown.remaining_seconds, None);
    }

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
