use std::fs;
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use lz4::Decoder as Lz4Decoder;
use sha2::{Digest, Sha256};

use super::super::runner::CancellationToken;
use super::{ArchiveAnalysis, ArchiveFormat, RecoveryError, ensure_not_cancelled};

pub(super) const SEVEN_ZIP_SIGNATURE: &[u8] = b"\x37\x7a\xbc\xaf\x27\x1c";
const RAR3_SIGNATURE: &[u8] = b"Rar!\x1a\x07\x00";
pub(super) const RAR5_SIGNATURE: &[u8] = b"Rar!\x1a\x07\x01\x00";
pub(super) const ZIP_SIGNATURES: [&[u8]; 3] = [b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08"];
const LZ4_FRAME_SIGNATURE: &[u8] = b"\x04\x22\x4d\x18";
const SIGNATURE_SCAN_LIMIT: u64 = 4 * 1024 * 1024;
const HEADER_PROBE_LIMIT: usize = 16;
const DOS_HEADER_PROBE_LIMIT: usize = 64;
const PE_SECTION_HEADER_SIZE: u64 = 40;
const PE_MAX_SECTION_COUNT: u16 = 96;
const LZ4_COPY_BUFFER_SIZE: usize = 256 * 1024;
pub(super) const MAX_LZ4_DECODED_BYTES: u64 = 100 * 1024 * 1024 * 1024;
const MAX_LZ4_EXPANSION_RATIO: u64 = 10_000;
const FINGERPRINT_READ_BUFFER_SIZE: usize = 1024 * 1024;
const SEVEN_ZIP_START_HEADER_SIZE: usize = 32;
const CRC_READ_BUFFER_SIZE: usize = 64 * 1024;
const SPLIT_COPY_BUFFER_SIZE: usize = 1024 * 1024;

pub fn analyze_archive(path: impl AsRef<Path>) -> Result<ArchiveAnalysis, RecoveryError> {
    let path = path.as_ref();
    if !path.is_file() {
        return Err(RecoveryError::NotFound(path_for_display(path)));
    }
    let absolute = path.canonicalize()?;
    let format = detect_archive_format(&absolute)?;
    let volume_paths = resolve_archive_volumes(&absolute, format)?;
    let file_size = volume_paths.iter().try_fold(0u64, |total, volume| {
        total
            .checked_add(volume.metadata()?.len())
            .ok_or_else(|| RecoveryError::Message("归档分卷总大小超出支持范围。".into()))
    })?;
    let file_name = absolute
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("archive")
        .to_owned();
    let output_name = absolute
        .file_stem()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("archive");
    let suggested_output_directory = absolute
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(output_name);

    Ok(ArchiveAnalysis {
        archive_path: path_for_display(&absolute),
        file_name,
        format,
        format_label: format.label().into(),
        file_size,
        volume_count: volume_paths.len() as u32,
        volume_paths,
        suggested_output_directory: path_for_display(&suggested_output_directory),
    })
}

pub fn fingerprint_file_sha256(path: impl AsRef<Path>) -> Result<String, RecoveryError> {
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; FINGERPRINT_READ_BUFFER_SIZE];
    update_sha256_from_file(&mut hasher, path.as_ref(), &mut buffer, None)?;
    Ok(hex::encode(hasher.finalize()))
}

pub fn fingerprint_archive_sha256(analysis: &ArchiveAnalysis) -> Result<String, RecoveryError> {
    fingerprint_archive_sha256_inner(analysis, None)
}

pub fn fingerprint_archive_sha256_with_cancellation(
    analysis: &ArchiveAnalysis,
    cancellation: &CancellationToken,
) -> Result<String, RecoveryError> {
    fingerprint_archive_sha256_inner(analysis, Some(cancellation))
}

fn fingerprint_archive_sha256_inner(
    analysis: &ArchiveAnalysis,
    cancellation: Option<&CancellationToken>,
) -> Result<String, RecoveryError> {
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; FINGERPRINT_READ_BUFFER_SIZE];
    for volume in &analysis.volume_paths {
        update_sha256_from_file(&mut hasher, volume, &mut buffer, cancellation)?;
    }
    Ok(hex::encode(hasher.finalize()))
}

fn update_sha256_from_file(
    hasher: &mut Sha256,
    path: &Path,
    buffer: &mut [u8],
    cancellation: Option<&CancellationToken>,
) -> Result<(), RecoveryError> {
    let file = fs::File::open(path)?;
    let mut reader = BufReader::with_capacity(FINGERPRINT_READ_BUFFER_SIZE, file);
    update_sha256_from_reader(hasher, &mut reader, buffer, cancellation)
}

fn update_sha256_from_reader(
    hasher: &mut Sha256,
    reader: &mut impl Read,
    buffer: &mut [u8],
    cancellation: Option<&CancellationToken>,
) -> Result<(), RecoveryError> {
    loop {
        if let Some(cancellation) = cancellation {
            ensure_not_cancelled(cancellation)?;
        }
        let count = reader.read(buffer)?;
        if count == 0 {
            return Ok(());
        }
        hasher.update(&buffer[..count]);
    }
}

fn resolve_archive_volumes(
    archive_path: &Path,
    format: ArchiveFormat,
) -> Result<Vec<PathBuf>, RecoveryError> {
    if format != ArchiveFormat::SevenZip {
        return Ok(vec![archive_path.to_path_buf()]);
    }

    let Some(header) = read_seven_zip_start_header(archive_path)? else {
        return Ok(vec![archive_path.to_path_buf()]);
    };
    let first_size = archive_path.metadata()?.len();
    let declared_end = (SEVEN_ZIP_START_HEADER_SIZE as u64)
        .checked_add(header.next_header_offset)
        .and_then(|offset| offset.checked_add(header.next_header_size))
        .ok_or_else(|| RecoveryError::Message("7z 起始头声明的归档大小无效。".into()))?;
    if declared_end <= first_size {
        return Ok(vec![archive_path.to_path_buf()]);
    }

    let volumes =
        resolve_split_volumes_by_content(archive_path, first_size, declared_end, &header)?;
    validate_seven_zip_next_header_crc(&volumes, &header)?;
    Ok(volumes)
}

fn resolve_split_volumes_by_content(
    first_volume: &Path,
    first_size: u64,
    declared_end: u64,
    header: &SevenZipStartHeader,
) -> Result<Vec<PathBuf>, RecoveryError> {
    let numbered_failure =
        match resolve_numbered_split_volumes(first_volume, first_size, declared_end) {
            Ok(Some(volumes)) => return Ok(volumes),
            Ok(None) => None,
            Err(error) => Some(error.to_string()),
        };
    let missing_size = declared_end - first_size;
    let exact_tail_candidates = find_tail_candidates(first_volume, missing_size, header)?;
    match exact_tail_candidates.len() {
        1 => {
            return Ok(vec![
                first_volume.to_path_buf(),
                exact_tail_candidates.into_iter().next().unwrap(),
            ]);
        }
        count if count > 1 => {
            if let Some(message) = &numbered_failure {
                return Err(RecoveryError::Message(message.clone()));
            }
            return Err(RecoveryError::Message(format!(
                "检测到 {count} 个长度和末端头 CRC 都匹配的匿名尾卷，无法安全确定分卷组合。"
            )));
        }
        _ => {}
    }

    let full_part_count = missing_size / first_size;
    let remainder = missing_size % first_size;
    let additional_count = full_part_count.saturating_add(u64::from(remainder > 0));
    let last_size = if remainder == 0 {
        first_size
    } else {
        remainder
    };
    let middle_count = additional_count.saturating_sub(1);
    let middle_count = usize::try_from(middle_count)
        .map_err(|_| RecoveryError::Message("7z 分卷数量超出支持范围。".into()))?;

    if header.next_header_size == 0 || header.next_header_size > last_size {
        if let Some(message) = numbered_failure {
            return Err(RecoveryError::Message(message));
        }
        return Err(RecoveryError::Message(
            "匿名 7z 分卷的末端头跨越了多个文件，无法仅凭内容安全确定顺序；请保留或补充分卷序号。"
                .into(),
        ));
    }

    let mut last_candidates = find_tail_candidates(first_volume, last_size, header)?;
    let parent = first_volume.parent().unwrap_or_else(|| Path::new("."));
    let mut middle_candidates = Vec::new();
    for entry in fs::read_dir(parent)? {
        let entry = entry?;
        let candidate = entry.path();
        if candidate == first_volume || !entry.file_type()?.is_file() {
            continue;
        }
        let size = entry.metadata()?.len();
        if size == first_size {
            middle_candidates.push(candidate.canonicalize()?);
        }
    }

    if last_candidates.len() != 1 {
        if let Some(message) = numbered_failure {
            return Err(RecoveryError::Message(message));
        }
        return Err(RecoveryError::Message(match last_candidates.len() {
            0 => format!(
                "检测到 7z 数据尚缺少 {missing_size} 字节，但未找到通过末端头 CRC 校验的匿名尾卷。"
            ),
            count => {
                format!("检测到 {count} 个通过末端头 CRC 校验的匿名尾卷，无法安全确定分卷组合。")
            }
        }));
    }
    let last = last_candidates.remove(0);
    middle_candidates.retain(|candidate| candidate != &last);

    if middle_candidates.len() == middle_count && middle_count <= 1 {
        let mut volumes = Vec::with_capacity(additional_count as usize + 1);
        volumes.push(first_volume.to_path_buf());
        volumes.extend(middle_candidates);
        volumes.push(last);
        return Ok(volumes);
    }

    Err(RecoveryError::Message(format!(
        "已按内容识别出 7z 首卷和尾卷，但仍有 {middle_count} 个等长匿名中间卷；7z 中间数据块没有独立序号，无法安全判断它们的先后顺序。"
    )))
}

fn find_tail_candidates(
    first_volume: &Path,
    expected_size: u64,
    header: &SevenZipStartHeader,
) -> Result<Vec<PathBuf>, RecoveryError> {
    if header.next_header_size == 0 || header.next_header_size > expected_size {
        return Ok(Vec::new());
    }
    let parent = first_volume.parent().unwrap_or_else(|| Path::new("."));
    let mut candidates = Vec::new();
    for entry in fs::read_dir(parent)? {
        let entry = entry?;
        let candidate = entry.path();
        if candidate == first_volume
            || !entry.file_type()?.is_file()
            || entry.metadata()?.len() != expected_size
        {
            continue;
        }
        let next_header_offset = expected_size - header.next_header_size;
        let crc = !update_crc32_from_range(
            u32::MAX,
            &candidate,
            next_header_offset,
            header.next_header_size,
        )?;
        if crc == header.next_header_crc {
            candidates.push(candidate.canonicalize()?);
        }
    }
    Ok(candidates)
}

fn resolve_numbered_split_volumes(
    first_volume: &Path,
    first_size: u64,
    declared_end: u64,
) -> Result<Option<Vec<PathBuf>>, RecoveryError> {
    let Some(extension) = first_volume.extension().and_then(|value| value.to_str()) else {
        return Ok(None);
    };
    if extension.len() < 2
        || !extension.bytes().all(|byte| byte.is_ascii_digit())
        || extension.parse::<u64>().ok() != Some(1)
    {
        return Ok(None);
    }

    let width = extension.len();
    let mut volumes = vec![first_volume.to_path_buf()];
    let mut total_size = first_size;
    let mut index = 2u64;
    while total_size < declared_end {
        let next_extension = format!("{index:0width$}");
        if next_extension.len() > width {
            return Err(RecoveryError::Message(format!(
                "标准 7z 分卷数量超过 .{extension} 编号可表示的范围。"
            )));
        }
        let next_volume = first_volume.with_extension(&next_extension);
        if !next_volume.is_file() {
            return Err(RecoveryError::Message(format!(
                "标准 7z 分卷不完整：缺少 {}。",
                path_for_display(&next_volume)
            )));
        }
        let next_size = next_volume.metadata()?.len();
        total_size = total_size
            .checked_add(next_size)
            .ok_or_else(|| RecoveryError::Message("7z 分卷总大小超出支持范围。".into()))?;
        if total_size > declared_end {
            return Err(RecoveryError::Message(format!(
                "标准 7z 分卷 {} 超出了起始头声明的归档总大小。",
                path_for_display(&next_volume)
            )));
        }
        volumes.push(next_volume.canonicalize()?);
        index = index.saturating_add(1);
    }
    Ok(Some(volumes))
}

#[derive(Debug, Clone, Copy)]
struct SevenZipStartHeader {
    next_header_offset: u64,
    next_header_size: u64,
    next_header_crc: u32,
}

fn read_seven_zip_start_header(
    archive_path: &Path,
) -> Result<Option<SevenZipStartHeader>, RecoveryError> {
    let mut file = fs::File::open(archive_path)?;
    let mut bytes = [0u8; SEVEN_ZIP_START_HEADER_SIZE];
    match file.read_exact(&mut bytes) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error.into()),
    }
    if !bytes.starts_with(SEVEN_ZIP_SIGNATURE) {
        return Ok(None);
    }
    let stored_start_crc = u32::from_le_bytes(bytes[8..12].try_into().unwrap());
    if crc32(&bytes[12..32]) != stored_start_crc {
        return Ok(None);
    }
    Ok(Some(SevenZipStartHeader {
        next_header_offset: u64::from_le_bytes(bytes[12..20].try_into().unwrap()),
        next_header_size: u64::from_le_bytes(bytes[20..28].try_into().unwrap()),
        next_header_crc: u32::from_le_bytes(bytes[28..32].try_into().unwrap()),
    }))
}

fn validate_seven_zip_next_header_crc(
    volumes: &[PathBuf],
    header: &SevenZipStartHeader,
) -> Result<(), RecoveryError> {
    if seven_zip_next_header_crc(volumes, header)? != header.next_header_crc {
        return Err(RecoveryError::Message(
            "7z 分卷末端头 CRC 校验失败，分卷顺序错误或内容已损坏。".into(),
        ));
    }
    Ok(())
}

fn seven_zip_next_header_crc(
    volumes: &[PathBuf],
    header: &SevenZipStartHeader,
) -> Result<u32, RecoveryError> {
    let mut cursor = (SEVEN_ZIP_START_HEADER_SIZE as u64)
        .checked_add(header.next_header_offset)
        .ok_or_else(|| RecoveryError::Message("7z 下一头偏移无效。".into()))?;
    let mut remaining = header.next_header_size;
    let mut crc = u32::MAX;
    let mut volume_start = 0u64;
    for volume in volumes {
        let volume_size = volume.metadata()?.len();
        let volume_end = volume_start
            .checked_add(volume_size)
            .ok_or_else(|| RecoveryError::Message("7z 分卷偏移超出支持范围。".into()))?;
        if remaining == 0 {
            break;
        }
        if cursor < volume_end {
            if cursor < volume_start {
                return Err(RecoveryError::Message("7z 分卷之间存在数据缺口。".into()));
            }
            let offset = cursor - volume_start;
            let length = remaining.min(volume_end - cursor);
            crc = update_crc32_from_range(crc, volume, offset, length)?;
            cursor += length;
            remaining -= length;
        }
        volume_start = volume_end;
    }
    if remaining != 0 {
        return Err(RecoveryError::Message(
            "7z 分卷不足以读取完整的末端头。".into(),
        ));
    }
    Ok(!crc)
}

fn update_crc32_from_range(
    mut crc: u32,
    path: &Path,
    offset: u64,
    mut remaining: u64,
) -> Result<u32, RecoveryError> {
    let mut file = fs::File::open(path)?;
    file.seek(SeekFrom::Start(offset))?;
    let mut buffer = [0u8; CRC_READ_BUFFER_SIZE];
    while remaining > 0 {
        let wanted = remaining.min(buffer.len() as u64) as usize;
        file.read_exact(&mut buffer[..wanted])?;
        crc = update_crc32(crc, &buffer[..wanted]);
        remaining -= wanted as u64;
    }
    Ok(crc)
}

fn crc32(bytes: &[u8]) -> u32 {
    !update_crc32(u32::MAX, bytes)
}

fn update_crc32(mut crc: u32, bytes: &[u8]) -> u32 {
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            let mask = 0u32.wrapping_sub(crc & 1);
            crc = (crc >> 1) ^ (0xedb8_8320 & mask);
        }
    }
    crc
}

pub(super) struct SplitArchiveMaterialization {
    primary_path: PathBuf,
    volume_paths: Vec<PathBuf>,
    directory: PathBuf,
}

impl SplitArchiveMaterialization {
    pub(super) fn primary_path(&self) -> &Path {
        &self.primary_path
    }

    pub(super) fn volume_paths(&self) -> &[PathBuf] {
        &self.volume_paths
    }
}

impl Drop for SplitArchiveMaterialization {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}

pub(super) fn materialize_split_archive(
    analysis: &ArchiveAnalysis,
    work_directory: &Path,
    cancellation: &CancellationToken,
) -> Result<Option<SplitArchiveMaterialization>, RecoveryError> {
    if analysis.volume_paths.len() <= 1
        || is_standard_numbered_volume_sequence(&analysis.volume_paths)
    {
        return Ok(None);
    }
    ensure_not_cancelled(cancellation)?;
    let directory = work_directory.join("split-volumes");
    fs::create_dir(&directory)?;
    let volume_paths = analysis
        .volume_paths
        .iter()
        .enumerate()
        .map(|(index, _)| {
            directory.join(format!(
                "archive.{}.{:03}",
                analysis.format.extension(),
                index + 1
            ))
        })
        .collect::<Vec<_>>();
    let materialization = SplitArchiveMaterialization {
        primary_path: volume_paths[0].clone(),
        volume_paths,
        directory,
    };

    for (source, destination) in analysis
        .volume_paths
        .iter()
        .zip(&materialization.volume_paths)
    {
        ensure_not_cancelled(cancellation)?;
        materialize_volume(source, destination, cancellation)?;
    }
    Ok(Some(materialization))
}

fn is_standard_numbered_volume_sequence(volumes: &[PathBuf]) -> bool {
    let Some(first) = volumes.first() else {
        return false;
    };
    let Some(extension) = first.extension().and_then(|value| value.to_str()) else {
        return false;
    };
    if extension.len() < 2
        || !extension.bytes().all(|byte| byte.is_ascii_digit())
        || extension.parse::<u64>().ok() != Some(1)
    {
        return false;
    }
    let width = extension.len();
    volumes.iter().enumerate().all(|(index, volume)| {
        let expected_extension = format!("{:0width$}", index + 1);
        volume == &first.with_extension(expected_extension)
    })
}

fn materialize_volume(
    source: &Path,
    destination: &Path,
    cancellation: &CancellationToken,
) -> Result<(), RecoveryError> {
    materialize_volume_with(source, destination, cancellation, |source, destination| {
        fs::hard_link(source, destination)
    })
}

pub(super) fn materialize_volume_with(
    source: &Path,
    destination: &Path,
    cancellation: &CancellationToken,
    create_hard_link: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
) -> Result<(), RecoveryError> {
    ensure_not_cancelled(cancellation)?;
    if create_hard_link(source, destination).is_ok() {
        return Ok(());
    }

    let mut input = BufReader::with_capacity(SPLIT_COPY_BUFFER_SIZE, fs::File::open(source)?);
    let output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)?;
    let mut output = BufWriter::with_capacity(SPLIT_COPY_BUFFER_SIZE, output);
    let mut buffer = vec![0u8; SPLIT_COPY_BUFFER_SIZE];
    let result = (|| {
        loop {
            ensure_not_cancelled(cancellation)?;
            let count = input.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            output.write_all(&buffer[..count])?;
        }
        output.flush()?;
        Ok::<_, RecoveryError>(())
    })();
    if result.is_err() {
        drop(output);
        let _ = fs::remove_file(destination);
    }
    result
}

pub fn detect_archive_format(path: &Path) -> Result<ArchiveFormat, RecoveryError> {
    detect_archive_format_with_limit(path, |_| SIGNATURE_SCAN_LIMIT)
}

pub(super) fn detect_nested_archive_format(path: &Path) -> Result<ArchiveFormat, RecoveryError> {
    if !path.is_file() {
        return Err(RecoveryError::NotFound(path_for_display(path)));
    }
    let mut file = fs::File::open(path)?;
    let metadata = file.metadata()?;
    let mut prefix = [0u8; DOS_HEADER_PROBE_LIMIT];
    let prefix_length = file.read(&mut prefix)?;
    let prefix = &prefix[..prefix_length];

    if prefix.starts_with(LZ4_FRAME_SIGNATURE) {
        return detect_lz4_inner_format(path, file);
    }
    if let Some(format) = detect_format_at_offset(prefix) {
        return Ok(format);
    }

    let scan_start = if prefix.starts_with(b"MZ") {
        pe_overlay_offset(&mut file, metadata.len()).ok_or(RecoveryError::UnsupportedFormat)?
    } else if looks_like_embedded_archive_carrier(prefix) {
        0
    } else {
        return Err(RecoveryError::UnsupportedFormat);
    };
    if scan_start >= metadata.len() {
        return Err(RecoveryError::UnsupportedFormat);
    }

    file.seek(SeekFrom::Start(scan_start))?;
    let scan_length = metadata
        .len()
        .saturating_sub(scan_start)
        .min(SIGNATURE_SCAN_LIMIT) as usize;
    let mut buffer = Vec::with_capacity(scan_length);
    file.take(scan_length as u64).read_to_end(&mut buffer)?;
    detect_format_in_buffer(&buffer, false).ok_or(RecoveryError::UnsupportedFormat)
}

fn detect_archive_format_with_limit(
    path: &Path,
    scan_limit: impl FnOnce(&[u8]) -> u64,
) -> Result<ArchiveFormat, RecoveryError> {
    if !path.is_file() {
        return Err(RecoveryError::NotFound(path_for_display(path)));
    }
    let mut file = fs::File::open(path)?;
    let metadata = file.metadata()?;
    let mut prefix = [0u8; HEADER_PROBE_LIMIT];
    let prefix_length = file.read(&mut prefix)?;
    let prefix = &prefix[..prefix_length];
    let scan_limit = scan_limit(prefix);
    if prefix.starts_with(LZ4_FRAME_SIGNATURE) {
        return detect_lz4_inner_format(path, file);
    }
    if let Some(format) = detect_format_in_buffer(prefix, true) {
        return Ok(format);
    }
    let scan_limit = metadata.len().min(scan_limit) as usize;
    let mut buffer = Vec::with_capacity(scan_limit);
    buffer.extend_from_slice(prefix);
    file.take(scan_limit.saturating_sub(prefix_length) as u64)
        .read_to_end(&mut buffer)?;
    detect_format_in_buffer(&buffer, false).ok_or(RecoveryError::UnsupportedFormat)
}

fn detect_lz4_inner_format(
    path: &Path,
    mut file: fs::File,
) -> Result<ArchiveFormat, RecoveryError> {
    file.seek(SeekFrom::Start(0))?;
    let mut decoder =
        Lz4Decoder::new(BufReader::new(file)).map_err(|error| lz4_decode_error(path, error))?;
    let mut header = [0u8; HEADER_PROBE_LIMIT];
    let header_length = decoder
        .read(&mut header)
        .map_err(|error| lz4_decode_error(path, error))?;
    detect_format_at_offset(&header[..header_length]).ok_or(RecoveryError::UnsupportedFormat)
}

fn pe_overlay_offset(file: &mut fs::File, file_size: u64) -> Option<u64> {
    let mut dos_header = [0u8; DOS_HEADER_PROBE_LIMIT];
    file.seek(SeekFrom::Start(0)).ok()?;
    file.read_exact(&mut dos_header).ok()?;
    if !dos_header.starts_with(b"MZ") {
        return None;
    }

    let pe_offset = u32::from_le_bytes(dos_header[0x3c..0x40].try_into().ok()?) as u64;
    let mut coff_header = [0u8; 24];
    file.seek(SeekFrom::Start(pe_offset)).ok()?;
    file.read_exact(&mut coff_header).ok()?;
    if !coff_header.starts_with(b"PE\0\0") {
        return None;
    }

    let section_count = u16::from_le_bytes(coff_header[6..8].try_into().ok()?);
    if section_count == 0 || section_count > PE_MAX_SECTION_COUNT {
        return None;
    }
    let optional_header_size = u16::from_le_bytes(coff_header[20..22].try_into().ok()?) as u64;
    let section_table_offset = pe_offset
        .checked_add(24)?
        .checked_add(optional_header_size)?;
    let section_table_size = u64::from(section_count).checked_mul(PE_SECTION_HEADER_SIZE)?;
    if section_table_offset.checked_add(section_table_size)? > file_size {
        return None;
    }

    let mut overlay_offset = section_table_offset.checked_add(section_table_size)?;
    let mut section_header = [0u8; PE_SECTION_HEADER_SIZE as usize];
    for index in 0..section_count {
        let offset = section_table_offset
            .checked_add(u64::from(index).checked_mul(PE_SECTION_HEADER_SIZE)?)?;
        file.seek(SeekFrom::Start(offset)).ok()?;
        file.read_exact(&mut section_header).ok()?;
        let raw_size = u32::from_le_bytes(section_header[16..20].try_into().ok()?) as u64;
        let raw_offset = u32::from_le_bytes(section_header[20..24].try_into().ok()?) as u64;
        overlay_offset = overlay_offset.max(raw_offset.checked_add(raw_size)?);
    }
    Some(overlay_offset.min(file_size))
}

fn detect_format_in_buffer(buffer: &[u8], require_start: bool) -> Option<ArchiveFormat> {
    if require_start {
        return detect_format_at_offset(buffer);
    }
    (0..buffer.len()).find_map(|index| detect_format_at_offset(&buffer[index..]))
}

fn detect_format_at_offset(buffer: &[u8]) -> Option<ArchiveFormat> {
    match buffer.first().copied()? {
        0x37 if buffer.starts_with(SEVEN_ZIP_SIGNATURE) => Some(ArchiveFormat::SevenZip),
        b'R' if buffer.starts_with(RAR5_SIGNATURE) => Some(ArchiveFormat::Rar5),
        b'R' if buffer.starts_with(RAR3_SIGNATURE) => Some(ArchiveFormat::Rar3),
        b'P' if ZIP_SIGNATURES
            .iter()
            .any(|signature| buffer.starts_with(signature)) =>
        {
            Some(ArchiveFormat::Zip)
        }
        _ => None,
    }
}

fn lz4_decode_error(path: &Path, error: std::io::Error) -> RecoveryError {
    RecoveryError::Message(format!(
        "LZ4 外层解码失败（{}）：{error}",
        path_for_display(path)
    ))
}

pub(super) fn is_lz4_frame(path: &Path) -> Result<bool, RecoveryError> {
    let mut file = fs::File::open(path)?;
    let mut signature = [0u8; LZ4_FRAME_SIGNATURE.len()];
    let length = file.read(&mut signature)?;
    Ok(length == signature.len() && signature == LZ4_FRAME_SIGNATURE)
}

pub(super) fn materialize_lz4_archive(
    source: &Path,
    format: ArchiveFormat,
    work_directory: &Path,
    cancellation: &CancellationToken,
) -> Result<Option<PathBuf>, RecoveryError> {
    if !is_lz4_frame(source)? {
        return Ok(None);
    }

    let normalized_path = work_directory.join(format!("lz4-decoded.{}", format.extension()));
    let partial_path = work_directory.join("lz4-decoded.partial");
    let compressed_bytes = fs::metadata(source)?.len();
    let decoded_limit = lz4_decoded_byte_limit(compressed_bytes);
    let result = (|| {
        let input = BufReader::new(fs::File::open(source)?);
        let mut decoder =
            Lz4Decoder::new(input).map_err(|error| lz4_decode_error(source, error))?;
        let mut output = BufWriter::new(fs::File::create(&partial_path)?);
        let mut buffer = vec![0u8; LZ4_COPY_BUFFER_SIZE];
        let mut decoded_bytes = 0u64;

        loop {
            ensure_not_cancelled(cancellation)?;
            let length = decoder
                .read(&mut buffer)
                .map_err(|error| lz4_decode_error(source, error))?;
            if length == 0 {
                break;
            }
            decoded_bytes = decoded_bytes.saturating_add(length as u64);
            if decoded_bytes > decoded_limit {
                return Err(RecoveryError::Message(format!(
                    "LZ4 外层展开后超过安全上限（最多 {} MiB）。",
                    decoded_limit / (1024 * 1024)
                )));
            }
            output.write_all(&buffer[..length])?;
        }
        ensure_not_cancelled(cancellation)?;
        output.flush()?;
        drop(output);
        let (_, finish_result) = decoder.finish();
        finish_result.map_err(|error| lz4_decode_error(source, error))?;

        let mut normalized = fs::File::open(&partial_path)?;
        let mut header = [0u8; HEADER_PROBE_LIMIT];
        let header_length = normalized.read(&mut header)?;
        let decoded_format = detect_format_at_offset(&header[..header_length])
            .ok_or(RecoveryError::UnsupportedFormat)?;
        if decoded_format != format {
            return Err(RecoveryError::Message(format!(
                "LZ4 解包后的归档格式与分析结果不一致：预期 {}，实际 {}。",
                format.label(),
                decoded_format.label()
            )));
        }

        fs::rename(&partial_path, &normalized_path)?;
        Ok(normalized_path.clone())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&partial_path);
        let _ = fs::remove_file(&normalized_path);
    }
    result.map(Some)
}

pub(super) fn lz4_decoded_byte_limit(compressed_bytes: u64) -> u64 {
    compressed_bytes
        .saturating_mul(MAX_LZ4_EXPANSION_RATIO)
        .min(MAX_LZ4_DECODED_BYTES)
}

fn looks_like_embedded_archive_carrier(prefix: &[u8]) -> bool {
    prefix.starts_with(b"\xff\xd8\xff")
        || prefix.starts_with(b"\x89PNG\r\n\x1a\n")
        || prefix.starts_with(b"GIF87a")
        || prefix.starts_with(b"GIF89a")
        || prefix.starts_with(b"BM")
        || prefix.starts_with(b"%PDF")
        || prefix.starts_with(b"ID3")
        || prefix.starts_with(b"\x1aE\xdf\xa3")
        || (prefix.len() >= 12 && &prefix[4..8] == b"ftyp")
        || (prefix.len() >= 12 && prefix.starts_with(b"RIFF") && &prefix[8..12] == b"WEBP")
}

pub fn path_for_display(path: &Path) -> String {
    strip_windows_verbatim_prefix(&path.to_string_lossy())
}

fn strip_windows_verbatim_prefix(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        rest.to_owned()
    } else {
        path.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_stops_before_reading_another_chunk_after_cancellation() {
        struct CancellingReader {
            token: CancellationToken,
            reads: usize,
        }
        impl Read for CancellingReader {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                self.reads += 1;
                buffer[0] = b'a';
                self.token.cancel();
                Ok(1)
            }
        }

        let cancellation = CancellationToken::default();
        let mut reader = CancellingReader {
            token: cancellation.clone(),
            reads: 0,
        };
        let result = update_sha256_from_reader(
            &mut Sha256::new(),
            &mut reader,
            &mut [0u8; 8],
            Some(&cancellation),
        );

        assert!(matches!(result, Err(RecoveryError::Cancelled)));
        assert_eq!(reader.reads, 1);
    }
}
