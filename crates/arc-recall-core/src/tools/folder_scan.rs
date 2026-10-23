use super::{CancellationToken, analyze_archive, path_for_display};
use serde::Serialize;
use std::{
    collections::{HashSet, VecDeque},
    fs,
    path::Path,
};

const MAX_VISITED: usize = 20_000;
const MAX_ARCHIVES: usize = 1_000;
const MAX_DEPTH: usize = 32;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedArchive {
    pub path: String,
    pub volume_paths: Vec<String>,
    pub format: String,
    pub file_size: u64,
    pub volume_count: u32,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanWarning {
    pub path: String,
    pub message: String,
}
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderScanResult {
    pub entries: Vec<ScannedArchive>,
    pub warnings: Vec<ScanWarning>,
    pub visited_entries: usize,
    pub ignored_files: usize,
    pub skipped_links: usize,
    pub truncated: bool,
    pub cancelled: bool,
}
fn key(path: &Path) -> String {
    let text = path_for_display(path);
    if cfg!(windows) {
        text.replace('/', "\\").to_lowercase()
    } else {
        text
    }
}
fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}
fn warn(result: &mut FolderScanResult, path: &Path, message: String) {
    if result.warnings.len() < 100 {
        result.warnings.push(ScanWarning {
            path: path_for_display(path),
            message,
        });
    } else {
        result.truncated = true;
    }
}
pub fn scan_archive_folder(
    root: &Path,
    include_subfolders: bool,
    cancellation: &CancellationToken,
) -> Result<FolderScanResult, String> {
    let metadata = fs::symlink_metadata(root).map_err(|e| e.to_string())?;
    if !metadata.is_dir() || is_link(&metadata) {
        return Err("请选择普通文件夹，不支持链接或目录联接。".into());
    }
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let mut pending = VecDeque::from([(root, 0usize)]);
    let mut seen = HashSet::new();
    let mut result = FolderScanResult::default();
    'scan: while let Some((directory, depth)) = pending.pop_front() {
        if cancellation.is_cancelled() {
            result.cancelled = true;
            break;
        }
        let children = match fs::read_dir(&directory) {
            Ok(children) => children,
            Err(e) => {
                warn(&mut result, &directory, e.to_string());
                continue;
            }
        };
        for child in children {
            if cancellation.is_cancelled() {
                result.cancelled = true;
                break 'scan;
            }
            if result.visited_entries >= MAX_VISITED || result.entries.len() >= MAX_ARCHIVES {
                result.truncated = true;
                break 'scan;
            }
            result.visited_entries += 1;
            let child = match child {
                Ok(child) => child,
                Err(e) => {
                    warn(&mut result, &directory, e.to_string());
                    continue;
                }
            };
            let path = child.path();
            let metadata = match fs::symlink_metadata(&path) {
                Ok(m) => m,
                Err(e) => {
                    warn(&mut result, &path, e.to_string());
                    continue;
                }
            };
            if is_link(&metadata) {
                result.skipped_links += 1;
                continue;
            }
            if metadata.is_dir() {
                if include_subfolders {
                    if depth < MAX_DEPTH {
                        pending.push_back((path, depth + 1));
                    } else {
                        result.truncated = true;
                    }
                }
                continue;
            }
            if !metadata.is_file() || seen.contains(&key(&path)) {
                continue;
            }
            match analyze_archive(&path) {
                Ok(analysis) => {
                    let primary = key(Path::new(&analysis.archive_path));
                    let duplicate = seen.contains(&primary);
                    seen.insert(primary);
                    seen.extend(analysis.volume_paths.iter().map(|p| key(p)));
                    if !duplicate {
                        result.entries.push(ScannedArchive {
                            volume_paths: analysis
                                .volume_paths
                                .iter()
                                .map(|p| path_for_display(p))
                                .collect(),
                            path: analysis.archive_path,
                            format: analysis.format_label,
                            file_size: analysis.file_size,
                            volume_count: analysis.volume_count,
                        });
                    }
                }
                Err(error) => {
                    result.ignored_files += 1;
                    let extension = path
                        .extension()
                        .and_then(|e| e.to_str())
                        .unwrap_or("")
                        .to_ascii_lowercase();
                    if matches!(extension.as_str(), "zip" | "7z" | "rar" | "lz4")
                        || extension.len() == 3 && extension.bytes().all(|b| b.is_ascii_digit())
                    {
                        warn(&mut result, &path, error.to_string());
                    }
                }
            }
        }
    }
    result
        .warnings
        .retain(|warning| !seen.contains(&key(Path::new(&warning.path))));
    result.entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scan_reports_invalid_archives_and_honors_cancellation() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("损坏归档.zip"), b"broken").unwrap();
        fs::write(temp.path().join("说明.txt"), b"plain").unwrap();
        let result = scan_archive_folder(temp.path(), true, &CancellationToken::default()).unwrap();
        assert_eq!(result.warnings.len(), 1);
        assert_eq!(result.ignored_files, 2);
        let token = CancellationToken::default();
        token.cancel();
        assert!(
            scan_archive_folder(temp.path(), true, &token)
                .unwrap()
                .cancelled
        );
    }
}
