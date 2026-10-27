use serde::Serialize;
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
};
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeDiagnostics {
    pub existing: Vec<String>,
    pub missing: Vec<String>,
    pub warnings: Vec<String>,
    pub primary_path: String,
    pub analysis_error: Option<String>,
    pub recognizable: bool,
}
#[derive(Clone, Debug, PartialEq)]
enum Kind {
    Numeric,
    Zip,
    RarPart,
    RarOld,
}
#[derive(Clone, Debug)]
struct Pattern {
    stem: String,
    kind: Kind,
    width: usize,
    index: u32,
}
fn pattern(name: &str) -> Option<Pattern> {
    let lower = name.to_lowercase();
    let (stem, ext) = lower.rsplit_once('.')?;
    if ext.len() >= 3 && ext.bytes().all(|b| b.is_ascii_digit()) {
        return Some(Pattern {
            stem: stem.into(),
            kind: Kind::Numeric,
            width: ext.len(),
            index: ext.parse().ok()?,
        });
    }
    if ext.starts_with('z') && ext.len() >= 3 && ext[1..].bytes().all(|b| b.is_ascii_digit()) {
        return Some(Pattern {
            stem: stem.into(),
            kind: Kind::Zip,
            width: ext.len() - 1,
            index: ext[1..].parse().ok()?,
        });
    }
    if ext == "zip" {
        return Some(Pattern {
            stem: stem.into(),
            kind: Kind::Zip,
            width: 2,
            index: 0,
        });
    }
    if ext == "rar" {
        if let Some((base, part)) = stem.rsplit_once(".part")
            && !part.is_empty()
            && part.bytes().all(|b| b.is_ascii_digit())
        {
            return Some(Pattern {
                stem: base.into(),
                kind: Kind::RarPart,
                width: part.len(),
                index: part.parse().ok()?,
            });
        }
        return Some(Pattern {
            stem: stem.into(),
            kind: Kind::RarOld,
            width: 2,
            index: 0,
        });
    }
    if ext.len() == 3 && ext.starts_with('r') && ext[1..].bytes().all(|b| b.is_ascii_digit()) {
        return Some(Pattern {
            stem: stem.into(),
            kind: Kind::RarOld,
            width: 2,
            index: ext[1..].parse::<u32>().ok()? + 1,
        });
    }
    None
}
fn filename(p: &Pattern, index: u32) -> String {
    match p.kind {
        Kind::Numeric => format!("{}.{:0width$}", p.stem, index, width = p.width),
        Kind::Zip if index == 0 => format!("{}.zip", p.stem),
        Kind::Zip => format!("{}.z{:0width$}", p.stem, index, width = p.width),
        Kind::RarPart => format!("{}.part{:0width$}.rar", p.stem, index, width = p.width),
        Kind::RarOld if index == 0 => format!("{}.rar", p.stem),
        Kind::RarOld => format!("{}.r{:02}", p.stem, index - 1),
    }
}
pub fn diagnose_volumes(path: &Path) -> Result<VolumeDiagnostics, String> {
    let parent = path.parent().ok_or("无法定位归档目录")?;
    let mut result = VolumeDiagnostics {
        existing: vec![],
        missing: vec![],
        warnings: vec![],
        primary_path: super::path_for_display(path),
        analysis_error: None,
        recognizable: false,
    };
    let Some(p) = path.file_name().and_then(|s| s.to_str()).and_then(pattern) else {
        result
            .warnings
            .push("未识别到常规分卷命名；仍会按文件内容检查归档。".into());
        if path.is_file() {
            result.existing.push(super::path_for_display(path));
        }
        apply_analysis(&mut result);
        return Ok(result);
    };
    let mut found: BTreeMap<u32, PathBuf> = BTreeMap::new();
    for (position, entry) in fs::read_dir(parent).map_err(|e| e.to_string())?.enumerate() {
        if position >= 20_000 {
            result
                .warnings
                .push("目录扫描达到 20000 项上限，诊断仅包含部分文件。".into());
            break;
        }
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_file() {
            continue;
        }
        let Some(candidate) = entry.file_name().to_str().and_then(pattern) else {
            continue;
        };
        if candidate.stem != p.stem || candidate.kind != p.kind {
            continue;
        }
        if candidate.index > 10_000 {
            result
                .warnings
                .push("卷号超过 10000，未纳入连续性判断。".into());
            continue;
        }
        if candidate.width != p.width && candidate.index != 0 {
            result.warnings.push(format!(
                "卷号位数不一致：{}",
                entry.file_name().to_string_lossy()
            ));
        }
        if found.insert(candidate.index, entry.path()).is_some() {
            result
                .warnings
                .push(format!("重复卷号：{}", candidate.index));
        }
    }
    let first = if matches!(p.kind, Kind::Zip | Kind::RarOld) {
        0
    } else {
        1
    };
    let primary = found
        .get(&first)
        .cloned()
        .unwrap_or_else(|| parent.join(filename(&p, first)));
    result.primary_path = super::path_for_display(&primary);
    let last = found.keys().last().copied().unwrap_or(first);
    // 7z's start header declares the archive's end; use only a valid header CRC.
    if p.kind == Kind::Numeric
        && let Ok(mut file) = fs::File::open(&primary)
    {
        let mut header = [0u8; 32];
        if file.read_exact(&mut header).is_ok()
            && &header[..6] == b"7z\xbc\xaf\x27\x1c"
            && crc32fast::hash(&header[12..])
                == u32::from_le_bytes(header[8..12].try_into().unwrap())
        {
            let offset = u64::from_le_bytes(header[12..20].try_into().unwrap());
            let size = u64::from_le_bytes(header[20..28].try_into().unwrap());
            let found_bytes = found
                .values()
                .try_fold(0u64, |sum, path| {
                    fs::metadata(path).map(|meta| sum.saturating_add(meta.len()))
                })
                .map_err(|e| e.to_string())?;
            if let Some(end) = offset.checked_add(size).and_then(|n| n.checked_add(32))
                && found_bytes < end
            {
                result.warnings.push("已找到的卷总字节数小于归档头声明大小，可能缺少尾卷或文件被截断；无法确定尾卷编号。".into());
            }
        }
    }
    for index in first..=last {
        if !found.contains_key(&index) {
            result.missing.push(filename(&p, index));
        }
    }
    result.existing = found.values().map(|p| super::path_for_display(p)).collect();
    if matches!(p.kind, Kind::RarOld | Kind::RarPart) {
        result
            .warnings
            .push("RAR 多分卷支持尚不完整；连续卷号不能证明末卷齐全。".into());
    }
    result
        .warnings
        .push("文件名与归档头诊断不替代完整性检查；补齐卷后请重新检测。".into());
    apply_analysis(&mut result);
    Ok(result)
}
fn apply_analysis(result: &mut VolumeDiagnostics) {
    match super::analyze_archive(&result.primary_path) {
        Ok(analysis) => {
            result.recognizable = result.missing.is_empty();
            result.primary_path = analysis.archive_path;
        }
        Err(e) => result.analysis_error = Some(e.to_string()),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn diagnoses_gaps_from_non_first_volume_without_requiring_valid_content() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("[测试分组] 中文目录");
        fs::create_dir(&folder).unwrap();
        fs::write(folder.join("嵌套归档.7z.001"), b"invalid").unwrap();
        fs::write(folder.join("嵌套归档.7z.003"), b"invalid").unwrap();
        let result = diagnose_volumes(&folder.join("嵌套归档.7z.003")).unwrap();
        assert_eq!(result.missing, vec!["嵌套归档.7z.002"]);
        assert_eq!(result.existing.len(), 2);
        assert!(!result.recognizable);
    }
    #[test]
    fn zip_requires_terminal_archive_and_keeps_other_groups_separate() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["资料.z01", "资料.z03", "其他.zip"] {
            fs::write(dir.path().join(name), b"invalid").unwrap();
        }
        let result = diagnose_volumes(&dir.path().join("资料.z01")).unwrap();
        assert_eq!(result.missing, vec!["资料.zip", "资料.z02"]);
    }
}
