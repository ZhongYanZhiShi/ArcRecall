use std::env;
use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, SyncSender};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(windows)]
#[path = "windows_job.rs"]
mod windows_job;

struct ManagedChild {
    child: Child,
    #[cfg(windows)]
    job: windows_job::ProcessJob,
}

impl ManagedChild {
    fn spawn(command: &mut Command) -> io::Result<Self> {
        #[cfg(windows)]
        let job = windows_job::ProcessJob::new()?;
        let child = command.spawn()?;
        let managed = Self {
            child,
            #[cfg(windows)]
            job,
        };
        #[cfg(windows)]
        if let Err(error) = managed.job.attach_and_resume(&managed.child) {
            let mut managed = managed;
            let _ = managed.kill();
            let _ = managed.child.wait();
            return Err(error);
        }
        Ok(managed)
    }

    fn kill(&mut self) -> io::Result<()> {
        let descendants = self.terminate_descendants();
        // Still try the direct child if job termination failed, but preserve the
        // job error: killing only the parent does not guarantee tree cleanup.
        let child = self.child.kill();
        descendants.and(child)
    }

    fn terminate_descendants(&self) -> io::Result<()> {
        #[cfg(windows)]
        self.job.terminate()?;
        Ok(())
    }
}

impl std::ops::Deref for ManagedChild {
    type Target = Child;
    fn deref(&self) -> &Child {
        &self.child
    }
}

impl std::ops::DerefMut for ManagedChild {
    fn deref_mut(&mut self) -> &mut Child {
        &mut self.child
    }
}

impl Drop for ManagedChild {
    fn drop(&mut self) {
        let _ = self.kill();
        let _ = self.child.wait();
    }
}

#[derive(Debug, Clone, Default)]
pub struct CancellationToken {
    cancelled: Arc<AtomicBool>,
}

impl CancellationToken {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

#[derive(Debug, Clone)]
pub struct ProcessRequest {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub current_dir: Option<PathBuf>,
    /// Directories prepended to the child process `PATH` (for tool-local DLLs).
    pub path_prepend: Vec<PathBuf>,
    /// Bytes written to the child process standard input before it is closed.
    ///
    /// Prefer tool-specific non-interactive switches for secrets: 7-Zip does
    /// not consume a bare `-p` password from stdin under redirected I/O.
    pub stdin_bytes: Option<Vec<u8>>,
    pub timeout: Duration,
    pub max_output_bytes: usize,
}

impl ProcessRequest {
    pub fn new(program: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            current_dir: None,
            path_prepend: Vec::new(),
            stdin_bytes: None,
            timeout: Duration::from_secs(30),
            max_output_bytes: 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessOutput {
    pub exit_code: Option<i32>,
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum ProcessRunnerError {
    #[error("无法启动外部进程：{0}")]
    Spawn(#[source] io::Error),
    #[error("等待外部进程失败：{0}")]
    Wait(#[source] io::Error),
    #[error("读取外部进程输出失败：{0}")]
    Output(#[source] io::Error),
    #[error("外部进程已取消")]
    Cancelled,
    #[error("外部进程执行超时（{0} 秒）")]
    TimedOut(u64),
}

struct CapturedOutput {
    bytes: Vec<u8>,
    truncated: bool,
}

/// Run an external tool with bounded captured output, cancellation and timeout.
///
/// Readers continue draining after the capture limit so a noisy child cannot
/// deadlock on a full pipe.
pub fn run_process(
    request: &ProcessRequest,
    cancellation: Option<&CancellationToken>,
) -> Result<ProcessOutput, ProcessRunnerError> {
    run_process_impl(request, cancellation, false, |_| {}, || Ok(()))
}

/// Deliver bounded stdout lines while the child is alive. A slow consumer may
/// miss intermediate lines, but never blocks pipe draining or cancellation.
pub(crate) fn run_process_observed(
    request: &ProcessRequest,
    cancellation: Option<&CancellationToken>,
    on_stdout: impl FnMut(&str),
    check: impl FnMut() -> io::Result<()>,
) -> Result<ProcessOutput, ProcessRunnerError> {
    run_process_impl(request, cancellation, true, on_stdout, check)
}

fn run_process_impl(
    request: &ProcessRequest,
    cancellation: Option<&CancellationToken>,
    observe_stdout: bool,
    mut on_stdout: impl FnMut(&str),
    mut check: impl FnMut() -> io::Result<()>,
) -> Result<ProcessOutput, ProcessRunnerError> {
    if cancellation.is_some_and(CancellationToken::is_cancelled) {
        return Err(ProcessRunnerError::Cancelled);
    }
    let mut command = Command::new(&request.program);
    command
        .args(&request.args)
        .stdin(if request.stdin_bytes.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(current_dir) = &request.current_dir {
        command.current_dir(current_dir);
    }
    if !request.path_prepend.is_empty() {
        command.env("PATH", prepend_path(&request.path_prepend));
    }
    configure_hidden_window(&mut command);

    let mut child = ManagedChild::spawn(&mut command).map_err(ProcessRunnerError::Spawn)?;
    if let Some(input) = &request.stdin_bytes {
        let mut stdin = child
            .stdin
            .take()
            .expect("stdin is piped before spawning the child");
        if let Err(error) = stdin.write_all(input) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(ProcessRunnerError::Output(error));
        }
    }
    let stdout = child
        .stdout
        .take()
        .expect("stdout is piped before spawning the child");
    let stderr = child
        .stderr
        .take()
        .expect("stderr is piped before spawning the child");
    let output_limit = request.max_output_bytes;
    let (sender, receiver) = mpsc::sync_channel(32);
    let stdout_reader = thread::spawn(move || {
        read_capped_observed(stdout, output_limit, observe_stdout.then_some(sender))
    });
    let stderr_reader = thread::spawn(move || read_capped(stderr, output_limit));
    let started = Instant::now();

    let status = loop {
        for line in receiver.try_iter() {
            on_stdout(&line);
        }
        if let Err(error) = check() {
            let _ = child.kill();
            let _ = child.wait();
            join_output(stdout_reader, stderr_reader)?;
            return Err(ProcessRunnerError::Output(error));
        }
        if cancellation.is_some_and(CancellationToken::is_cancelled) {
            child.kill().map_err(ProcessRunnerError::Wait)?;
            let _ = child.wait();
            join_output(stdout_reader, stderr_reader)?;
            return Err(ProcessRunnerError::Cancelled);
        }
        if started.elapsed() >= request.timeout {
            child.kill().map_err(ProcessRunnerError::Wait)?;
            let _ = child.wait();
            join_output(stdout_reader, stderr_reader)?;
            return Err(ProcessRunnerError::TimedOut(request.timeout.as_secs()));
        }
        match child.try_wait().map_err(ProcessRunnerError::Wait)? {
            Some(status) => break status,
            None => thread::sleep(Duration::from_millis(25)),
        }
    };

    child
        .terminate_descendants()
        .map_err(ProcessRunnerError::Wait)?;
    let (stdout, stderr) = join_output(stdout_reader, stderr_reader)?;
    for line in receiver.try_iter() {
        on_stdout(&line);
    }
    Ok(ProcessOutput {
        exit_code: status.code(),
        success: status.success(),
        stdout: String::from_utf8_lossy(&stdout.bytes).into_owned(),
        stderr: String::from_utf8_lossy(&stderr.bytes).into_owned(),
        stdout_truncated: stdout.truncated,
        stderr_truncated: stderr.truncated,
    })
}

fn read_capped(reader: impl Read, limit: usize) -> io::Result<CapturedOutput> {
    read_capped_observed(reader, limit, None)
}

fn read_capped_observed(
    mut reader: impl Read,
    limit: usize,
    sender: Option<SyncSender<String>>,
) -> io::Result<CapturedOutput> {
    let mut captured = Vec::with_capacity(limit.min(64 * 1024));
    let mut buffer = [0u8; 16 * 1024];
    let mut truncated = false;
    let mut line = Vec::new();
    let mut oversized = false;
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        let remaining = limit.saturating_sub(captured.len());
        let keep = remaining.min(read);
        captured.extend_from_slice(&buffer[..keep]);
        truncated |= keep < read;
        if let Some(sender) = &sender {
            for &byte in &buffer[..read] {
                if byte == b'\n' {
                    if !oversized {
                        let _ = sender.try_send(String::from_utf8_lossy(&line).into_owned());
                    }
                    line.clear();
                    oversized = false;
                } else if line.len() < 64 * 1024 {
                    line.push(byte);
                } else {
                    oversized = true;
                }
            }
        }
    }
    if let Some(sender) = sender
        && !line.is_empty()
        && !oversized
    {
        let _ = sender.try_send(String::from_utf8_lossy(&line).into_owned());
    }
    Ok(CapturedOutput {
        bytes: captured,
        truncated,
    })
}

fn join_output(
    stdout_reader: thread::JoinHandle<io::Result<CapturedOutput>>,
    stderr_reader: thread::JoinHandle<io::Result<CapturedOutput>>,
) -> Result<(CapturedOutput, CapturedOutput), ProcessRunnerError> {
    let stdout = stdout_reader
        .join()
        .map_err(|_| ProcessRunnerError::Output(io::Error::other("stdout reader panicked")))?
        .map_err(ProcessRunnerError::Output)?;
    let stderr = stderr_reader
        .join()
        .map_err(|_| ProcessRunnerError::Output(io::Error::other("stderr reader panicked")))?
        .map_err(ProcessRunnerError::Output)?;
    Ok((stdout, stderr))
}

fn prepend_path(entries: &[PathBuf]) -> OsString {
    let existing = env::var_os("PATH").unwrap_or_default();
    let mut parts = entries.to_vec();
    parts.extend(env::split_paths(&existing));
    env::join_paths(parts).unwrap_or(existing)
}

#[cfg(windows)]
fn configure_hidden_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const CREATE_SUSPENDED: u32 = 0x0000_0004;
    command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
}

#[cfg(not(windows))]
fn configure_hidden_window(_command: &mut Command) {}

/// Parent directories that portable Strawberry Perl needs on `PATH` so XS DLLs
/// (e.g. `Compress::Raw::Lzma` → `liblzma-5.dll`) can load.
pub fn strawberry_perl_path_entries(perl_executable: &Path) -> Vec<PathBuf> {
    let mut entries = Vec::new();
    if let Some(bin) = perl_executable.parent() {
        entries.push(bin.to_path_buf());
        // .../perl/<ver>/perl/bin/perl.exe → .../perl/<ver>/c/bin
        if let Some(version_root) = bin.parent().and_then(Path::parent) {
            let c_bin = version_root.join("c").join("bin");
            if c_bin.is_dir() {
                entries.push(c_bin);
            }
        }
    }
    entries
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oversized_status_lines_are_discarded_and_capture_stays_bounded() {
        let (sender, receiver) = mpsc::sync_channel(32);
        let mut bytes = vec![b'x'; 70 * 1024];
        bytes.extend_from_slice(b"\n{\"progress\":[1,2]}\nlast");
        let captured = read_capped_observed(bytes.as_slice(), 12, Some(sender)).unwrap();
        assert_eq!(captured.bytes.len(), 12);
        assert!(captured.truncated);
        assert_eq!(
            receiver.try_iter().collect::<Vec<_>>(),
            ["{\"progress\":[1,2]}", "last"]
        );
    }

    #[cfg(windows)]
    #[test]
    fn live_stdout_can_cancel_a_running_native_child() {
        let mut request = ProcessRequest::new("powershell.exe");
        request.args = ["-NoProfile", "-NonInteractive", "-Command", "[Console]::WriteLine('{\"progress\":[1,2]}'); [Console]::Out.Flush(); Start-Sleep -Seconds 30"].map(OsString::from).to_vec();
        let cancellation = CancellationToken::default();
        let mut received = false;
        let start = Instant::now();
        let result = run_process_observed(
            &request,
            Some(&cancellation),
            |line| {
                if line.contains("progress") {
                    received = true;
                    cancellation.cancel();
                }
            },
            || Ok(()),
        );
        assert!(received);
        assert!(matches!(result, Err(ProcessRunnerError::Cancelled)));
        assert!(start.elapsed() < Duration::from_secs(15));
    }

    #[test]
    fn cancellation_token_is_shared_between_clones() {
        let token = CancellationToken::default();
        let clone = token.clone();
        assert!(!clone.is_cancelled());
        token.cancel();
        assert!(clone.is_cancelled());
    }

    #[cfg(windows)]
    #[test]
    fn windows_job_runs_a_real_child_and_captures_output() {
        let mut request = ProcessRequest::new("cmd.exe");
        request.args = ["/D", "/C", "echo managed-child"]
            .map(OsString::from)
            .to_vec();
        let output = run_process(&request, None).unwrap();
        assert!(output.success);
        assert!(output.stdout.contains("managed-child"));
    }

    #[cfg(windows)]
    #[test]
    fn dropping_managed_child_terminates_the_native_process() {
        use std::os::windows::io::{AsRawHandle, BorrowedHandle};
        use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
        use windows_sys::Win32::System::Threading::WaitForSingleObject;
        let mut command = Command::new("powershell.exe");
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Sleep -Seconds 30",
        ]);
        configure_hidden_window(&mut command);
        let process = ManagedChild::spawn(&mut command).unwrap();
        let handle = unsafe { BorrowedHandle::borrow_raw(process.child.as_raw_handle()) }
            .try_clone_to_owned()
            .unwrap();
        drop(process);
        assert_eq!(
            unsafe { WaitForSingleObject(handle.as_raw_handle(), 2_000) },
            WAIT_OBJECT_0
        );
    }

    #[cfg(windows)]
    #[test]
    fn closing_the_job_handle_kills_the_child_without_explicit_termination() {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
        use windows_sys::Win32::System::Threading::WaitForSingleObject;

        let job = windows_job::ProcessJob::new().unwrap();
        let mut command = Command::new("powershell.exe");
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Sleep -Seconds 30",
        ]);
        configure_hidden_window(&mut command);
        let mut child = command.spawn().unwrap();
        job.attach_and_resume(&child).unwrap();
        // This is the same kernel cleanup used if the owning application exits abruptly.
        drop(job);
        assert_eq!(
            unsafe { WaitForSingleObject(child.as_raw_handle(), 2_000) },
            WAIT_OBJECT_0
        );
        child.wait().unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn cancelling_a_managed_process_also_terminates_its_descendant() {
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
            WaitForSingleObject,
        };

        let temp = tempfile::tempdir().unwrap();
        let pid_file = temp.path().join("descendant.pid");
        let mut command = Command::new("powershell.exe");
        command.args(["-NoProfile", "-NonInteractive", "-Command", r#"
            $child = Start-Process -FilePath "$PSHOME\powershell.exe" -ArgumentList '-NoProfile -NonInteractive -Command Start-Sleep -Seconds 30' -WindowStyle Hidden -PassThru
            [System.IO.File]::WriteAllText($env:ARC_RECALL_TEST_PID_FILE, [string]$child.Id)
            Start-Sleep -Seconds 30
        "#]);
        command.env("ARC_RECALL_TEST_PID_FILE", &pid_file);
        configure_hidden_window(&mut command);
        let mut process = ManagedChild::spawn(&mut command).unwrap();
        let started = Instant::now();
        let pid = loop {
            if let Some(pid) = std::fs::read_to_string(&pid_file)
                .ok()
                .and_then(|text| text.parse::<u32>().ok())
            {
                break pid;
            }
            assert!(
                started.elapsed() < Duration::from_secs(15),
                "descendant did not start"
            );
            thread::sleep(Duration::from_millis(25));
        };
        let raw = unsafe {
            OpenProcess(
                PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                0,
                pid,
            )
        };
        assert!(
            !raw.is_null(),
            "descendant should be running before cancellation"
        );
        let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
        assert!(
            process.job.contains(&handle).unwrap(),
            "descendant must belong to the managed job"
        );
        assert_eq!(
            unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) },
            windows_sys::Win32::Foundation::WAIT_TIMEOUT,
            "descendant must still be alive before cancellation"
        );
        process
            .kill()
            .expect("terminating the job and child should succeed");
        process.wait().unwrap();
        assert_eq!(
            unsafe { WaitForSingleObject(handle.as_raw_handle(), 2_000) },
            WAIT_OBJECT_0
        );
        process.kill().expect("repeated termination should succeed");
    }
}
