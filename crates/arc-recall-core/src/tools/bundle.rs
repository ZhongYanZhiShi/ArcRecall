use std::ffi::OsString;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::runner::{ProcessRequest, run_process};

pub const ENGINE_BUNDLE_MANIFEST_VERSION: u32 = 1;
pub const ENGINE_BUNDLE_TARGET: &str = "windows-x86_64";
pub const SEVEN_ZIP_VERSION: &str = "26.02";
pub const JOHN_VERSION: &str = "1.9.0-jumbo-1";
pub const PERL_VERSION: &str = "5.42.2.1";

const SEVEN_ZIP_ARCHIVE: &str = "packages/7z2602-x64.exe";
const SEVEN_ZIP_SHA256: &str = "6745fa76dc2ea031596d8678f6f6b99c3c1b435b4164a63485adbbc7b8d82ef0";
const BOOTSTRAP_ARCHIVE: &str = "bootstrap/7zr.exe";
const BOOTSTRAP_SHA256: &str = "56b8cc9f4971cef253644fafe54063ed7fdca551d4dee0f8c6baa81b855acd72";
const HASHCAT_ARCHIVE: &str = "packages/hashcat-7.1.2.7z";
const HASHCAT_SHA256: &str = "80db0316387794ce9d14ed376da75b8a7742972485b45db790f5f8260307ff98";
const JOHN_ARCHIVE: &str = "packages/john-1.9.0-jumbo-1-win64.7z";
const JOHN_SHA256: &str = "ce05a898b72bb30c3c4f703e3ffcf25966c1b1801eb7e095030b44092ef92eaf";
const PERL_ARCHIVE: &str = "packages/strawberry-perl-5.42.2.1-64bit-portable.zip";
const PERL_SHA256: &str = "32d83be90cf04b807cfb9477482bc36302cdee6f5b04cf57e81adecbd8f07898";
const JOHN_SOURCE_ARCHIVE: &str = "sources/john-1.9.0-jumbo-1.tar.xz";
const JOHN_SOURCE_SHA256: &str = "f5d123f82983c53d8cc598e174394b074be7a77756f5fb5ed8515918c81e7f3b";
const SEVEN_ZIP_SOURCE_ARCHIVE: &str = "sources/7z2602-src.7z";
const SEVEN_ZIP_SOURCE_SHA256: &str =
    "c7502dd4557481f52ccf1b3e680329f1fdd207e79a25544afeb3106325474944";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineComponentStatus {
    pub id: String,
    pub name: String,
    pub version: String,
    pub bundled: bool,
    pub installed: bool,
    pub runnable: bool,
    pub executable_path: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FullEngineBundleStatus {
    pub manifest_version: u32,
    pub target: String,
    pub platform_supported: bool,
    pub bundled: bool,
    pub installed: bool,
    pub resource_directory: String,
    pub tools_directory: String,
    pub seven_zip: EngineComponentStatus,
    pub hashcat: EngineComponentStatus,
    pub john: EngineComponentStatus,
    pub perl: EngineComponentStatus,
    pub has_7z2john: bool,
    pub has_rar2john: bool,
    pub has_zip2john: bool,
    pub john_cpu_ready: bool,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FullEngineBundleInstallResult {
    pub success: bool,
    pub message: String,
    pub seven_zip_path: String,
    pub hashcat_path: String,
    pub john_tools_directory: String,
    pub perl_path: String,
}

#[derive(Debug, thiserror::Error)]
pub enum EngineBundleError {
    #[error("当前完整引擎包仅支持 Windows x64")]
    UnsupportedPlatform,
    #[error("发行包未包含完整引擎资源：{0}")]
    MissingResource(String),
    #[error("引擎资源校验失败：{0}")]
    ChecksumMismatch(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("外部工具执行失败：{0}")]
    Process(String),
    #[error("{0}")]
    Message(String),
}

pub struct FullEngineBundleManager {
    resource_root: PathBuf,
    tools_dir: PathBuf,
}

impl FullEngineBundleManager {
    pub fn new(resource_dir: impl Into<PathBuf>, tools_dir: impl Into<PathBuf>) -> Self {
        Self {
            resource_root: resource_dir
                .into()
                .join("engine-bundle")
                .join(ENGINE_BUNDLE_TARGET),
            tools_dir: tools_dir.into(),
        }
    }

    pub fn resource_root(&self) -> &Path {
        &self.resource_root
    }

    pub fn tools_directory(&self) -> &Path {
        &self.tools_dir
    }

    pub fn seven_zip_executable(&self) -> PathBuf {
        self.tools_dir
            .join("7zip")
            .join(SEVEN_ZIP_VERSION)
            .join("7z.exe")
    }

    pub fn hashcat_executable(&self) -> PathBuf {
        self.tools_dir
            .join("hashcat")
            .join(super::HASHCAT_MANIFEST_VERSION)
            .join("hashcat.exe")
    }

    pub fn john_root(&self) -> PathBuf {
        self.tools_dir.join("john").join(JOHN_VERSION)
    }

    pub fn john_tools_directory(&self) -> PathBuf {
        self.john_root().join("run")
    }

    pub fn perl_executable(&self) -> PathBuf {
        self.tools_dir
            .join("perl")
            .join(PERL_VERSION)
            .join("perl")
            .join("bin")
            .join("perl.exe")
    }

    /// Probe only the component required for archive compression and extraction.
    pub fn seven_zip_status(&self) -> EngineComponentStatus {
        probe_component(
            "7zip",
            "7-Zip",
            SEVEN_ZIP_VERSION,
            self.resources_present(),
            self.seven_zip_executable(),
            ["i"],
            "7-Zip",
        )
    }

    pub fn status(&self) -> FullEngineBundleStatus {
        let seven_zip = self.seven_zip_status();
        let bundled = seven_zip.bundled;
        let hashcat = probe_component(
            "hashcat",
            "Hashcat",
            super::HASHCAT_MANIFEST_VERSION,
            bundled,
            self.hashcat_executable(),
            ["--version"],
            "7.1.2",
        );
        let john_dir = self.john_tools_directory();
        let john = probe_component(
            "john",
            "John the Ripper",
            JOHN_VERSION,
            bundled,
            john_dir.join("john.exe"),
            ["--list=build-info"],
            "1.9.0",
        );
        let perl = probe_component(
            "perl",
            "Strawberry Perl",
            PERL_VERSION,
            bundled,
            self.perl_executable(),
            ["-v"],
            "perl",
        );
        let has_7z2john = john_dir.join("7z2john.pl").is_file();
        let has_rar2john = john_dir.join("rar2john.exe").is_file();
        let has_zip2john = john_dir.join("zip2john.exe").is_file();
        let john_cpu_ready = john.runnable;
        let installed = seven_zip.runnable
            && hashcat.runnable
            && john_cpu_ready
            && perl.runnable
            && has_7z2john
            && has_rar2john
            && has_zip2john;
        let platform_supported = cfg!(all(windows, target_arch = "x86_64"));
        let message = if !platform_supported {
            "当前完整引擎资源只为 Windows x64 构建。".into()
        } else if installed {
            "完整引擎包已安装并通过进程探测。".into()
        } else if bundled {
            "完整引擎资源已随安装包提供，可离线部署到工具目录。".into()
        } else {
            "当前构建未暂存完整引擎资源；请使用完整发行构建命令。".into()
        };

        FullEngineBundleStatus {
            manifest_version: ENGINE_BUNDLE_MANIFEST_VERSION,
            target: ENGINE_BUNDLE_TARGET.into(),
            platform_supported,
            bundled,
            installed,
            resource_directory: self.resource_root.display().to_string(),
            tools_directory: self.tools_dir.display().to_string(),
            seven_zip,
            hashcat,
            john,
            perl,
            has_7z2john,
            has_rar2john,
            has_zip2john,
            john_cpu_ready,
            message,
        }
    }

    pub fn install(&self) -> Result<FullEngineBundleInstallResult, EngineBundleError> {
        if !cfg!(all(windows, target_arch = "x86_64")) {
            return Err(EngineBundleError::UnsupportedPlatform);
        }
        self.verify_resources()?;
        fs::create_dir_all(&self.tools_dir)?;

        let staging_root = self
            .tools_dir
            .join(".arc-recall-staging")
            .join(unique_stamp());
        fs::create_dir_all(&staging_root)?;

        let result = self.install_inner(&staging_root);
        if staging_root.starts_with(&self.tools_dir) {
            let _ = fs::remove_dir_all(&staging_root);
        }
        result
    }

    fn install_inner(
        &self,
        staging_root: &Path,
    ) -> Result<FullEngineBundleInstallResult, EngineBundleError> {
        let bootstrap = self.resource_root.join(BOOTSTRAP_ARCHIVE);
        let seven_zip_install_dir = self
            .seven_zip_executable()
            .parent()
            .expect("7-Zip executable has a parent")
            .to_path_buf();
        install_component(
            &bootstrap,
            &self.resource_root.join(SEVEN_ZIP_ARCHIVE),
            &seven_zip_install_dir,
            staging_root.join("7zip"),
            ComponentLayout::ExecutableParent("7z.exe"),
        )?;

        let seven_zip = self.seven_zip_executable();
        let hashcat_install_dir = self
            .hashcat_executable()
            .parent()
            .expect("hashcat executable has a parent")
            .to_path_buf();
        install_component(
            &seven_zip,
            &self.resource_root.join(HASHCAT_ARCHIVE),
            &hashcat_install_dir,
            staging_root.join("hashcat"),
            ComponentLayout::ExecutableParent("hashcat.exe"),
        )?;
        install_component(
            &seven_zip,
            &self.resource_root.join(JOHN_ARCHIVE),
            &self.john_root(),
            staging_root.join("john"),
            ComponentLayout::ParentOfDirectoryContaining("john.exe"),
        )?;
        let perl_install_dir = self
            .perl_executable()
            .ancestors()
            .nth(3)
            .expect("Perl executable has an install root")
            .to_path_buf();
        install_component(
            &seven_zip,
            &self.resource_root.join(PERL_ARCHIVE),
            &perl_install_dir,
            staging_root.join("perl"),
            ComponentLayout::ParentOfDirectoryContainingDirectory("perl.exe"),
        )?;

        let status = self.status();
        if !status.installed {
            return Err(EngineBundleError::Message(format!(
                "资源已展开，但完整探测未通过：{}",
                status.message
            )));
        }
        Ok(FullEngineBundleInstallResult {
            success: true,
            message: "7-Zip、Hashcat、John、Perl 及三个 *2john 转换器已离线部署。".into(),
            seven_zip_path: self.seven_zip_executable().display().to_string(),
            hashcat_path: self.hashcat_executable().display().to_string(),
            john_tools_directory: self.john_tools_directory().display().to_string(),
            perl_path: self.perl_executable().display().to_string(),
        })
    }

    fn resources_present(&self) -> bool {
        [
            "manifest.json",
            "THIRD_PARTY_NOTICES.md",
            BOOTSTRAP_ARCHIVE,
            SEVEN_ZIP_ARCHIVE,
            HASHCAT_ARCHIVE,
            JOHN_ARCHIVE,
            PERL_ARCHIVE,
            JOHN_SOURCE_ARCHIVE,
            SEVEN_ZIP_SOURCE_ARCHIVE,
        ]
        .iter()
        .all(|relative| self.resource_root.join(relative).is_file())
    }

    fn verify_resources(&self) -> Result<(), EngineBundleError> {
        if !self.resources_present() {
            return Err(EngineBundleError::MissingResource(
                self.resource_root.display().to_string(),
            ));
        }
        for (relative, expected) in [
            (BOOTSTRAP_ARCHIVE, BOOTSTRAP_SHA256),
            (SEVEN_ZIP_ARCHIVE, SEVEN_ZIP_SHA256),
            (HASHCAT_ARCHIVE, HASHCAT_SHA256),
            (JOHN_ARCHIVE, JOHN_SHA256),
            (PERL_ARCHIVE, PERL_SHA256),
            (JOHN_SOURCE_ARCHIVE, JOHN_SOURCE_SHA256),
            (SEVEN_ZIP_SOURCE_ARCHIVE, SEVEN_ZIP_SOURCE_SHA256),
        ] {
            let actual = sha256_file(&self.resource_root.join(relative))?;
            if !actual.eq_ignore_ascii_case(expected) {
                return Err(EngineBundleError::ChecksumMismatch(relative.into()));
            }
        }
        Ok(())
    }
}

enum ComponentLayout {
    ExecutableParent(&'static str),
    ParentOfDirectoryContaining(&'static str),
    ParentOfDirectoryContainingDirectory(&'static str),
}

fn install_component(
    extractor: &Path,
    archive: &Path,
    install_dir: &Path,
    staging_dir: PathBuf,
    layout: ComponentLayout,
) -> Result<(), EngineBundleError> {
    if component_sentinel(install_dir, &layout).is_file() {
        return Ok(());
    }
    if install_dir.exists() {
        return Err(EngineBundleError::Message(format!(
            "发现不完整的引擎目录：{}。请移走该版本目录后重试。",
            install_dir.display()
        )));
    }
    fs::create_dir_all(&staging_dir)?;
    extract_archive(extractor, archive, &staging_dir)?;
    let source_root = locate_component_root(&staging_dir, &layout).ok_or_else(|| {
        EngineBundleError::Message(format!(
            "归档 {} 中未找到预期可执行文件。",
            archive.display()
        ))
    })?;
    if let Some(parent) = install_dir.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::rename(&source_root, install_dir)?;
    Ok(())
}

fn component_sentinel(install_dir: &Path, layout: &ComponentLayout) -> PathBuf {
    match layout {
        ComponentLayout::ExecutableParent(name) => install_dir.join(name),
        ComponentLayout::ParentOfDirectoryContaining(name) => install_dir.join("run").join(name),
        ComponentLayout::ParentOfDirectoryContainingDirectory(name) => {
            install_dir.join("perl").join("bin").join(name)
        }
    }
}

fn locate_component_root(staging_dir: &Path, layout: &ComponentLayout) -> Option<PathBuf> {
    let executable = match layout {
        ComponentLayout::ExecutableParent(name)
        | ComponentLayout::ParentOfDirectoryContaining(name)
        | ComponentLayout::ParentOfDirectoryContainingDirectory(name) => {
            find_file(staging_dir, name)?
        }
    };
    match layout {
        ComponentLayout::ExecutableParent(_) => executable.parent().map(Path::to_path_buf),
        ComponentLayout::ParentOfDirectoryContaining(_) => {
            executable.parent()?.parent().map(Path::to_path_buf)
        }
        ComponentLayout::ParentOfDirectoryContainingDirectory(_) => {
            executable.ancestors().nth(3).map(Path::to_path_buf)
        }
    }
}

fn extract_archive(
    extractor: &Path,
    archive: &Path,
    destination: &Path,
) -> Result<(), EngineBundleError> {
    let mut request = ProcessRequest::new(extractor);
    request.args = vec![
        OsString::from("x"),
        OsString::from("-y"),
        OsString::from("-aoa"),
        OsString::from(format!("-o{}", destination.display())),
        archive.as_os_str().to_owned(),
    ];
    request.current_dir = extractor.parent().map(Path::to_path_buf);
    request.timeout = Duration::from_secs(30 * 60);
    request.max_output_bytes = 1024 * 1024;
    let output = run_process(&request, None)
        .map_err(|error| EngineBundleError::Process(format!("{}：{error}", extractor.display())))?;
    if !output.success {
        let detail = if output.stderr.trim().is_empty() {
            output.stdout.trim()
        } else {
            output.stderr.trim()
        };
        return Err(EngineBundleError::Process(format!(
            "{} 解压失败（exit={:?}）：{}",
            archive.display(),
            output.exit_code,
            detail
        )));
    }
    Ok(())
}

fn probe_component<const N: usize>(
    id: &str,
    name: &str,
    version: &str,
    bundled: bool,
    executable: PathBuf,
    args: [&str; N],
    marker: &str,
) -> EngineComponentStatus {
    let installed = executable.is_file();
    if !installed {
        return EngineComponentStatus {
            id: id.into(),
            name: name.into(),
            version: version.into(),
            bundled,
            installed: false,
            runnable: false,
            executable_path: executable.display().to_string(),
            message: "尚未安装到工具目录。".into(),
        };
    }
    let mut request = ProcessRequest::new(&executable);
    request.args = args.iter().map(|arg| OsString::from(*arg)).collect();
    request.current_dir = executable.parent().map(Path::to_path_buf);
    request.timeout = Duration::from_secs(8);
    request.max_output_bytes = 256 * 1024;
    match run_process(&request, None) {
        Ok(output) => {
            let combined = format!("{}\n{}", output.stdout, output.stderr);
            let runnable =
                output.success && combined.to_lowercase().contains(&marker.to_lowercase());
            EngineComponentStatus {
                id: id.into(),
                name: name.into(),
                version: version.into(),
                bundled,
                installed,
                runnable,
                executable_path: executable.display().to_string(),
                message: if runnable {
                    "进程探测通过。".into()
                } else {
                    format!(
                        "进程已启动，但版本输出异常（exit={:?}）。",
                        output.exit_code
                    )
                },
            }
        }
        Err(error) => EngineComponentStatus {
            id: id.into(),
            name: name.into(),
            version: version.into(),
            bundled,
            installed,
            runnable: false,
            executable_path: executable.display().to_string(),
            message: error.to_string(),
        },
    }
}

fn find_file(directory: &Path, file_name: &str) -> Option<PathBuf> {
    for entry in fs::read_dir(directory).ok()?.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_file(&path, file_name) {
                return Some(found);
            }
        } else if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case(file_name))
        {
            return Some(path);
        }
    }
    None
}

fn sha256_file(path: &Path) -> Result<String, std::io::Error> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn unique_stamp() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("{}-{nanos}", std::process::id())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expected_paths_are_versioned_under_tools_root() {
        let dir = tempfile::tempdir().unwrap();
        let manager = FullEngineBundleManager::new(dir.path().join("resources"), dir.path());
        assert!(manager.seven_zip_executable().starts_with(dir.path()));
        assert!(
            manager
                .hashcat_executable()
                .to_string_lossy()
                .contains(super::super::HASHCAT_MANIFEST_VERSION)
        );
        assert!(
            manager
                .john_tools_directory()
                .to_string_lossy()
                .contains(JOHN_VERSION)
        );
        assert!(
            manager
                .perl_executable()
                .to_string_lossy()
                .contains(PERL_VERSION)
        );
    }

    #[test]
    fn missing_resources_are_reported_as_not_bundled() {
        let dir = tempfile::tempdir().unwrap();
        let manager =
            FullEngineBundleManager::new(dir.path().join("resources"), dir.path().join("tools"));
        let status = manager.status();
        assert!(!status.bundled);
        assert!(!status.installed);
        assert!(!status.has_zip2john);
        let seven_zip = manager.seven_zip_status();
        assert_eq!(seven_zip.id, "7zip");
        assert!(!seven_zip.installed);
        assert_eq!(seven_zip, status.seven_zip);
    }

    #[test]
    #[ignore = "requires `pnpm engine-bundle:prepare` and expands the large real tool bundle"]
    fn prepared_windows_bundle_installs_and_runs() {
        if !cfg!(all(windows, target_arch = "x86_64")) {
            return;
        }
        let resource_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("src-tauri")
            .join("resources");
        let tools = tempfile::tempdir().unwrap();
        let manager = FullEngineBundleManager::new(resource_dir, tools.path());
        assert!(manager.status().bundled);

        let result = manager.install().unwrap();
        assert!(result.success);
        let status = manager.status();
        assert!(status.installed, "{status:#?}");
        assert!(status.has_7z2john);
        assert!(status.has_rar2john);
        assert!(status.has_zip2john);
        assert!(status.john_cpu_ready);
    }
}
