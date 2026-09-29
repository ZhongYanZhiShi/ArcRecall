use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use super::{CancellationToken, RecoveryError, analyze_archive, ensure_not_cancelled};

/// Create independent copies; never rename a source or link a repaired file to
/// its bytes. A multi-volume set is published as a single directory.
pub fn create_repaired_archive_copy(
    source: &Path,
    cancellation: &CancellationToken,
) -> Result<PathBuf, RecoveryError> {
    let analysis = analyze_archive(source)?;
    let source = Path::new(&analysis.archive_path);
    let parent = source
        .parent()
        .ok_or_else(|| RecoveryError::Message("无法定位归档目录".into()))?;
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("archive");
    let extension = if super::archive::is_lz4_frame(source)? {
        "lz4"
    } else {
        analysis.format.extension()
    };
    super::disk_budget::check_free_space(parent, analysis.file_size)?;
    if analysis.volume_paths.len() > 1 {
        let staging = tempfile::Builder::new()
            .prefix(".arcrecall-repair-")
            .tempdir_in(parent)?;
        for (index, volume) in analysis.volume_paths.iter().enumerate() {
            let destination = staging
                .path()
                .join(super::archive::split_volume_name(&analysis, index));
            let mut output = fs::File::create_new(destination)?;
            copy_bytes(volume, &mut output, cancellation)?;
        }
        ensure_not_cancelled(cancellation)?;
        for index in 1..10_000 {
            let destination = parent.join(format!("{stem}-修复副本 ({index})"));
            if destination.exists() {
                continue;
            }
            // Windows rename does not replace existing directories.
            match fs::rename(staging.path(), &destination) {
                Ok(()) => {
                    let _ = staging.keep();
                    return Ok(destination);
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.into()),
            }
        }
    } else {
        let mut staging = tempfile::NamedTempFile::new_in(parent)?;
        copy_bytes(source, staging.as_file_mut(), cancellation)?;
        ensure_not_cancelled(cancellation)?;
        for index in 0..10_000 {
            let name = if index == 0 {
                format!("{stem}.{extension}")
            } else {
                format!("{stem} ({index}).{extension}")
            };
            let destination = parent.join(name);
            match staging.persist_noclobber(&destination) {
                Ok(_) => return Ok(destination),
                Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                    staging = error.file
                }
                Err(error) => return Err(error.error.into()),
            }
        }
    }
    Err(RecoveryError::Message(
        "无法选择未被占用的副本名称。".into(),
    ))
}

fn copy_bytes(
    source: &Path,
    output: &mut fs::File,
    cancellation: &CancellationToken,
) -> Result<(), RecoveryError> {
    let mut input = fs::File::open(source)?;
    let before = input.metadata()?;
    let mut buffer = vec![0; 1024 * 1024];
    let mut copied = 0u64;
    loop {
        ensure_not_cancelled(cancellation)?;
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        super::disk_budget::check_free_space(source, count as u64)?;
        output.write_all(&buffer[..count])?;
        copied = copied.saturating_add(count as u64);
    }
    let after = input.metadata()?;
    if copied != before.len()
        || before.len() != after.len()
        || before.modified().ok() != after.modified().ok()
    {
        return Err(RecoveryError::Message(
            "复制期间源文件发生变化，请稍后重试。".into(),
        ));
    }
    output.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repairs_suffix_without_overwrite_or_shared_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("archive.wrong");
        let bytes = b"PK\x05\x06\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0";
        fs::write(&source, bytes).unwrap();
        fs::write(dir.path().join("archive.zip"), b"existing").unwrap();
        let copy = create_repaired_archive_copy(&source, &CancellationToken::default()).unwrap();
        assert_eq!(copy.file_name().unwrap(), "archive (1).zip");
        assert_eq!(fs::read(&copy).unwrap(), bytes);
        fs::write(copy, b"edited").unwrap();
        assert_eq!(fs::read(&source).unwrap(), bytes);
        assert_eq!(
            fs::read(dir.path().join("archive.zip")).unwrap(),
            b"existing"
        );
        let cancelled = CancellationToken::default();
        cancelled.cancel();
        assert!(matches!(
            create_repaired_archive_copy(&source, &cancelled),
            Err(RecoveryError::Cancelled)
        ));
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 3);
    }
}
