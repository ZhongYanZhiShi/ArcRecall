use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum SevenZipConverter {
    Executable(PathBuf),
    PerlScript { perl: PathBuf, script: PathBuf },
}

/// Resolve one converter plan shared by readiness reporting and execution.
pub(super) fn resolve_seven_zip_converter(
    john_directory: &Path,
    perl: &Path,
) -> Option<SevenZipConverter> {
    if !john_directory.is_dir() {
        return None;
    }
    let executable = john_directory.join(exe_name("7z2john"));
    if executable.is_file() {
        return Some(SevenZipConverter::Executable(executable));
    }
    let script = john_directory.join("7z2john.pl");
    if script.is_file() && perl.is_file() {
        Some(SevenZipConverter::PerlScript {
            perl: perl.to_path_buf(),
            script,
        })
    } else {
        None
    }
}

/// Status of John-related hash converters used for external cracking.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JohnPerlStatus {
    pub john_tools_directory: String,
    pub perl_path: String,
    pub directory_exists: bool,
    pub has_7z2john_exe: bool,
    pub has_7z2john_pl: bool,
    pub has_rar2john_exe: bool,
    pub has_zip2john_exe: bool,
    pub has_john_exe: bool,
    pub perl_exists: bool,
    /// 7z2john.exe **or** (7z2john.pl + perl)
    pub seven_zip_converter_ready: bool,
    /// rar2john.exe present
    pub rar_converter_ready: bool,
    /// zip2john.exe present
    pub zip_converter_ready: bool,
    /// John CPU executable present
    pub john_cpu_ready: bool,
    pub ready: bool,
    pub message: String,
}

/// Probe John tools directory + Perl path (file existence only; no process spawn).
pub fn probe_john_perl(john_tools_directory: &str, perl_path: &str) -> JohnPerlStatus {
    let john_dir = john_tools_directory.trim();
    let perl = perl_path.trim();

    let directory_exists = !john_dir.is_empty() && Path::new(john_dir).is_dir();
    let has_7z2john_exe =
        directory_exists && path_exists(&Path::new(john_dir).join(exe_name("7z2john")));
    let has_7z2john_pl = directory_exists && Path::new(john_dir).join("7z2john.pl").is_file();
    let has_rar2john_exe =
        directory_exists && path_exists(&Path::new(john_dir).join(exe_name("rar2john")));
    let has_zip2john_exe =
        directory_exists && path_exists(&Path::new(john_dir).join(exe_name("zip2john")));
    let has_john_exe = directory_exists && path_exists(&Path::new(john_dir).join(exe_name("john")));
    let perl_exists = !perl.is_empty() && Path::new(perl).is_file();

    let seven_zip_converter_ready = directory_exists
        && resolve_seven_zip_converter(Path::new(john_dir), Path::new(perl)).is_some();
    let rar_converter_ready = has_rar2john_exe;
    let zip_converter_ready = has_zip2john_exe;
    let john_cpu_ready = has_john_exe;
    let ready =
        seven_zip_converter_ready && rar_converter_ready && zip_converter_ready && john_cpu_ready;

    let message = build_message(JohnProbeFacts {
        john_empty: john_dir.is_empty(),
        directory_exists,
        seven_zip_ok: seven_zip_converter_ready,
        rar_ok: rar_converter_ready,
        zip_ok: zip_converter_ready,
        john_cpu_ok: john_cpu_ready,
        has_pl: has_7z2john_pl,
        perl_ok: perl_exists,
    });

    JohnPerlStatus {
        john_tools_directory: john_dir.to_string(),
        perl_path: perl.to_string(),
        directory_exists,
        has_7z2john_exe,
        has_7z2john_pl,
        has_rar2john_exe,
        has_zip2john_exe,
        has_john_exe,
        perl_exists,
        seven_zip_converter_ready,
        rar_converter_ready,
        zip_converter_ready,
        john_cpu_ready,
        ready,
        message,
    }
}

fn path_exists(path: &Path) -> bool {
    path.is_file()
}

fn exe_name(base: &str) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(format!("{base}.exe"))
    } else {
        PathBuf::from(base)
    }
}

struct JohnProbeFacts {
    john_empty: bool,
    directory_exists: bool,
    seven_zip_ok: bool,
    rar_ok: bool,
    zip_ok: bool,
    john_cpu_ok: bool,
    has_pl: bool,
    perl_ok: bool,
}

fn build_message(facts: JohnProbeFacts) -> String {
    if facts.john_empty {
        return "尚未配置 John 工具目录。".into();
    }
    if !facts.directory_exists {
        return "John 工具目录不存在。".into();
    }

    let mut missing = Vec::new();
    if !facts.seven_zip_ok {
        if facts.has_pl && !facts.perl_ok {
            missing.push("perl.exe（用于 7z2john.pl）");
        } else {
            missing.push("7z2john.exe 或 7z2john.pl + perl");
        }
    }
    if !facts.rar_ok {
        missing.push("rar2john.exe");
    }
    if !facts.zip_ok {
        missing.push("zip2john.exe");
    }
    if !facts.john_cpu_ok {
        missing.push("john.exe（CPU 回退引擎）");
    }

    if missing.is_empty() {
        "John CPU 引擎与全部归档转换器已就绪。".into()
    } else {
        format!("缺少：{}", missing.join("、"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn empty_paths_not_ready() {
        let status = probe_john_perl("", "");
        assert!(!status.ready);
        assert!(!status.seven_zip_converter_ready);
    }

    #[test]
    fn detects_exe_converters() {
        let dir = tempfile::tempdir().unwrap();
        let name_7z = if cfg!(windows) {
            "7z2john.exe"
        } else {
            "7z2john"
        };
        let name_rar = if cfg!(windows) {
            "rar2john.exe"
        } else {
            "rar2john"
        };
        let name_zip = if cfg!(windows) {
            "zip2john.exe"
        } else {
            "zip2john"
        };
        let name_john = if cfg!(windows) { "john.exe" } else { "john" };
        fs::write(dir.path().join(name_7z), b"").unwrap();
        fs::write(dir.path().join(name_rar), b"").unwrap();
        fs::write(dir.path().join(name_zip), b"").unwrap();
        fs::write(dir.path().join(name_john), b"").unwrap();
        let status = probe_john_perl(dir.path().to_str().unwrap(), "");
        assert!(status.seven_zip_converter_ready);
        assert!(status.rar_converter_ready);
        assert!(status.zip_converter_ready);
        assert!(status.john_cpu_ready);
        assert!(status.ready);
    }

    #[test]
    fn pl_requires_perl() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("7z2john.pl"), b"").unwrap();
        let status = probe_john_perl(dir.path().to_str().unwrap(), "");
        assert!(!status.seven_zip_converter_ready);

        let perl = dir
            .path()
            .join(if cfg!(windows) { "perl.exe" } else { "perl" });
        fs::write(&perl, b"").unwrap();
        let status = probe_john_perl(dir.path().to_str().unwrap(), perl.to_str().unwrap());
        assert!(status.seven_zip_converter_ready);
        assert!(status.perl_exists);
    }
}
