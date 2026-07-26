use std::env;
use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

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

    let mut child = command.spawn().map_err(ProcessRunnerError::Spawn)?;
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
    let stdout_reader = thread::spawn(move || read_capped(stdout, output_limit));
    let stderr_reader = thread::spawn(move || read_capped(stderr, output_limit));
    let started = Instant::now();

    let status = loop {
        if cancellation.is_some_and(CancellationToken::is_cancelled) {
            let _ = child.kill();
            let _ = child.wait();
            join_output(stdout_reader, stderr_reader)?;
            return Err(ProcessRunnerError::Cancelled);
        }
        if started.elapsed() >= request.timeout {
            let _ = child.kill();
            let _ = child.wait();
            join_output(stdout_reader, stderr_reader)?;
            return Err(ProcessRunnerError::TimedOut(request.timeout.as_secs()));
        }
        match child.try_wait().map_err(ProcessRunnerError::Wait)? {
            Some(status) => break status,
            None => thread::sleep(Duration::from_millis(25)),
        }
    };

    let (stdout, stderr) = join_output(stdout_reader, stderr_reader)?;
    Ok(ProcessOutput {
        exit_code: status.code(),
        success: status.success(),
        stdout: String::from_utf8_lossy(&stdout.bytes).into_owned(),
        stderr: String::from_utf8_lossy(&stderr.bytes).into_owned(),
        stdout_truncated: stdout.truncated,
        stderr_truncated: stderr.truncated,
    })
}

fn read_capped(mut reader: impl Read, limit: usize) -> io::Result<CapturedOutput> {
    let mut captured = Vec::with_capacity(limit.min(64 * 1024));
    let mut buffer = [0u8; 16 * 1024];
    let mut truncated = false;
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        let remaining = limit.saturating_sub(captured.len());
        let keep = remaining.min(read);
        captured.extend_from_slice(&buffer[..keep]);
        truncated |= keep < read;
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
    command.creation_flags(CREATE_NO_WINDOW);
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
    fn cancellation_token_is_shared_between_clones() {
        let token = CancellationToken::default();
        let clone = token.clone();
        assert!(!clone.is_cancelled());
        token.cancel();
        assert!(clone.is_cancelled());
    }
}
