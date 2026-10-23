use super::*;
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveActionRequest {
    pub path: PathBuf,
    pub password: Option<String>,
    /// None tests the whole archive; Some selects exact files or directory subtrees.
    pub selected_paths: Option<Vec<String>>,
    pub output_parent: Option<PathBuf>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveActionResult {
    pub output_directory: Option<String>,
    pub entry_count: usize,
    pub message: String,
}

pub fn run_archive_action(
    request: &ArchiveActionRequest,
    seven_zip: &Path,
    workspace: &Path,
    cancellation: &CancellationToken,
) -> Result<ArchiveActionResult, String> {
    action(request, seven_zip, workspace, cancellation).map_err(|error| {
        if cancellation.is_cancelled() && !error.contains("无法清理") {
            "操作已取消。".into()
        } else {
            error
        }
    })
}

fn action(
    request: &ArchiveActionRequest,
    seven_zip: &Path,
    workspace: &Path,
    cancellation: &CancellationToken,
) -> Result<ArchiveActionResult, String> {
    let analysis = analyze_archive(&request.path).map_err(|e| e.to_string())?;
    let budget = TaskDiskBudget::default();
    let materialized = materialize_split_archive(&analysis, workspace, cancellation, &budget)
        .map_err(|e| e.to_string())?;
    let mut archive = materialized
        .as_ref()
        .map(|m| m.primary_path().to_path_buf())
        .unwrap_or_else(|| PathBuf::from(&analysis.archive_path));
    if is_lz4_frame(&archive).map_err(|e| e.to_string())? {
        archive =
            materialize_lz4_archive(&archive, analysis.format, workspace, cancellation, &budget)
                .map_err(|e| e.to_string())?
                .ok_or("无法准备内部归档。")?;
    }
    let tools = RecoveryToolPaths {
        seven_zip: seven_zip.into(),
        hashcat: PathBuf::new(),
        john_tools_directory: PathBuf::new(),
        perl: PathBuf::new(),
    };
    let password = request
        .password
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or("__arcrecall_probe__");
    if request.selected_paths.is_none() {
        let mut process = ProcessRequest::new(seven_zip);
        process.current_dir = seven_zip.parent().map(Path::to_path_buf);
        process.timeout = std::time::Duration::from_secs(24 * 60 * 60);
        process.max_output_bytes = 1024 * 1024;
        process.args = vec![
            "t".into(),
            "-y".into(),
            "-bd".into(),
            "-bso0".into(),
            seven_zip::seven_zip_password_arg(password),
            "--".into(),
            archive.into_os_string(),
        ];
        let output =
            run_process(&process, Some(cancellation)).map_err(|_| "完整性检查未完成，请重试。")?;
        if !output.success {
            return Err(
                "检查未通过：密码不正确、分卷缺失或归档损坏。请确认密码与所有分卷后重试。".into(),
            );
        }
        return Ok(ArchiveActionResult {
            output_directory: None,
            entry_count: 0,
            message: "完整性检查通过，当前归档所有条目均可读取；未展开检查嵌套归档。".into(),
        });
    }
    let listing =
        super::super::preview::preview_archive(&archive, Some(password), seven_zip, cancellation)?;
    if listing.truncated {
        return Err("归档超过 5000 项，暂不支持选择性解压，请使用整包解压。".into());
    }
    let selected = select_entries(
        &listing,
        request.selected_paths.as_deref().unwrap_or_default(),
    )?;
    let declared = seven_zip::ArchiveExtractionBudget {
        entry_count: selected.len() as u64,
        total_bytes: selected
            .iter()
            .map(|e| e.size)
            .fold(0u64, u64::saturating_add),
    };
    seven_zip::check_extraction_budget(declared, analysis.file_size).map_err(|e| e.to_string())?;
    let parent = request
        .output_parent
        .as_ref()
        .ok_or("请选择输出位置。")?
        .canonicalize()
        .map_err(|_| "输出位置不存在或无法访问。")?;
    if !parent.is_dir() {
        return Err("输出位置必须是文件夹。".into());
    }
    // A fresh directory prevents collisions and preexisting links. Failed outputs are removed.
    let output = tempfile::Builder::new()
        .prefix("ArcRecall-selected-")
        .tempdir_in(parent)
        .map_err(|e| e.to_string())?;
    let list_path = workspace.join("selected.txt");
    fs::write(
        &list_path,
        selected
            .iter()
            .map(|e| e.path.as_str())
            .collect::<Vec<_>>()
            .join("\n"),
    )
    .map_err(|e| e.to_string())?;
    let job = RecoveryJob {
        archive_path: archive,
        output_directory: output.path().into(),
        dictionary_path: PathBuf::new(),
        dictionary_count: 0,
        known_password: None,
        work_directory: workspace.into(),
    };
    let input = RecoveryInput {
        job: &job,
        archive_bytes: analysis.file_size,
        disk_budget: &budget,
        cached_listing: None,
    };
    let extraction = seven_zip::extract_preflighted(
        &input,
        &tools,
        password,
        cancellation,
        declared,
        &mut |_| {},
        Some(&list_path),
    )
    .and_then(|_| ensure_not_cancelled(cancellation));
    if extraction.is_err() {
        let output_path = path_for_display(output.path());
        output
            .close()
            .map_err(|_| format!("操作未完成，无法清理临时输出，请检查：{output_path}"))?;
        return Err("选择性解压未完成：请检查密码、归档和磁盘空间；未完成的输出已清理。".into());
    }
    let count = selected.len();
    Ok(ArchiveActionResult {
        output_directory: Some(path_for_display(&output.keep())),
        entry_count: count,
        message: format!("已提取 {count} 个条目，保留归档内部目录结构。"),
    })
}

fn safe_member(path: &str) -> bool {
    !path.is_empty()
        && !path.chars().any(char::is_control)
        && !path.contains(':')
        && !path.contains(['*', '?', '<', '>', '"', '|'])
        && !path.starts_with(['/', '\\'])
        && path.split(['/', '\\']).all(|part| {
            let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
            let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                || (stem.starts_with("COM") || stem.starts_with("LPT"))
                    && stem.len() == 4
                    && stem.as_bytes()[3].is_ascii_digit();
            !part.is_empty()
                && part != "."
                && part != ".."
                && !part.ends_with(['.', ' '])
                && !reserved
        })
}

fn select_entries<'a>(
    listing: &'a super::super::preview::ArchivePreview,
    paths: &[String],
) -> Result<Vec<&'a super::super::preview::ArchivePreviewEntry>, String> {
    if paths.is_empty() || paths.len() > 5000 {
        return Err("请选择 1–5000 个条目。".into());
    }
    // Fail closed for ambiguous listings and links, including ancestors of selected files.
    if listing
        .entries
        .iter()
        .any(|e| e.link || !safe_member(&e.path))
    {
        return Err("归档包含链接或不安全路径，无法选择性解压。".into());
    }
    let mut unique = std::collections::HashSet::new();
    if listing
        .entries
        .iter()
        .any(|entry| !unique.insert(entry.path.replace('\\', "/").to_lowercase()))
    {
        return Err("归档包含重名路径，无法可靠选择条目，请使用整包解压。".into());
    }
    let by_path: std::collections::HashMap<_, _> = listing
        .entries
        .iter()
        .map(|e| (e.path.as_str(), e))
        .collect();
    let mut directories = Vec::new();
    let mut exact = std::collections::HashSet::new();
    for path in paths {
        let entry = by_path
            .get(path.as_str())
            .ok_or("所选条目已不存在，请重新读取归档目录。")?;
        exact.insert(path.as_str());
        if entry.directory {
            directories.push(path.replace('\\', "/") + "/");
        }
    }
    let selected = listing
        .entries
        .iter()
        .filter(|entry| {
            exact.contains(entry.path.as_str())
                || directories
                    .iter()
                    .any(|prefix| entry.path.replace('\\', "/").starts_with(prefix))
        })
        .collect();
    Ok(selected)
}

#[cfg(test)]
mod tests {
    use super::super::super::preview::{ArchivePreview, ArchivePreviewEntry};
    use super::*;
    #[test]
    fn directory_selection_respects_boundaries_and_rejects_stale_members_and_links() {
        let mut listing = ArchivePreview {
            entries: ["目录", "目录/资料.txt", "目录-其他/资料.txt", "@文件.txt"]
                .iter()
                .enumerate()
                .map(|(i, path)| ArchivePreviewEntry {
                    path: (*path).into(),
                    size: 1,
                    directory: i == 0,
                    encrypted: false,
                    link: false,
                })
                .collect(),
            total_entries: 4,
            total_bytes: 3,
            truncated: false,
        };
        assert_eq!(select_entries(&listing, &["目录".into()]).unwrap().len(), 2);
        assert_eq!(
            select_entries(&listing, &["@文件.txt".into()])
                .unwrap()
                .len(),
            1
        );
        assert!(select_entries(&listing, &[]).is_err());
        assert!(select_entries(&listing, &["不存在.txt".into()]).is_err());
        listing.entries[0].link = true;
        assert!(select_entries(&listing, &["目录/资料.txt".into()]).is_err());
    }
    #[test]
    fn selected_members_reject_escape_and_line_injection() {
        for path in [
            "../outside",
            "C:/outside",
            "/outside",
            "folder\nextra",
            "folder/../file",
            "folder/file.",
        ] {
            assert!(!safe_member(path));
        }
        assert!(safe_member("[测试分组] 中文目录/资料.txt"));
        assert!(safe_member("@literal.txt"));
    }
}
