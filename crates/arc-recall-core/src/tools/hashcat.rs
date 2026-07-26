use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

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
        let installed = exe.is_file();
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
        fs::create_dir_all(&self.tools_dir)?;
        fs::create_dir_all(&self.temp_dir)?;

        let expected = self.expected_executable();
        if expected.is_file() {
            return Ok(HashcatInstallResult {
                success: true,
                message: format!("hashcat {HASHCAT_MANIFEST_VERSION} 已安装。"),
                executable_path: expected.display().to_string(),
            });
        }

        let install_dir = self.install_directory();
        if install_dir.exists() {
            return Err(HashcatToolError::Message(format!(
                "安装目录不完整：{}。请手动清理后重试。",
                install_dir.display()
            )));
        }

        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let temp_root = self
            .temp_dir
            .join("tool-downloads")
            .join(format!("hashcat-{stamp}"));
        let archive_path = temp_root.join("hashcat.7z");
        let extract_dir = temp_root.join("extract");

        let cleanup = || {
            let _ = fs::remove_dir_all(&temp_root);
        };

        if let Err(e) = fs::create_dir_all(&temp_root) {
            cleanup();
            return Err(e.into());
        }

        if let Err(e) = download_file(HASHCAT_DOWNLOAD_URL, &archive_path, MAX_DOWNLOAD_BYTES) {
            cleanup();
            return Err(e);
        }

        match sha256_file(&archive_path) {
            Ok(actual) if actual.eq_ignore_ascii_case(HASHCAT_SHA256) => {}
            Ok(_) => {
                cleanup();
                return Err(HashcatToolError::ChecksumMismatch);
            }
            Err(e) => {
                cleanup();
                return Err(e);
            }
        }

        if let Err(e) = extract_7z(&archive_path, &extract_dir) {
            cleanup();
            return Err(e);
        }

        let found = find_hashcat_exe(&extract_dir);
        let Some(extracted_exe) = found else {
            cleanup();
            return Err(HashcatToolError::Message(
                "下载包中未找到 hashcat 可执行文件，未安装。".into(),
            ));
        };

        let extracted_root = extracted_exe
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or(extract_dir.clone());

        if let Some(parent) = install_dir.parent()
            && let Err(e) = fs::create_dir_all(parent)
        {
            cleanup();
            return Err(e.into());
        }

        if let Err(e) = fs::rename(&extracted_root, &install_dir) {
            // Cross-device rename may fail; fall back to copy.
            if let Err(copy_err) = copy_dir_all(&extracted_root, &install_dir) {
                cleanup();
                return Err(HashcatToolError::Io(copy_err));
            }
            let _ = e;
        }

        cleanup();

        if !expected.is_file() {
            return Err(HashcatToolError::Message(
                "安装后未找到 hashcat 可执行文件。".into(),
            ));
        }

        Ok(HashcatInstallResult {
            success: true,
            message: format!("hashcat {HASHCAT_MANIFEST_VERSION} 已安装并写入路径。"),
            executable_path: expected.display().to_string(),
        })
    }
}

fn hashcat_exe_name() -> &'static str {
    if cfg!(windows) {
        "hashcat.exe"
    } else {
        "hashcat"
    }
}

fn download_file(url: &str, dest: &Path, max_bytes: u64) -> Result<(), HashcatToolError> {
    let client = reqwest::blocking::Client::builder()
        .user_agent(concat!("ArcRecall/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| HashcatToolError::Download(e.to_string()))?;

    let mut response = client
        .get(url)
        .send()
        .map_err(|e| HashcatToolError::Download(e.to_string()))?
        .error_for_status()
        .map_err(|e| HashcatToolError::Download(e.to_string()))?;

    let mut file = File::create(dest)?;
    let mut buffer = [0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let n = response
            .read(&mut buffer)
            .map_err(|e| HashcatToolError::Download(e.to_string()))?;
        if n == 0 {
            break;
        }
        total += n as u64;
        if total > max_bytes {
            return Err(HashcatToolError::Download(format!(
                "下载超过大小上限（{} MiB）",
                max_bytes / 1024 / 1024
            )));
        }
        file.write_all(&buffer[..n])?;
    }
    file.flush()?;
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String, HashcatToolError> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn extract_7z(archive: &Path, dest: &Path) -> Result<(), HashcatToolError> {
    fs::create_dir_all(dest)?;
    sevenz_rust::decompress_file(archive, dest)
        .map_err(|e| HashcatToolError::Extract(e.to_string()))
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

fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &to)?;
        } else {
            fs::copy(entry.path(), to)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn expected_path_is_under_tools() {
        let dir = tempfile::tempdir().unwrap();
        let tools = dir.path().join("shared-tools");
        let default = dir.path().join("tools");
        let dl = HashcatToolDownloader::new(
            &tools,
            &default,
            tools.display().to_string(),
            dir.path().join("temp"),
        );
        let exe = dl.expected_executable();
        assert!(exe.starts_with(&tools));
        assert!(exe.to_string_lossy().contains("7.1.2"));
    }
}
