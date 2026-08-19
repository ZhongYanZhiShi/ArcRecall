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
const FINGERPRINT_FULL_READ_LIMIT: u64 = 1024 * 1024;
pub(super) const FINGERPRINT_SAMPLE_SIZE: u64 = 64 * 1024;
pub(super) const FINGERPRINT_SAMPLE_COUNT: u64 = 5;

pub fn analyze_archive(path: impl AsRef<Path>) -> Result<ArchiveAnalysis, RecoveryError> {
    let path = path.as_ref();
    if !path.is_file() {
        return Err(RecoveryError::NotFound(path_for_display(path)));
    }
    let absolute = path.canonicalize()?;
    let format = detect_archive_format(&absolute)?;
    let metadata = absolute.metadata()?;
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
        file_size: metadata.len(),
        suggested_output_directory: path_for_display(&suggested_output_directory),
    })
}

pub fn fingerprint_file_sha256(path: impl AsRef<Path>) -> Result<String, RecoveryError> {
    let mut file = fs::File::open(path)?;
    let file_size = file.metadata()?.len();
    let mut hasher = Sha256::new();
    hasher.update(b"arc-recall-content-fingerprint-v2\0");
    hasher.update(file_size.to_le_bytes());

    let ranges = fingerprint_sample_ranges(file_size);
    let mut buffer = vec![0u8; FINGERPRINT_SAMPLE_SIZE as usize];
    for (offset, length) in ranges {
        file.seek(SeekFrom::Start(offset))?;
        hasher.update(offset.to_le_bytes());
        hasher.update((length as u64).to_le_bytes());
        let mut read_total = 0;
        while read_total < length {
            let count = file.read(&mut buffer[..length - read_total])?;
            if count == 0 {
                break;
            }
            hasher.update(&buffer[..count]);
            read_total += count;
        }
    }
    Ok(hex::encode(hasher.finalize()))
}

pub(super) fn fingerprint_sample_ranges(file_size: u64) -> Vec<(u64, usize)> {
    if file_size == 0 {
        return Vec::new();
    }
    if file_size <= FINGERPRINT_FULL_READ_LIMIT {
        return vec![(0, file_size as usize)];
    }

    let max_offset = file_size.saturating_sub(FINGERPRINT_SAMPLE_SIZE);
    let mut offsets = (0..FINGERPRINT_SAMPLE_COUNT)
        .map(|index| max_offset.saturating_mul(index) / (FINGERPRINT_SAMPLE_COUNT - 1))
        .collect::<Vec<_>>();
    offsets.sort_unstable();
    offsets.dedup();
    offsets
        .into_iter()
        .map(|offset| {
            (
                offset,
                FINGERPRINT_SAMPLE_SIZE.min(file_size - offset) as usize,
            )
        })
        .collect()
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
