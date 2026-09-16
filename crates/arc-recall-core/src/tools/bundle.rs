use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::install_io::{check_cancelled, publish_installation, sha256_file};
use super::runner::{CancellationToken, ProcessRequest, run_process};

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
        self.seven_zip_status_with_cancellation(None)
    }

    fn seven_zip_status_with_cancellation(
        &self,
        cancellation: Option<&CancellationToken>,
    ) -> EngineComponentStatus {
        probe_component(
            "7zip",
            "7-Zip",
            SEVEN_ZIP_VERSION,
            self.resources_present(),
            self.seven_zip_executable(),
            (["i"], "7-Zip"),
            cancellation,
        )
    }

    pub fn status(&self) -> FullEngineBundleStatus {
        self.status_with_cancellation(None)
    }

    fn status_with_cancellation(
        &self,
        cancellation: Option<&CancellationToken>,
    ) -> FullEngineBundleStatus {
        let seven_zip = self.seven_zip_status_with_cancellation(cancellation);
        let bundled = seven_zip.bundled;
        let hashcat = probe_component(
            "hashcat",
            "Hashcat",
            super::HASHCAT_MANIFEST_VERSION,
            bundled,
            self.hashcat_executable(),
            (["--version"], "7.1.2"),
            cancellation,
        );
        let john_dir = self.john_tools_directory();
        let john = probe_component(
            "john",
            "John the Ripper",
            JOHN_VERSION,
            bundled,
            john_dir.join("john.exe"),
            (["--list=build-info"], "1.9.0"),
            cancellation,
        );
        let perl = probe_component(
            "perl",
            "Strawberry Perl",
            PERL_VERSION,
            bundled,
            self.perl_executable(),
            (["-v"], "perl"),
            cancellation,
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
        self.install_with_cancellation(&CancellationToken::default())
    }

    pub fn install_with_cancellation(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<FullEngineBundleInstallResult, EngineBundleError> {
        check_cancelled(cancellation)?;
        if !cfg!(all(windows, target_arch = "x86_64")) {
            return Err(EngineBundleError::UnsupportedPlatform);
        }
        self.verify_resources(cancellation)?;
        fs::create_dir_all(&self.tools_dir)?;

        let staging_root = self
            .tools_dir
            .join(".arc-recall-staging")
            .join(unique_stamp());
        fs::create_dir_all(&staging_root)?;

        let result = self.install_inner(&staging_root, cancellation);
        if staging_root.starts_with(&self.tools_dir) {
            let _ = fs::remove_dir_all(&staging_root);
        }
        result
    }

    fn install_inner(
        &self,
        staging_root: &Path,
        cancellation: &CancellationToken,
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
            ComponentLayout::SevenZip,
            cancellation,
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
            ComponentLayout::Hashcat,
            cancellation,
        )?;
        install_component(
            &seven_zip,
            &self.resource_root.join(JOHN_ARCHIVE),
            &self.john_root(),
            staging_root.join("john"),
            ComponentLayout::John,
            cancellation,
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
            ComponentLayout::Perl,
            cancellation,
        )?;

        let status = self.status_with_cancellation(Some(cancellation));
        check_cancelled(cancellation)?;
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

    fn verify_resources(&self, cancellation: &CancellationToken) -> Result<(), EngineBundleError> {
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
            let actual = sha256_file(&self.resource_root.join(relative), cancellation)?;
            if !actual.eq_ignore_ascii_case(expected) {
                return Err(EngineBundleError::ChecksumMismatch(relative.into()));
            }
        }
        Ok(())
    }
}

enum ComponentLayout {
    SevenZip,
    Hashcat,
    John,
    Perl,
}

impl ComponentLayout {
    fn executable(&self) -> &'static str {
        match self {
            Self::SevenZip => "7z.exe",
            Self::Hashcat => "hashcat.exe",
            Self::John => "run/john.exe",
            Self::Perl => "perl/bin/perl.exe",
        }
    }

    fn is_complete(&self, root: &Path) -> bool {
        let required: &[&str] = match self {
            Self::SevenZip => &["7z.exe", "7z.dll"],
            Self::Hashcat => return super::hashcat::complete_hashcat_directory(root),
            Self::John => &[
                "run/john.exe",
                "run/7z2john.pl",
                "run/rar2john.exe",
                "run/zip2john.exe",
            ],
            Self::Perl => &[
                "perl/bin/perl.exe",
                "perl/bin/perl542.dll",
                "perl/lib/Config.pm",
            ],
        };
        required.iter().all(|path| root.join(path).is_file())
    }
}

fn install_component(
    extractor: &Path,
    archive: &Path,
    install_dir: &Path,
    staging_dir: PathBuf,
    layout: ComponentLayout,
    cancellation: &CancellationToken,
) -> Result<(), EngineBundleError> {
    check_cancelled(cancellation)?;
    if layout.is_complete(install_dir) {
        return Ok(());
    }
    fs::create_dir_all(&staging_dir)?;
    extract_archive(extractor, archive, &staging_dir, cancellation)?;
    let source_root = locate_component_root(&staging_dir, &layout).ok_or_else(|| {
        EngineBundleError::Message(format!(
            "归档 {} 中未找到预期可执行文件。",
            archive.display()
        ))
    })?;
    if !layout.is_complete(&source_root) {
        return Err(EngineBundleError::Message(format!(
            "归档 {} 缺少必要运行文件，未替换现有安装。",
            archive.display()
        )));
    }
    check_cancelled(cancellation)?;
    publish_installation(&source_root, install_dir)?;
    Ok(())
}

fn locate_component_root(staging_dir: &Path, layout: &ComponentLayout) -> Option<PathBuf> {
    let relative = Path::new(layout.executable());
    let executable = find_file(staging_dir, relative.file_name()?.to_str()?)?;
    executable
        .ancestors()
        .nth(relative.components().count())
        .map(Path::to_path_buf)
}

fn extract_archive(
    extractor: &Path,
    archive: &Path,
    destination: &Path,
    cancellation: &CancellationToken,
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
    let output = run_process(&request, Some(cancellation))
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
    probe: ([&str; N], &str),
    cancellation: Option<&CancellationToken>,
) -> EngineComponentStatus {
    let (args, marker) = probe;
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
    match run_process(&request, cancellation) {
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
    fn cancelled_bundle_does_not_touch_installation() {
        let directory = tempfile::tempdir().unwrap();
        let tools = directory.path().join("tools");
        let manager = FullEngineBundleManager::new(directory.path().join("resources"), &tools);
        let cancellation = CancellationToken::default();
        cancellation.cancel();
        assert!(
            manager
                .install_with_cancellation(&cancellation)
                .unwrap_err()
                .to_string()
                .contains("已取消")
        );
        assert!(!tools.exists());
    }

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

        // Reinstall must repair missing support files even while the executables remain.
        for path in [
            manager.seven_zip_executable().with_file_name("7z.dll"),
            manager
                .hashcat_executable()
                .with_file_name("tunings")
                .join("Alias.hctune"),
            manager.john_tools_directory().join("zip2john.exe"),
            manager.perl_executable().with_file_name("perl542.dll"),
        ] {
            fs::remove_file(path).unwrap();
        }
        fs::write(manager.john_root().join("user-note.txt"), "keep me").unwrap();
        assert!(!manager.status().installed);
        assert!(manager.install().unwrap().success);
        assert!(manager.status().installed);
        let backups: Vec<_> = fs::read_dir(manager.john_root().parent().unwrap())
            .unwrap()
            .flatten()
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("engine-incomplete-")
            })
            .collect();
        assert_eq!(backups.len(), 1);
        assert_eq!(
            fs::read_to_string(backups[0].path().join("previous/user-note.txt")).unwrap(),
            "keep me"
        );
    }
}
