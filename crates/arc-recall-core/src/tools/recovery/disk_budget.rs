use std::cell::Cell;
use std::fs;
use std::io;
use std::path::Path;

use super::RecoveryError;

pub const DEFAULT_TASK_MAX_BYTES: u64 = 100 * 1024 * 1024 * 1024;
pub const DEFAULT_TASK_MAX_ENTRIES: u64 = 100_000;
const DISK_RESERVE_BYTES: u64 = 256 * 1024 * 1024;

/// Shared by root, decoded wrappers and every nested archive in one task.
pub(super) struct TaskDiskBudget {
    max_bytes: u64,
    max_entries: u64,
    bytes: Cell<u64>,
    entries: Cell<u64>,
}

impl TaskDiskBudget {
    pub(super) fn new(max_bytes: u64, max_entries: u64) -> Self {
        Self {
            max_bytes,
            max_entries,
            bytes: Cell::new(0),
            entries: Cell::new(0),
        }
    }

    pub(super) fn remaining(&self) -> (u64, u64) {
        (
            self.max_bytes.saturating_sub(self.bytes.get()),
            self.max_entries.saturating_sub(self.entries.get()),
        )
    }

    pub(super) fn consume(&self, bytes: u64, entries: u64) -> Result<(), RecoveryError> {
        let (remaining_bytes, remaining_entries) = self.remaining();
        if bytes > remaining_bytes || entries > remaining_entries {
            return Err(RecoveryError::BudgetExceeded(format!(
                "累计展开量超过任务预算（最多 {} MiB / {} 项）；已完成输出保留。",
                self.max_bytes / (1024 * 1024),
                self.max_entries
            )));
        }
        self.bytes.set(self.bytes.get() + bytes);
        self.entries.set(self.entries.get() + entries);
        Ok(())
    }
}

impl Default for TaskDiskBudget {
    fn default() -> Self {
        Self::new(DEFAULT_TASK_MAX_BYTES, DEFAULT_TASK_MAX_ENTRIES)
    }
}

pub(super) fn check_free_space(path: &Path, needed: u64) -> Result<(), RecoveryError> {
    if let Some(available) = available_space(path)?
        && available < needed.saturating_add(DISK_RESERVE_BYTES)
    {
        return Err(RecoveryError::BudgetExceeded(
            "目标磁盘可用空间不足，需保留至少 256 MiB 空余空间。".into(),
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn available_space(path: &Path) -> io::Result<Option<u64>> {
    use std::os::windows::ffi::OsStrExt;
    let mut existing = path;
    while !existing.exists() {
        existing = existing
            .parent()
            .ok_or_else(|| io::Error::other("无法定位目标磁盘"))?;
    }
    if existing.is_file() {
        existing = existing
            .parent()
            .ok_or_else(|| io::Error::other("无法定位目标目录"))?;
    }
    let wide: Vec<u16> = existing.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut available = 0;
    // SAFETY: NUL-terminated path and a valid writable u64; other outputs optional.
    let result = unsafe {
        windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if result == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(Some(available))
}

#[cfg(not(windows))]
fn available_space(_path: &Path) -> io::Result<Option<u64>> {
    Ok(None)
}

/// Do not traverse symlinks/reparse points. Stop early at the configured bound.
pub(super) fn directory_usage(
    path: &Path,
    max_bytes: u64,
    max_entries: u64,
) -> io::Result<(u64, u64)> {
    if !path.exists() {
        return Ok((0, 0));
    }
    let mut pending = vec![path.to_path_buf()];
    let (mut bytes, mut entries) = (0u64, 0u64);
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            let meta = fs::symlink_metadata(entry.path())?;
            entries = entries.saturating_add(1);
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if meta.file_attributes() & 0x400 != 0 {
                    continue;
                }
            }
            if meta.is_file() {
                bytes = bytes.saturating_add(meta.len());
            } else if meta.is_dir() {
                pending.push(entry.path());
            }
            if bytes > max_bytes || entries > max_entries {
                return Err(io::Error::other("实时展开量已超过任务磁盘预算"));
            }
        }
    }
    Ok((bytes, entries))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cumulative_budget_counts_siblings_and_wrappers() {
        let budget = TaskDiskBudget::new(100, 5);
        budget.consume(40, 2).unwrap();
        budget.consume(50, 2).unwrap();
        assert!(budget.consume(11, 1).is_err());
        assert_eq!(budget.remaining(), (10, 1));
        budget.consume(10, 1).unwrap();
        assert!(budget.consume(0, 1).is_err());
        assert!(budget.consume(u64::MAX, 0).is_err());
    }
    #[test]
    fn actual_output_enforces_bytes_and_entries() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("a"), [0; 12]).unwrap();
        assert!(directory_usage(directory.path(), 11, 10).is_err());
        assert!(directory_usage(directory.path(), 100, 0).is_err());
        assert_eq!(directory_usage(directory.path(), 12, 1).unwrap(), (12, 1));
        #[cfg(windows)]
        assert!(available_space(directory.path()).unwrap().unwrap() > 0);
    }
}
