//! Resolve ZIP disk sets before scanning individual parts for embedded signatures.
//! Disk fields and ZIP64 layout follow PKWARE APPNOTE sections 4.3.14–16 and 8.
use std::collections::BTreeMap;

use super::*;

const END_SIZE: usize = 22;
const END_SEARCH_SIZE: u64 = END_SIZE as u64 + u16::MAX as u64 + 20;

pub(super) struct ZipVolumes {
    pub primary: PathBuf,
    pub paths: Vec<PathBuf>,
}

struct EndRecord {
    bytes: Vec<u8>,
    offset: u64,
    locator: Option<[u8; 20]>,
}

impl EndRecord {
    fn is_single_disk(&self) -> bool {
        if let Some(locator) = self.locator {
            u32_at(&locator, 16) == 1
                && [4, 6]
                    .iter()
                    .all(|&at| [0, u16::MAX].contains(&u16_at(&self.bytes, at)))
        } else {
            u16_at(&self.bytes, 4) == 0 && u16_at(&self.bytes, 6) == 0
        }
    }
}

fn invalid(message: impl Into<String>) -> RecoveryError {
    RecoveryError::InvalidArchive(format!("ZIP 分卷：{}", message.into()))
}

fn u16_at(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes(bytes[offset..offset + 2].try_into().unwrap())
}

fn u32_at(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

fn u64_at(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap())
}

fn read_end(path: &Path) -> Result<Option<EndRecord>, RecoveryError> {
    let mut file = fs::File::open(path)?;
    let size = file.metadata()?.len();
    let start = size.saturating_sub(END_SEARCH_SIZE);
    file.seek(SeekFrom::Start(start))?;
    let mut tail = Vec::new();
    file.take(END_SEARCH_SIZE).read_to_end(&mut tail)?;
    Ok(find_end(&tail, start))
}

fn find_end(tail: &[u8], start: u64) -> Option<EndRecord> {
    if tail.len() < END_SIZE {
        return None;
    }
    // Match the comment length, not just four magic bytes inside a comment.
    for index in (0..=tail.len() - END_SIZE).rev() {
        if tail[index..].starts_with(b"PK\x05\x06")
            && index + END_SIZE + usize::from(u16_at(tail, index + 20)) == tail.len()
        {
            let locator = index.checked_sub(20).and_then(|at| {
                tail[at..]
                    .starts_with(b"PK\x06\x07")
                    .then(|| tail[at..index].try_into().unwrap())
            });
            return Some(EndRecord {
                bytes: tail[index..index + END_SIZE].to_vec(),
                offset: start + index as u64,
                locator,
            });
        }
    }
    None
}

fn zip_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|s| s.to_str())
        .is_some_and(|s| s.eq_ignore_ascii_case("zip") || s.eq_ignore_ascii_case("zipx"))
}

fn part_number(extension: &str, numbered: bool) -> Option<u32> {
    let digits = if numbered {
        extension
    } else {
        if !extension.get(..1)?.eq_ignore_ascii_case("z") {
            return None;
        }
        &extension[1..]
    };
    if digits.len() < 2 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse::<u32>().ok().filter(|n| *n > 0)
}

pub(super) fn resolve(path: &Path) -> Result<Option<ZipVolumes>, RecoveryError> {
    let Some(extension) = path.extension().and_then(|s| s.to_str()) else {
        return Ok(None);
    };
    let base = path.with_extension("");
    let numbered = part_number(extension, true).is_some() && zip_extension(&base);
    if !numbered && !zip_extension(path) && part_number(extension, false).is_none() {
        return Ok(None);
    }
    // A misleading ZIP suffix must not override another format's actual header.
    let mut prefix = [0; HEADER_PROBE_LIMIT];
    let length = fs::File::open(path)?.read(&mut prefix)?;
    let prefix = &prefix[..length];
    let other_format = prefix.starts_with(LZ4_FRAME_SIGNATURE)
        || detect_format_at_offset(prefix).is_some_and(|format| format != ArchiveFormat::Zip);
    if numbered && part_number(extension, true) == Some(1) && other_format {
        return Ok(None);
    }
    // A standalone ZIP wins over stale, similarly named .zNN files.
    let selected_end = if zip_extension(path) {
        read_end(path)?
    } else {
        None
    };
    if selected_end.as_ref().is_some_and(EndRecord::is_single_disk) {
        return Ok(None);
    }
    let mut parts = BTreeMap::new();
    let mut tail = None;
    let stem = base.file_name().and_then(|s| s.to_str()).unwrap_or("");
    for entry in fs::read_dir(path.parent().unwrap_or_else(|| Path::new(".")))? {
        let entry = entry?;
        let candidate = entry.path();
        if !entry.file_type()?.is_file()
            || !candidate
                .file_stem()
                .and_then(|s| s.to_str())
                .is_some_and(|s| s.eq_ignore_ascii_case(stem))
        {
            continue;
        }
        let Some(ext) = candidate.extension().and_then(|s| s.to_str()) else {
            continue;
        };
        if !numbered && zip_extension(&candidate) {
            if tail.replace(candidate).is_some() {
                return Err(invalid("存在多个同名尾卷，无法确定分卷组。"));
            }
        } else if let Some(number) = part_number(ext, numbered)
            && parts.insert(number, candidate).is_some()
        {
            return Err(invalid(format!("卷号 {number} 重复，无法确定分卷顺序。")));
        }
    }
    if other_format
        && !numbered
        && (tail.is_none() || (zip_extension(path) && selected_end.is_none()))
    {
        return Ok(None);
    }
    // Preserve content-based recognition of a standalone ZIP renamed to .zNN.
    if !numbered
        && tail.is_none()
        && (prefix.starts_with(b"PK\x03\x04")
            || prefix.starts_with(b"PK\x05\x06")
            || prefix.starts_with(b"PK\x07\x08"))
        && read_end(path)?
            .as_ref()
            .is_some_and(EndRecord::is_single_disk)
    {
        return Ok(None);
    }
    if !numbered && parts.is_empty() && selected_end.is_none() && zip_extension(path) {
        return Ok(None);
    }
    let tail = if numbered {
        parts
            .last_key_value()
            .map(|(_, path)| path.clone())
            .ok_or_else(|| invalid("缺少尾卷。"))?
    } else {
        tail.ok_or_else(|| invalid(format!("缺少 {stem}.zip 尾卷。")))?
    };
    let mut paths = Vec::new();
    for (index, (number, part)) in parts.iter().enumerate() {
        let expected = index as u32 + 1;
        if *number != expected {
            return Err(invalid(format!(
                "缺少卷号 {expected}（{}）。",
                if numbered {
                    format!("{stem}.{expected:03}")
                } else {
                    format!("{stem}.z{expected:02}")
                }
            )));
        }
        paths.push(part.canonicalize()?);
    }
    if !numbered {
        paths.push(tail.canonicalize()?);
    }
    let disks = Disks::new(&paths)?;
    // Byte-split ZIPs may split the EOCD or ZIP64 locator across files.
    let end = if numbered {
        let total = *disks.starts.last().unwrap();
        let start = total.saturating_sub(END_SEARCH_SIZE);
        let mut bytes = vec![0; (total - start) as usize];
        disks.read_into(start, &mut bytes)?;
        find_end(&bytes, start)
    } else {
        read_end(&tail)?
    };
    let end = end.ok_or_else(|| invalid("尾卷缺少完整的 ZIP 结束目录；尾卷缺失或已截断。"))?;
    let last_disk = end.locator.as_ref().map_or_else(
        || Ok(u32::from(u16_at(&end.bytes, 4))),
        |locator| {
            u32_at(locator, 16)
                .checked_sub(1)
                .ok_or_else(|| invalid("ZIP64 总卷数无效。"))
        },
    )?;
    if numbered && last_disk != 0 {
        return Err(invalid(
            "数字后缀分卷的目录包含磁盘卷号，不能按连续字节分卷读取。",
        ));
    }
    if !numbered {
        if last_disk == 0 {
            return Err(invalid("尾卷是独立 ZIP，与所选分卷不属于同一组。"));
        }
        if parts.len() < last_disk as usize {
            return Err(invalid(format!(
                "缺少卷号 {}（{stem}.z{:02}）。",
                parts.len() + 1,
                parts.len() + 1
            )));
        }
        if parts.len() != last_disk as usize {
            return Err(invalid("文件数量与尾卷声明的总卷数不一致。"));
        }
    }
    validate_directory(&disks, &end, numbered, last_disk)?;
    let primary = if numbered {
        paths[0].clone()
    } else {
        paths.last().unwrap().clone()
    };
    Ok(Some(ZipVolumes { primary, paths }))
}

struct Disks<'a> {
    paths: &'a [PathBuf],
    starts: Vec<u64>,
}

impl<'a> Disks<'a> {
    fn new(paths: &'a [PathBuf]) -> Result<Self, RecoveryError> {
        let mut starts = vec![0u64];
        for path in paths {
            let length = path.metadata()?.len();
            if length == 0 {
                return Err(invalid(format!("分卷为空：{}", path_for_display(path))));
            }
            starts.push(
                starts
                    .last()
                    .unwrap()
                    .checked_add(length)
                    .ok_or_else(|| invalid("总大小溢出。"))?,
            );
        }
        Ok(Self { paths, starts })
    }

    fn position(&self, disk: u32, offset: u64, numbered: bool) -> Result<u64, RecoveryError> {
        if numbered {
            if disk == 0 && offset <= *self.starts.last().unwrap() {
                return Ok(offset);
            }
        } else if let Some(bounds) = self.starts.get(disk as usize..disk as usize + 2)
            && offset <= bounds[1] - bounds[0]
        {
            return Ok(bounds[0] + offset);
        }
        Err(invalid("目录卷号或偏移超出分卷范围。"))
    }

    fn read<const N: usize>(&self, position: u64) -> Result<[u8; N], RecoveryError> {
        let mut bytes = [0; N];
        self.read_into(position, &mut bytes)?;
        Ok(bytes)
    }

    fn read_into(&self, mut position: u64, bytes: &mut [u8]) -> Result<(), RecoveryError> {
        let mut written = 0;
        for (index, path) in self.paths.iter().enumerate() {
            if position >= self.starts[index + 1] {
                continue;
            }
            let mut file = fs::File::open(path)?;
            file.seek(SeekFrom::Start(position - self.starts[index]))?;
            let count =
                (self.starts[index + 1] - position).min((bytes.len() - written) as u64) as usize;
            file.read_exact(&mut bytes[written..written + count])?;
            written += count;
            position += count as u64;
            if written == bytes.len() {
                return Ok(());
            }
        }
        Err(invalid("目录数据已截断。"))
    }
}

fn validate_directory(
    disks: &Disks<'_>,
    end: &EndRecord,
    numbered: bool,
    last_disk: u32,
) -> Result<(), RecoveryError> {
    let end_position = if numbered {
        end.offset
    } else {
        disks.starts[disks.paths.len() - 1] + end.offset
    };
    let (central_disk, central_offset, central_size, entries, boundary) =
        if let Some(locator) = end.locator {
            let record_disk = u32_at(&locator, 4);
            let record_position = disks.position(record_disk, u64_at(&locator, 8), numbered)?;
            let record = disks.read::<56>(record_position)?;
            let record_size = u64_at(&record, 4);
            if !record.starts_with(b"PK\x06\x06")
                || record_size < 44
                || record_position
                    .checked_add(12)
                    .and_then(|n| n.checked_add(record_size))
                    != end_position.checked_sub(20)
                || u32_at(&record, 16) != record_disk
                || record_disk > last_disk
                || u64_at(&record, 24) > u64_at(&record, 32)
            {
                return Err(invalid("ZIP64 结束目录或定位记录无效。"));
            }
            let classic_disk = u16_at(&end.bytes, 4);
            if classic_disk != u16::MAX && u32::from(classic_disk) != last_disk {
                return Err(invalid("ZIP64 与 ZIP 目录的卷数不一致。"));
            }
            (
                u32_at(&record, 20),
                u64_at(&record, 48),
                u64_at(&record, 40),
                u64_at(&record, 32),
                record_position,
            )
        } else {
            if [4, 6, 8, 10]
                .iter()
                .any(|&at| u16_at(&end.bytes, at) == u16::MAX)
                || [12, 16]
                    .iter()
                    .any(|&at| u32_at(&end.bytes, at) == u32::MAX)
            {
                return Err(invalid("缺少 ZIP64 目录定位记录。"));
            }
            if u16_at(&end.bytes, 8) > u16_at(&end.bytes, 10) {
                return Err(invalid("目录条目数量无效。"));
            }
            (
                u32::from(u16_at(&end.bytes, 6)),
                u64::from(u32_at(&end.bytes, 16)),
                u64::from(u32_at(&end.bytes, 12)),
                u64::from(u16_at(&end.bytes, 10)),
                end_position,
            )
        };
    let central_position = disks.position(central_disk, central_offset, numbered)?;
    if central_position
        .checked_add(central_size)
        .is_none_or(|n| n > boundary)
        || (entries > 0 && central_size < 46)
    {
        return Err(invalid("中央目录大小超出分卷范围或已截断。"));
    }
    if entries > 0 && disks.read::<4>(central_position)? != *b"PK\x01\x02" {
        return Err(invalid("中央目录标识无效，分卷内容不匹配或目录已加密。"));
    }
    let prefix = disks.read::<4>(0)?;
    if ![
        *b"PK\x03\x04",
        *b"PK\x07\x08",
        *b"PK\x30\x30",
        *b"PK\x05\x06",
    ]
    .contains(&prefix)
        && !prefix.starts_with(b"MZ")
    {
        return Err(invalid("首卷缺少 ZIP 文件头，分卷内容不匹配。"));
    }
    Ok(())
}
