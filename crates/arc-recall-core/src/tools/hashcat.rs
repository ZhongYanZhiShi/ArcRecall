use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::CancellationToken;
use super::install_io::{CancellableReader, check_cancelled, publish_installation, sha256_file};

/// Pinned release — never use `/latest` for installs (matches original ArcRecall).
pub const HASHCAT_MANIFEST_VERSION: &str = "7.1.2";
pub const HASHCAT_GITHUB_REPO: &str = "https://github.com/hashcat/hashcat";

/// Official Windows/Linux binary bundle on GitHub Releases (7z).
const HASHCAT_DOWNLOAD_URL: &str =
    "https://github.com/hashcat/hashcat/releases/download/v7.1.2/hashcat-7.1.2.7z";

/// SHA-256 of `hashcat-7.1.2.7z` (from ArcRecall ExternalToolManifest).
const HASHCAT_SHA256: &str = "80db0316387794ce9d14ed376da75b8a7742972485b45db790f5f8260307ff98";

const MAX_DOWNLOAD_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HashcatStatus {
    pub version: String,
    pub download_url: String,
    pub github_repo: String,
    pub installed: bool,
    pub executable_path: String,
    pub install_directory: String,
    /// Effective tools root used for install (custom or default).
    pub tools_directory: String,
    /// Built-in default tools root (`…/ArcRecall/tools`).
    pub default_tools_directory: String,
    /// User-configured public tools root (empty = use default).
    pub configured_tools_directory: String,
    /// Path from settings if set (may differ from install layout).
    pub configured_path: String,
    pub configured_exists: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HashcatInstallResult {
    pub success: bool,
    pub message: String,
    pub executable_path: String,
}

#[derive(Debug, thiserror::Error)]
pub enum HashcatToolError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("download error: {0}")]
    Download(String),
    #[error("checksum mismatch")]
    ChecksumMismatch,
    #[error("extract error: {0}")]
    Extract(String),
    #[error("{0}")]
    Message(String),
}

pub struct HashcatToolDownloader {
    tools_dir: PathBuf,
    default_tools_dir: PathBuf,
    configured_tools_dir: String,
    temp_dir: PathBuf,
}

impl HashcatToolDownloader {
    pub fn new(
        tools_dir: impl Into<PathBuf>,
        default_tools_dir: impl Into<PathBuf>,
        configured_tools_dir: impl Into<String>,
        temp_dir: impl Into<PathBuf>,
    ) -> Self {
        Self {
            tools_dir: tools_dir.into(),
            default_tools_dir: default_tools_dir.into(),
            configured_tools_dir: configured_tools_dir.into(),
            temp_dir: temp_dir.into(),
        }
    }

    pub fn tools_directory(&self) -> &Path {
        &self.tools_dir
    }

    pub fn install_directory(&self) -> PathBuf {
        self.tools_dir
            .join("hashcat")
            .join(HASHCAT_MANIFEST_VERSION)
    }

    pub fn expected_executable(&self) -> PathBuf {
        self.install_directory().join(hashcat_exe_name())
    }

    pub fn status(&self, configured_path: &str) -> HashcatStatus {
        let exe = self.expected_executable();
        let installed = complete_hashcat_directory(&self.install_directory());
        let configured = configured_path.trim();
        let configured_exists = !configured.is_empty() && Path::new(configured).is_file();
        HashcatStatus {
            version: HASHCAT_MANIFEST_VERSION.into(),
            download_url: HASHCAT_DOWNLOAD_URL.into(),
            github_repo: HASHCAT_GITHUB_REPO.into(),
            installed,
            executable_path: if installed {
                exe.display().to_string()
            } else {
                String::new()
            },
            install_directory: self.install_directory().display().to_string(),
            tools_directory: self.tools_dir.display().to_string(),
            default_tools_directory: self.default_tools_dir.display().to_string(),
            configured_tools_directory: self.configured_tools_dir.trim().to_string(),
            configured_path: configured.to_string(),
            configured_exists,
        }
    }

    /// Download pinned hashcat release, verify SHA-256, extract into tools/.
    pub fn install(&self) -> Result<HashcatInstallResult, HashcatToolError> {
        self.install_with_cancellation(&CancellationToken::default())
    }

    pub fn install_with_cancellation(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<HashcatInstallResult, HashcatToolError> {
        check_cancelled(cancellation)?;
        fs::create_dir_all(&self.tools_dir)?;
        fs::create_dir_all(&self.temp_dir)?;

        let expected = self.expected_executable();
        if complete_hashcat_directory(&self.install_directory()) {
            return Ok(HashcatInstallResult {
                success: true,
                message: format!("hashcat {HASHCAT_MANIFEST_VERSION} 已安装。"),
                executable_path: expected.display().to_string(),
            });
        }

        let download = tempfile::Builder::new()
            .prefix("hashcat-download-")
            .tempdir_in(&self.temp_dir)?;
        let archive_path = download.path().join("hashcat.7z");
        download_file(
            HASHCAT_DOWNLOAD_URL,
            &archive_path,
            MAX_DOWNLOAD_BYTES,
            cancellation,
        )?;
        if !sha256_file(&archive_path, cancellation)?.eq_ignore_ascii_case(HASHCAT_SHA256) {
            return Err(HashcatToolError::ChecksumMismatch);
        }

        self.install_archive(&archive_path, cancellation)?;

        Ok(HashcatInstallResult {
            success: true,
            message: format!("hashcat {HASHCAT_MANIFEST_VERSION} 已安装并写入路径。"),
            executable_path: expected.display().to_string(),
        })
    }

    fn install_archive(
        &self,
        archive: &Path,
        cancellation: &CancellationToken,
    ) -> Result<(), HashcatToolError> {
        check_cancelled(cancellation)?;
        let install_dir = self.install_directory();
        let parent = install_dir
            .parent()
            .expect("versioned install has a parent");
        fs::create_dir_all(parent)?;
        // Extract on the destination volume. A failed extraction never exposes a
        // partially copied executable in the published installation directory.
        let staging = tempfile::Builder::new()
            .prefix(".hashcat-staging-")
            .tempdir_in(parent)?;
        let extract_dir = staging.path().join("extract");
        extract_7z(archive, &extract_dir, cancellation)?;
        let extracted_exe = find_hashcat_exe(&extract_dir).ok_or_else(|| {
            HashcatToolError::Message("下载包中未找到 hashcat 可执行文件，未安装。".into())
        })?;
        let extracted_root = extracted_exe
            .parent()
            .expect("extracted executable has a parent");
        if !complete_hashcat_directory(extracted_root) {
            return Err(HashcatToolError::Message(
                "下载包缺少 Hashcat 运行资源，未安装。".into(),
            ));
        }
        if complete_hashcat_directory(&install_dir) {
            return Ok(());
        }
        // Preserve an old incomplete installation so retry can repair it without
        // deleting files that may have been placed there by the user.
        check_cancelled(cancellation)?;
        publish_installation(extracted_root, &install_dir)?;
        Ok(())
    }
}

pub(super) fn complete_hashcat_directory(root: &Path) -> bool {
    root.join(hashcat_exe_name()).is_file()
        && root.join("tunings/Alias.hctune").is_file()
        && ["OpenCL", "modules"].iter().all(|directory| {
            fs::read_dir(root.join(directory))
                .is_ok_and(|entries| entries.flatten().any(|entry| entry.path().is_file()))
        })
}

fn hashcat_exe_name() -> &'static str {
    if cfg!(windows) {
        "hashcat.exe"
    } else {
        "hashcat"
    }
}

fn download_file(
    url: &str,
    dest: &Path,
    max_bytes: u64,
    cancellation: &CancellationToken,
) -> Result<(), HashcatToolError> {
    check_cancelled(cancellation)?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    runtime.block_on(async {
        let transfer = async {
            let client = reqwest::Client::builder()
                .user_agent(concat!("ArcRecall/", env!("CARGO_PKG_VERSION")))
                .timeout(Duration::from_secs(600))
                .build()
                .map_err(|error| HashcatToolError::Download(error.to_string()))?;
            let mut response = client
                .get(url)
                .send()
                .await
                .and_then(reqwest::Response::error_for_status)
                .map_err(|error| HashcatToolError::Download(error.to_string()))?;
            let mut file = File::create(dest)?;
            let mut total = 0u64;
            while let Some(bytes) = response
                .chunk()
                .await
                .map_err(|error| HashcatToolError::Download(error.to_string()))?
            {
                check_cancelled(cancellation)?;
                total += bytes.len() as u64;
                if total > max_bytes {
                    return Err(HashcatToolError::Download(format!(
                        "下载超过大小上限（{} MiB）",
                        max_bytes / 1024 / 1024
                    )));
                }
                file.write_all(&bytes)?;
            }
            file.flush()?;
            Ok(())
        };
        let mut transfer = std::pin::pin!(transfer);
        loop {
            check_cancelled(cancellation)?;
            // Keep polling the same transfer; dropping it cancels pending network I/O.
            if let Ok(result) =
                tokio::time::timeout(Duration::from_millis(100), transfer.as_mut()).await
            {
                return result;
            }
        }
    })
}

fn extract_7z(
    archive: &Path,
    dest: &Path,
    cancellation: &CancellationToken,
) -> Result<(), HashcatToolError> {
    check_cancelled(cancellation)?;
    let reader = CancellableReader::new(File::open(archive)?, cancellation);
    sevenz_rust::decompress_with_extract_fn(reader, dest, |entry, reader, path| {
        check_cancelled(cancellation).map_err(sevenz_rust::Error::io)?;
        let mut reader = CancellableReader::new(reader, cancellation);
        sevenz_rust::default_entry_extract_fn(entry, &mut reader, path)
    })
    .map_err(|error| HashcatToolError::Extract(error.to_string()))
}

fn find_hashcat_exe(root: &Path) -> Option<PathBuf> {
    let name = hashcat_exe_name();
    walk_find(root, name)
}

fn walk_find(dir: &Path, file_name: &str) -> Option<PathBuf> {
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = walk_find(&path, file_name) {
                return Some(found);
            }
        } else if path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.eq_ignore_ascii_case(file_name))
        {
            return Some(path);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_interrupts_stalled_headers_and_body() {
        use std::io::Read;
        use std::net::TcpListener;
        use std::sync::mpsc;
        for send_headers in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let (ready_tx, ready_rx) = mpsc::channel();
            let (stop_tx, stop_rx) = mpsc::channel();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    stream.read_exact(&mut byte).unwrap();
                    request.push(byte[0]);
                }
                if send_headers {
                    stream
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n")
                        .unwrap();
                }
                ready_tx.send(()).unwrap();
                let _ = stop_rx.recv_timeout(Duration::from_secs(5));
            });
            let directory = tempfile::tempdir().unwrap();
            let destination = directory.path().join("download");
            let cancellation = CancellationToken::default();
            let worker_token = cancellation.clone();
            let (done_tx, done_rx) = mpsc::channel();
            let worker = std::thread::spawn(move || {
                let result = download_file(
                    &format!("http://{address}"),
                    &destination,
                    1024,
                    &worker_token,
                );
                let _ = done_tx.send(result);
            });
            ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            cancellation.cancel();
            let result = done_rx.recv_timeout(Duration::from_secs(2));
            let _ = stop_tx.send(());
            server.join().unwrap();
            worker.join().unwrap();
            let error = result.unwrap().unwrap_err();
            assert!(
                error.to_string().contains("已取消"),
                "headers={send_headers}: {error:?}"
            );
        }
    }

    #[test]
    fn cancelled_install_does_not_publish_or_create_work_directories() {
        let directory = tempfile::tempdir().unwrap();
        let tools = directory.path().join("tools");
        let downloader =
            HashcatToolDownloader::new(&tools, &tools, "", directory.path().join("downloads"));
        let cancellation = CancellationToken::default();
        cancellation.cancel();
        assert!(downloader.install_with_cancellation(&cancellation).is_err());
        assert!(!tools.exists());
        assert!(
            downloader
                .install_archive(&directory.path().join("unused.7z"), &cancellation)
                .is_err()
        );
        assert!(!tools.exists());
    }

    #[test]
    fn installation_stages_all_resources_and_can_retry_after_failure() {
        let directory = tempfile::tempdir().unwrap();
        let tools = directory.path().join("tools");
        let downloader =
            HashcatToolDownloader::new(&tools, &tools, "", directory.path().join("downloads"));
        let package = directory.path().join("package");
        fs::create_dir(&package).unwrap();
        fs::write(package.join(hashcat_exe_name()), b"synthetic executable").unwrap();
        let archive = directory.path().join("hashcat.7z");
        sevenz_rust::compress_to_path(&package, &archive).unwrap();
        assert!(
            downloader
                .install_archive(&archive, &CancellationToken::default())
                .is_err()
        );
        assert!(!downloader.status("").installed);
        assert!(!downloader.install_directory().exists());
        assert_eq!(fs::read_dir(tools.join("hashcat")).unwrap().count(), 0);

        fs::create_dir_all(downloader.install_directory()).unwrap();
        fs::write(downloader.expected_executable(), b"incomplete old install").unwrap();
        assert!(!downloader.status("").installed);
        for resource in [
            "OpenCL/kernel.cl",
            "modules/module.dll",
            "tunings/Alias.hctune",
        ] {
            let path = package.join(resource);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, b"resource").unwrap();
        }
        sevenz_rust::compress_to_path(&package, &archive).unwrap();
        downloader
            .install_archive(&archive, &CancellationToken::default())
            .unwrap();
        assert!(downloader.status("").installed);
        assert_eq!(
            fs::read(downloader.expected_executable()).unwrap(),
            b"synthetic executable"
        );
        assert!(
            downloader
                .install_directory()
                .join("OpenCL/kernel.cl")
                .is_file()
        );
        let backup = fs::read_dir(tools.join("hashcat"))
            .unwrap()
            .filter_map(Result::ok)
            .find(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("engine-incomplete-")
            })
            .unwrap();
        assert_eq!(
            fs::read(backup.path().join("previous").join(hashcat_exe_name())).unwrap(),
            b"incomplete old install"
        );
        assert!(
            fs::read_dir(tools.join("hashcat"))
                .unwrap()
                .filter_map(Result::ok)
                .all(|entry| !entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".hashcat-staging-"))
        );
    }

    #[test]
    fn status_reports_not_installed_by_default() {
        let dir = tempfile::tempdir().unwrap();
        let tools = dir.path().join("tools");
        let dl = HashcatToolDownloader::new(&tools, &tools, "", dir.path().join("temp"));
        let status = dl.status("");
        assert!(!status.installed);
        assert_eq!(status.version, HASHCAT_MANIFEST_VERSION);
        assert!(status.download_url.contains("v7.1.2"));
        assert!(!status.download_url.to_ascii_lowercase().contains("latest"));
        assert_eq!(status.tools_directory, tools.display().to_string());
    }
}
