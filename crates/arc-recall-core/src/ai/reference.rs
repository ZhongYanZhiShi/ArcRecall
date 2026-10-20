use std::collections::HashSet;
use std::fs::{self, File, Metadata};
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::AiError;

const MAX_FILES: usize = 8;
const MAX_FILE_BYTES: usize = 8 * 1024;
const MAX_TOTAL_BYTES: usize = 32 * 1024;
const MAX_SCAN_ENTRIES: usize = 2_000;
const MAX_DEPTH: usize = 32;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiNameReferenceRequest {
    pub sources: Vec<String>,
    pub extensions: String,
    /// None preserves automatic selection for callers without a preview; Some([]) reads no files.
    #[serde(default)]
    pub selected_paths: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AiReferenceFile {
    file_name: String,
    content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiReferencePreviewFile {
    #[serde(flatten)]
    reference: AiReferenceFile,
    pub source_path: String,
    pub truncated: bool,
}

pub(super) fn collect_reference_files(
    request: &AiNameReferenceRequest,
) -> Result<Vec<AiReferenceFile>, AiError> {
    Ok(
        collect_reference_preview(request, request.selected_paths.as_deref())?
            .into_iter()
            .map(|file| file.reference)
            .collect(),
    )
}

pub fn preview_archive_name_reference(
    request: &AiNameReferenceRequest,
) -> Result<Vec<AiReferencePreviewFile>, AiError> {
    // Deselected files remain visible in the preview so they can be selected again.
    collect_reference_preview(request, None)
}

fn collect_reference_preview(
    request: &AiNameReferenceRequest,
    selected_paths: Option<&[String]>,
) -> Result<Vec<AiReferencePreviewFile>, AiError> {
    let extensions = parse_extensions(&request.extensions)?;
    let selected_paths: Option<HashSet<PathBuf>> = selected_paths.map(|paths| {
        paths
            .iter()
            .filter_map(|path| Path::new(path).canonicalize().ok())
            .collect()
    });
    if selected_paths.as_ref().is_some_and(HashSet::is_empty) {
        return Ok(Vec::new());
    }
    let mut collector = ReferenceCollector {
        extensions,
        selected_paths,
        files: Vec::new(),
        seen: HashSet::new(),
        scanned: 0,
        total_bytes: 0,
    };
    for source in &request.sources {
        collector.visit(Path::new(source), 0);
        if collector.full() {
            break;
        }
    }
    Ok(collector.files)
}

fn parse_extensions(value: &str) -> Result<Vec<String>, AiError> {
    let mut extensions = Vec::new();
    for token in value.split(|c: char| c.is_whitespace() || matches!(c, ',' | '，' | ';' | '；'))
    {
        if token.is_empty() {
            continue;
        }
        let extension = token
            .strip_prefix("*.")
            .unwrap_or_else(|| token.trim_start_matches('.'))
            .to_ascii_lowercase();
        if extension.is_empty()
            || extension.len() > 32
            || extension.ends_with('.')
            || !extension
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-' | b'+'))
        {
            return Err(AiError::InvalidConfiguration(
                "参考文件扩展名无效，请使用 txt、.md 等扩展名，并用逗号或空格分隔。".into(),
            ));
        }
        let suffix = format!(".{extension}");
        if !extensions.contains(&suffix) {
            extensions.push(suffix);
        }
        if extensions.len() > 32 {
            return Err(AiError::InvalidConfiguration(
                "参考文件扩展名最多可配置 32 种。".into(),
            ));
        }
    }
    if extensions.is_empty() {
        return Err(AiError::InvalidConfiguration(
            "请至少填写一种参考文件扩展名，例如 txt, md。".into(),
        ));
    }
    Ok(extensions)
}

struct ReferenceCollector {
    extensions: Vec<String>,
    selected_paths: Option<HashSet<PathBuf>>,
    files: Vec<AiReferencePreviewFile>,
    seen: HashSet<PathBuf>,
    scanned: usize,
    total_bytes: usize,
}

impl ReferenceCollector {
    fn full(&self) -> bool {
        self.files.len() >= MAX_FILES
            || self.total_bytes >= MAX_TOTAL_BYTES
            || self.scanned >= MAX_SCAN_ENTRIES
    }

    fn visit(&mut self, path: &Path, depth: usize) {
        if self.full() || depth > MAX_DEPTH {
            return;
        }
        self.scanned += 1;
        let Ok(metadata) = fs::symlink_metadata(path) else {
            return;
        };
        // Do not follow symlinks or Windows junctions outside the selected sources.
        if is_link(&metadata) {
            return;
        }
        if metadata.is_dir() {
            let Ok(entries) = fs::read_dir(path) else {
                return;
            };
            let mut paths: Vec<_> = entries
                .take(MAX_SCAN_ENTRIES - self.scanned)
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .collect();
            paths.sort();
            for path in paths {
                self.visit(&path, depth + 1);
                if self.full() {
                    break;
                }
            }
        } else if metadata.is_file() {
            let file_name = path.file_name().unwrap_or_default().to_string_lossy();
            let lower_name = file_name.to_ascii_lowercase();
            if !self.extensions.iter().any(|ext| lower_name.ends_with(ext)) {
                return;
            }
            let Ok(canonical) = path.canonicalize() else {
                return;
            };
            if self
                .selected_paths
                .as_ref()
                .is_some_and(|selected| !selected.contains(&canonical))
            {
                return;
            }
            if !self.seen.insert(canonical) {
                return;
            }
            let Some(excerpt) = read_text_excerpt(path) else {
                return;
            };
            let content = truncate_utf8(&excerpt.content, MAX_TOTAL_BYTES - self.total_bytes);
            if content.trim().is_empty() {
                return;
            }
            self.total_bytes += content.len();
            self.files.push(AiReferencePreviewFile {
                reference: AiReferenceFile {
                    file_name: file_name.chars().take(256).collect(),
                    content: content.into(),
                },
                source_path: path.to_string_lossy().into_owned(),
                truncated: excerpt.truncated || content.len() < excerpt.content.len(),
            });
        }
    }
}

fn is_link(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    metadata.file_type().is_symlink()
}

fn truncate_utf8(value: &str, max_bytes: usize) -> &str {
    let mut end = value.len().min(max_bytes);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

struct TextExcerpt {
    content: String,
    truncated: bool,
}

fn read_text_excerpt(path: &Path) -> Option<TextExcerpt> {
    let mut bytes = Vec::new();
    File::open(path)
        .ok()?
        .take((MAX_FILE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .ok()?;
    let truncated = bytes.len() > MAX_FILE_BYTES;
    bytes.truncate(MAX_FILE_BYTES);
    let text = if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        let little_endian = bytes[0] == 0xff;
        if !truncated && bytes.len() % 2 != 0 {
            return None;
        }
        let mut units: Vec<_> = bytes[2..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| {
                if little_endian {
                    u16::from_le_bytes([pair[0], pair[1]])
                } else {
                    u16::from_be_bytes([pair[0], pair[1]])
                }
            })
            .collect();
        if truncated
            && units
                .last()
                .is_some_and(|unit| (0xd800..=0xdbff).contains(unit))
        {
            units.pop();
        }
        String::from_utf16(&units).ok()?
    } else {
        let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
        match std::str::from_utf8(bytes) {
            Ok(text) => text.into(),
            Err(error) if truncated && error.error_len().is_none() => {
                std::str::from_utf8(&bytes[..error.valid_up_to()])
                    .ok()?
                    .into()
            }
            Err(_) => return None,
        }
    };
    if text
        .chars()
        .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    {
        return None;
    }
    Some(TextExcerpt {
        content: text,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(sources: &[&Path], extensions: &str) -> AiNameReferenceRequest {
        AiNameReferenceRequest {
            sources: sources
                .iter()
                .map(|path| path.to_string_lossy().into())
                .collect(),
            extensions: extensions.into(),
            selected_paths: None,
        }
    }

    #[test]
    fn collects_custom_extensions_recursively_without_duplicates_or_absolute_paths() {
        let root = tempfile::tempdir().unwrap();
        let nested = root.path().join("nested");
        fs::create_dir(&nested).unwrap();
        let direct = root.path().join("说明.TXT");
        fs::write(&direct, "项目交付资料").unwrap();
        fs::write(nested.join("README.md"), "# 测试项目").unwrap();
        fs::write(nested.join("info.custom"), "自定义内容").unwrap();
        fs::write(nested.join("ignored.json"), "不应读取").unwrap();
        fs::write(nested.join("binary.txt"), b"\0binary").unwrap();
        let files =
            collect_reference_files(&request(&[root.path(), &direct], ".TXT，*.md; custom"))
                .unwrap();
        assert_eq!(files.len(), 3);
        let json = serde_json::to_string(&files).unwrap();
        assert!(json.contains("自定义内容"));
        assert!(json.contains("项目交付资料"));
        assert!(!json.contains("不应读取"));
        assert!(!json.contains("binary"));
        assert!(!json.contains(&root.path().to_string_lossy().to_string()));
    }

    #[test]
    fn validates_extensions_and_allows_missing_or_unreadable_sources() {
        for extensions in ["", " , ; ", "*", "../txt", "txt/path"] {
            assert!(parse_extensions(extensions).is_err(), "{extensions}");
        }
        assert_eq!(parse_extensions("txt .TXT *.md").unwrap(), [".txt", ".md"]);
        assert!(
            collect_reference_files(&request(&[Path::new("missing-file.txt")], "txt"))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn bounds_file_count_total_size_and_preserves_utf8_at_the_read_boundary() {
        let root = tempfile::tempdir().unwrap();
        for index in 0..12 {
            fs::write(
                root.path().join(format!("{index:02}.txt")),
                "中".repeat(MAX_FILE_BYTES),
            )
            .unwrap();
        }
        let files = collect_reference_files(&request(&[root.path()], "txt")).unwrap();
        assert!(!files.is_empty());
        assert!(files.len() <= MAX_FILES);
        assert!(files.iter().map(|file| file.content.len()).sum::<usize>() <= MAX_TOTAL_BYTES);
        assert!(
            files
                .iter()
                .all(|file| file.content.chars().all(|c| c == '中'))
        );
        for index in 0..12 {
            fs::write(root.path().join(format!("{index:02}.txt")), "small").unwrap();
        }
        assert_eq!(
            collect_reference_files(&request(&[root.path()], "txt"))
                .unwrap()
                .len(),
            MAX_FILES
        );
    }

    #[test]
    fn reads_bom_text_and_skips_invalid_encoding() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("text.txt");
        for bom in [[0xff, 0xfe], [0xfe, 0xff]] {
            let mut bytes = bom.to_vec();
            for unit in "中文内容".encode_utf16() {
                bytes.extend(if bom[0] == 0xff {
                    unit.to_le_bytes()
                } else {
                    unit.to_be_bytes()
                });
            }
            fs::write(&file, bytes).unwrap();
            assert_eq!(
                read_text_excerpt(&file)
                    .map(|excerpt| excerpt.content)
                    .as_deref(),
                Some("中文内容")
            );
        }
        fs::write(&file, b"\xef\xbb\xbfUTF-8").unwrap();
        assert_eq!(
            read_text_excerpt(&file)
                .map(|excerpt| excerpt.content)
                .as_deref(),
            Some("UTF-8")
        );
        fs::write(&file, [0xff, 0x00, 0xab]).unwrap();
        assert!(read_text_excerpt(&file).is_none());
    }

    #[test]
    fn preview_matches_ai_reference_content_and_reports_paths_and_truncation() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("a.md"), "# 项目说明").unwrap();
        fs::write(root.path().join("b.md"), "x".repeat(MAX_FILE_BYTES + 1)).unwrap();
        let input = request(&[root.path()], "md");
        let preview = preview_archive_name_reference(&input).unwrap();
        let references = collect_reference_files(&input).unwrap();
        assert_eq!(preview.len(), references.len());
        assert!(!preview[0].truncated);
        assert!(preview[1].truncated);
        for (file, reference) in preview.iter().zip(&references) {
            assert!(Path::new(&file.source_path).is_file());
            assert_eq!(file.reference.file_name, reference.file_name);
            assert_eq!(file.reference.content, reference.content);
        }
        let reference_json = serde_json::to_value(&references).unwrap();
        assert!(reference_json[0].get("sourcePath").is_none());
        assert!(reference_json[0].get("truncated").is_none());
        let preview_json = serde_json::to_value(&preview).unwrap();
        assert_eq!(preview_json[0]["content"], "# 项目说明");
        assert!(preview_json[0].get("sourcePath").is_some());
        let single_file = root.path().join("a.md");
        let single = preview_archive_name_reference(&request(&[&single_file], "md")).unwrap();
        assert_eq!(single.len(), 1);
        assert_eq!(single[0].reference.content, "# 项目说明");
    }

    #[test]
    fn reads_only_selected_paths_within_sources_and_keeps_deselected_files_in_preview() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let nested = root.path().join("nested");
        fs::create_dir(&nested).unwrap();
        let first = root.path().join("README.md");
        let second = nested.join("README.md");
        let private = outside.path().join("private.md");
        fs::write(&first, "不应发送").unwrap();
        fs::write(&second, "勾选的内容").unwrap();
        fs::write(&private, "来源以外的内容").unwrap();
        let mut input = request(&[root.path()], "md");
        input.selected_paths = Some(vec![
            second.to_string_lossy().into(),
            private.to_string_lossy().into(),
            root.path().join("missing.md").to_string_lossy().into(),
        ]);
        assert_eq!(preview_archive_name_reference(&input).unwrap().len(), 2);
        fs::write(root.path().join("new.md"), "预览后新增的文件").unwrap();
        let files = collect_reference_files(&input).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].file_name, "README.md");
        assert_eq!(files[0].content, "勾选的内容");

        input.selected_paths = Some(Vec::new());
        assert!(collect_reference_files(&input).unwrap().is_empty());
        assert_eq!(preview_archive_name_reference(&input).unwrap().len(), 3);

        let legacy: AiNameReferenceRequest = serde_json::from_value(serde_json::json!({
            "sources": input.sources,
            "extensions": "md",
        }))
        .unwrap();
        assert!(legacy.selected_paths.is_none());
        assert_eq!(collect_reference_files(&legacy).unwrap().len(), 3);
    }

    #[test]
    fn deselected_files_do_not_use_up_the_content_budget() {
        let root = tempfile::tempdir().unwrap();
        for index in 0..12 {
            fs::write(
                root.path().join(format!("{index:02}.md")),
                "x".repeat(MAX_FILE_BYTES),
            )
            .unwrap();
        }
        let selected = root.path().join("z.md");
        fs::write(&selected, "勾选的内容").unwrap();
        let mut input = request(&[root.path()], "md");
        input.selected_paths = Some(vec![selected.to_string_lossy().into()]);
        let files = collect_reference_files(&input).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].content, "勾选的内容");
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_links_outside_sources() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("private.txt"), "outside").unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("linked")).unwrap();
        assert!(
            collect_reference_files(&request(&[root.path()], "txt"))
                .unwrap()
                .is_empty()
        );
    }
}
