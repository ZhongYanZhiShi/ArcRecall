use super::{CancellationToken, ProcessRequest, analyze_archive, run_process};
use serde::Serialize;
use std::{ffi::OsString, path::Path, time::Duration};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivePreviewEntry {
    pub path: String,
    pub size: u64,
    pub directory: bool,
    pub encrypted: bool,
    pub link: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivePreview {
    pub entries: Vec<ArchivePreviewEntry>,
    pub total_entries: usize,
    pub total_bytes: u64,
    pub truncated: bool,
}

pub fn preview_archive(
    path: &Path,
    password: Option<&str>,
    seven_zip: &Path,
    cancellation: &CancellationToken,
) -> Result<ArchivePreview, String> {
    let analysis = analyze_archive(path).map_err(|e| e.to_string())?;
    let mut request = ProcessRequest::new(seven_zip);
    request.current_dir = seven_zip.parent().map(Path::to_path_buf);
    request.timeout = Duration::from_secs(120);
    request.max_output_bytes = 32 * 1024 * 1024;
    request.args = vec![
        "l".into(),
        "-slt".into(),
        "-sccUTF-8".into(),
        "-bd".into(),
        "-y".into(),
        OsString::from(format!("-p{}", password.unwrap_or("__arcrecall_preview__"))),
        "--".into(),
        analysis.archive_path.into(),
    ];
    let output = run_process(&request, Some(cancellation))
        .map_err(|_| "无法读取归档目录，预览已停止。".to_string())?;
    if !output.success {
        return Err(
            "无法读取目录：请检查分卷是否齐全；加密目录需要在已知密码栏填写正确密码后重试。".into(),
        );
    }
    if output.stdout_truncated || output.stderr_truncated {
        return Err("归档目录过大，超过预览读取上限。".into());
    }
    parse_listing(&output.stdout)
}

fn parse_listing(text: &str) -> Result<ArchivePreview, String> {
    let normalized = text.replace("\r\n", "\n");
    let (_, body) = normalized
        .split_once("\n----------\n")
        .ok_or("无法识别归档目录格式。")?;
    let mut result = ArchivePreview {
        entries: vec![],
        total_entries: 0,
        total_bytes: 0,
        truncated: false,
    };
    for block in body.split("\n\n") {
        let mut entry = ArchivePreviewEntry {
            path: String::new(),
            size: 0,
            directory: false,
            encrypted: false,
            link: false,
        };
        for line in block.lines() {
            if let Some(path) = line.strip_prefix("Path = ") {
                entry.path = path.to_owned();
            }
            if let Some(size) = line.strip_prefix("Size = ") {
                entry.size = size.parse().map_err(|_| "无效的目录大小。")?;
            }
            if line == "Folder = +"
                || line
                    .strip_prefix("Attributes = ")
                    .is_some_and(|v| v.starts_with('D'))
            {
                entry.directory = true;
            }
            if line == "Encrypted = +" {
                entry.encrypted = true;
            }
            if line.starts_with("Symbolic Link = ")
                || line.starts_with("Hard Link = ")
                || line
                    .strip_prefix("Attributes = ")
                    .is_some_and(|v| v.split_whitespace().any(|a| a.starts_with('l')))
            {
                entry.link = true;
            }
        }
        if entry.path.is_empty() {
            continue;
        }
        result.total_entries += 1;
        if !entry.directory {
            result.total_bytes = result.total_bytes.saturating_add(entry.size);
        }
        if result.entries.len() < 5000 {
            result.entries.push(entry);
        } else {
            result.truncated = true;
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn listing_excludes_container_and_preserves_unicode_paths() {
        let preview = parse_listing("Path = 归档.zip\r\nSize = 100\r\n\r\n----------\r\nPath = [测试分组] 中文目录\r\nFolder = +\r\nSize = 0\r\n\r\nPath = [测试分组] 中文目录/资料.txt\r\nSize = 42\r\nEncrypted = +\r\n").unwrap();
        assert_eq!(preview.total_entries, 2);
        assert_eq!(preview.total_bytes, 42);
        assert!(preview.entries[0].directory);
        assert!(preview.entries[1].encrypted);
        assert!(parse_listing("invalid").is_err());
    }
    #[test]
    fn bounded_preview_keeps_complete_totals() {
        let text = format!(
            "\n----------\n{}",
            "Path = 文件.txt\nSize = 1\n\n".repeat(5002)
        );
        let preview = parse_listing(&text).unwrap();
        assert_eq!(preview.entries.len(), 5000);
        assert_eq!(preview.total_entries, 5002);
        assert_eq!(preview.total_bytes, 5002);
        assert!(preview.truncated);
    }
}
