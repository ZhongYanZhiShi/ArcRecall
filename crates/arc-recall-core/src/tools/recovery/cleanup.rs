use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use super::super::runner::CancellationToken;

// Cleanup must remain bounded even for an existing, user-selected output tree.
const MAX_SCAN_ENTRIES: usize = 1_000_000;

pub(super) struct EmptyDirectoryCleanup {
    existing: io::Result<HashSet<PathBuf>>,
}

#[derive(Default)]
pub(super) struct CleanupSummary {
    pub removed: u64,
    pub incomplete: bool,
}

impl CleanupSummary {
    pub fn merge(&mut self, other: Self) {
        self.removed += other.removed;
        self.incomplete |= other.incomplete;
    }

    pub fn message(&self) -> String {
        let mut message = format!("本次已清理 {} 个空文件夹。", self.removed);
        if self.incomplete {
            message.push_str("部分目录未完成清理，已保留。");
        }
        message
    }
}

impl EmptyDirectoryCleanup {
    /// Capture before extraction: an existing empty directory belongs to the user.
    pub fn prepare(root: &Path, cancellation: &CancellationToken) -> Self {
        let existing = match fs::symlink_metadata(root) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(HashSet::new()),
            Err(error) => Err(error),
            Ok(_) => directory_tree(root, cancellation).map(|paths| paths.into_iter().collect()),
        };
        Self { existing }
    }

    pub fn finish(self, root: &Path, cancellation: &CancellationToken) -> CleanupSummary {
        self.finish_with(root, cancellation, remove_empty_directory)
    }

    fn finish_with(
        self,
        root: &Path,
        cancellation: &CancellationToken,
        mut remove: impl FnMut(&Path) -> io::Result<bool>,
    ) -> CleanupSummary {
        let mut summary = CleanupSummary::default();
        let Ok(existing) = self.existing else {
            summary.incomplete = true;
            return summary;
        };
        let paths = match directory_tree(root, cancellation) {
            Ok(paths) => paths,
            Err(_) => {
                summary.incomplete = true;
                return summary;
            }
        };
        // Children always precede their parents, so a newly empty parent is
        // removed in the same pass. Keep each archive's output root for history.
        for path in paths.into_iter().rev() {
            if cancellation.is_cancelled() {
                summary.incomplete = true;
                break;
            }
            if path == root || existing.contains(&path) {
                continue;
            }
            // Recheck every ancestor: a directory may have become a junction or
            // symlink since enumeration. Never intentionally traverse a link.
            if plain_directory_chain(root, &path).is_err() {
                summary.incomplete = true;
                continue;
            }
            match fs::read_dir(&path).map(|mut entries| entries.next()) {
                Ok(None) => match remove(&path) {
                    Ok(true) => summary.removed += 1,
                    Ok(false) => {}
                    // A concurrent writer can make it nonempty after the check.
                    Err(error) if error.kind() == io::ErrorKind::DirectoryNotEmpty => {}
                    Err(_) => summary.incomplete = true,
                },
                Ok(Some(Ok(_))) => {}
                Ok(Some(Err(_))) | Err(_) => summary.incomplete = true,
            }
        }
        summary
    }
}

// A directory's named NTFS streams are data even when read_dir reports no
// entries. Check immediately before removal; uncertainty always preserves it.
fn remove_empty_directory(path: &Path) -> io::Result<bool> {
    if directory_has_named_streams(path)? {
        return Ok(false);
    }
    fs::remove_dir(path)?;
    Ok(true)
}

#[cfg(windows)]
pub(super) fn directory_has_named_streams(path: &Path) -> io::Result<bool> {
    use windows_sys::Win32::Foundation::{ERROR_HANDLE_EOF, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        FindClose, FindFirstStreamW, FindStreamInfoStandard, WIN32_FIND_STREAM_DATA,
    };
    let path = windows_path(path)?;
    let mut data = WIN32_FIND_STREAM_DATA::default();
    // Directories have no unnamed $DATA stream: any returned stream must be
    // preserved. See Microsoft's FindFirstStreamW contract.
    // SAFETY: the path is NUL-terminated and the correctly sized output lives
    // through the call. Every successful search handle is closed below.
    let handle = unsafe {
        FindFirstStreamW(
            path.as_ptr(),
            FindStreamInfoStandard,
            (&mut data as *mut WIN32_FIND_STREAM_DATA).cast(),
            0,
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        let error = io::Error::last_os_error();
        return if error.raw_os_error() == Some(ERROR_HANDLE_EOF as i32) {
            Ok(false)
        } else {
            Err(error)
        };
    }
    // SAFETY: this is the valid search handle returned above, closed once.
    unsafe { FindClose(handle) };
    Ok(true)
}

#[cfg(not(windows))]
pub(super) fn directory_has_named_streams(_path: &Path) -> io::Result<bool> {
    Ok(false)
}

#[cfg(windows)]
pub(super) fn windows_path(path: &Path) -> io::Result<Vec<u16>> {
    use std::os::windows::ffi::OsStrExt;
    let absolute = std::path::absolute(path)?;
    let mut value: Vec<_> = absolute.as_os_str().encode_wide().collect();
    if value.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "路径包含空字符",
        ));
    }
    // Match std::fs's long-path support without resolving directory links.
    if !value.starts_with(&[92, 92, 63, 92]) {
        value = if value.starts_with(&[92, 92]) {
            "\\\\?\\UNC\\"
                .encode_utf16()
                .chain(value.into_iter().skip(2))
                .collect()
        } else {
            "\\\\?\\".encode_utf16().chain(value).collect()
        };
    }
    value.push(0);
    Ok(value)
}

fn directory_tree(root: &Path, cancellation: &CancellationToken) -> io::Result<Vec<PathBuf>> {
    let mut pending = vec![root.to_path_buf()];
    let mut directories = Vec::new();
    let mut entries_seen = 0;
    while let Some(directory) = pending.pop() {
        check_cancelled(cancellation)?;
        plain_directory_chain(root, &directory)?;
        for entry in fs::read_dir(&directory)? {
            check_cancelled(cancellation)?;
            entries_seen += 1;
            if entries_seen > MAX_SCAN_ENTRIES {
                return Err(io::Error::other("空目录扫描达到条目上限"));
            }
            let entry = entry?;
            if is_plain_directory(&fs::symlink_metadata(entry.path())?) {
                pending.push(entry.path());
            }
        }
        directories.push(directory);
    }
    Ok(directories)
}

fn check_cancelled(cancellation: &CancellationToken) -> io::Result<()> {
    if cancellation.is_cancelled() {
        Err(io::Error::new(io::ErrorKind::Interrupted, "清理已取消"))
    } else {
        Ok(())
    }
}

fn plain_directory_chain(root: &Path, path: &Path) -> io::Result<()> {
    if !path.starts_with(root) {
        return Err(io::Error::other("目录不在输出范围内"));
    }
    for ancestor in path.ancestors() {
        if !is_plain_directory(&fs::symlink_metadata(ancestor)?) {
            return Err(io::Error::other("目录已被替换或是目录链接"));
        }
        if ancestor == root {
            return Ok(());
        }
    }
    Err(io::Error::other("目录不在输出范围内"))
}

pub(super) fn is_plain_directory(metadata: &fs::Metadata) -> bool {
    metadata.is_dir() && !is_directory_link(metadata)
}

pub(super) fn is_directory_link(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_whole_empty_chains_and_preserves_output_root() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("output");
        let token = CancellationToken::default();
        let cleanup = EmptyDirectoryCleanup::prepare(&root, &token);
        fs::create_dir_all(root.join("a/b/c")).unwrap();
        fs::create_dir_all(root.join("a/d")).unwrap();
        let summary = cleanup.finish(&root, &token);
        assert_eq!(summary.removed, 4);
        assert!(!summary.incomplete);
        assert!(root.is_dir());
        assert_eq!(fs::read_dir(root).unwrap().count(), 0);
    }

    #[test]
    fn preserves_existing_directories_hidden_files_and_zero_byte_files() {
        let root = tempfile::tempdir().unwrap();
        let token = CancellationToken::default();
        fs::create_dir_all(root.path().join("existing/empty")).unwrap();
        let cleanup = EmptyDirectoryCleanup::prepare(root.path(), &token);
        fs::create_dir_all(root.path().join("existing/new/empty")).unwrap();
        fs::create_dir_all(root.path().join("hidden/empty")).unwrap();
        fs::create_dir_all(root.path().join("zero")).unwrap();
        fs::write(root.path().join("hidden/.keep"), b"keep").unwrap();
        fs::write(root.path().join("zero/empty.txt"), b"").unwrap();
        let summary = cleanup.finish(root.path(), &token);
        assert_eq!(summary.removed, 3);
        assert!(root.path().join("existing/empty").is_dir());
        assert_eq!(fs::read(root.path().join("hidden/.keep")).unwrap(), b"keep");
        assert!(root.path().join("zero/empty.txt").is_file());
    }

    #[test]
    fn cancellation_preserves_directories() {
        let root = tempfile::tempdir().unwrap();
        let token = CancellationToken::default();
        let cleanup = EmptyDirectoryCleanup::prepare(root.path(), &token);
        fs::create_dir_all(root.path().join("a/b")).unwrap();
        token.cancel();
        let summary = cleanup.finish(root.path(), &token);
        assert!(summary.incomplete);
        assert_eq!(summary.removed, 0);
        assert!(root.path().join("a/b").is_dir());
    }

    #[test]
    fn a_file_added_after_the_empty_check_is_never_deleted() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("output");
        let token = CancellationToken::default();
        let cleanup = EmptyDirectoryCleanup::prepare(&root, &token);
        let leaf = root.join("empty");
        fs::create_dir_all(&leaf).unwrap();
        let summary = cleanup.finish_with(&root, &token, |path| {
            fs::write(path.join("late-file"), b"concurrent content")?;
            remove_empty_directory(path)
        });
        assert_eq!(summary.removed, 0);
        assert_eq!(
            fs::read(leaf.join("late-file")).unwrap(),
            b"concurrent content"
        );
    }

    #[cfg(windows)]
    #[test]
    fn unreadable_directory_preserves_the_entire_tree() {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS;
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("output");
        let token = CancellationToken::default();
        let cleanup = EmptyDirectoryCleanup::prepare(&root, &token);
        fs::create_dir_all(root.join("locked")).unwrap();
        fs::create_dir(root.join("empty")).unwrap();
        let _locked = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(root.join("locked"))
            .unwrap();
        let summary = cleanup.finish(&root, &token);
        assert!(summary.incomplete);
        assert_eq!(summary.removed, 0);
        assert!(root.join("empty").is_dir());
    }

    #[cfg(windows)]
    #[test]
    fn windows_hidden_system_files_are_not_empty_directory_content() {
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_SYSTEM, SetFileAttributesW,
        };
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("output");
        let token = CancellationToken::default();
        let cleanup = EmptyDirectoryCleanup::prepare(&root, &token);
        fs::create_dir_all(root.join("hidden")).unwrap();
        let file = root.join("hidden/data.bin");
        fs::write(&file, [0, 255, 1, 0, 128]).unwrap();
        let wide = windows_path(&file).unwrap();
        // SAFETY: the path is NUL-terminated and valid for the call.
        assert_ne!(
            unsafe {
                SetFileAttributesW(wide.as_ptr(), FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM)
            },
            0
        );
        assert_eq!(cleanup.finish(&root, &token).removed, 0);
        assert_eq!(fs::read(file).unwrap(), [0, 255, 1, 0, 128]);
    }

    #[test]
    fn failed_snapshot_never_deletes_directories() {
        let root = tempfile::tempdir().unwrap();
        let token = CancellationToken::default();
        token.cancel();
        let cleanup = EmptyDirectoryCleanup::prepare(root.path(), &token);
        fs::create_dir(root.path().join("keep")).unwrap();
        let summary = cleanup.finish(root.path(), &CancellationToken::default());
        assert!(summary.incomplete);
        assert_eq!(summary.removed, 0);
        assert!(root.path().join("keep").is_dir());
    }

    #[test]
    fn deep_directory_tree_is_processed_without_recursive_calls() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("output");
        let token = CancellationToken::default();
        let cleanup = EmptyDirectoryCleanup::prepare(&root, &token);
        let mut leaf = root.clone();
        for _ in 0..80 {
            leaf.push("d");
        }
        fs::create_dir_all(leaf).unwrap();
        assert_eq!(cleanup.finish(&root, &token).removed, 80);
        assert!(root.is_dir());
    }

    #[cfg(windows)]
    #[test]
    fn preserves_empty_directories_with_alternate_data_streams() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("output");
        let token = CancellationToken::default();
        let cleanup = EmptyDirectoryCleanup::prepare(&root, &token);
        fs::create_dir_all(root.join("wrapper/empty")).unwrap();
        let stream = root.join("wrapper/empty:notes");
        fs::write(&stream, b"directory data must survive").unwrap();
        assert_eq!(fs::read_dir(root.join("wrapper/empty")).unwrap().count(), 0);
        let summary = cleanup.finish(&root, &token);
        assert_eq!(summary.removed, 0);
        assert_eq!(fs::read(stream).unwrap(), b"directory data must survive");
    }

    #[cfg(windows)]
    #[test]
    fn never_traverses_windows_junctions() {
        use std::os::windows::process::CommandExt;
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::create_dir(outside.path().join("keep")).unwrap();
        let token = CancellationToken::default();
        let cleanup = EmptyDirectoryCleanup::prepare(root.path(), &token);
        let link = root.path().join("junction");
        let status = std::process::Command::new("cmd.exe")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(outside.path())
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        assert!(status.status.success(), "{status:?}");
        fs::create_dir(root.path().join("empty")).unwrap();
        let summary = cleanup.finish(root.path(), &token);
        assert_eq!(summary.removed, 1);
        assert!(outside.path().join("keep").is_dir());
        assert!(link.is_dir());
        fs::remove_dir(link).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn preserves_directory_links_and_dangling_links() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let token = CancellationToken::default();
        let cleanup = EmptyDirectoryCleanup::prepare(root.path(), &token);
        fs::create_dir(outside.path().join("keep")).unwrap();
        fs::create_dir(root.path().join("wrapper")).unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("link")).unwrap();
        let dangling = root.path().join("wrapper/dangling");
        std::os::unix::fs::symlink(root.path().join("missing"), &dangling).unwrap();
        assert_eq!(cleanup.finish(root.path(), &token).removed, 0);
        assert!(outside.path().join("keep").is_dir());
        assert!(
            fs::symlink_metadata(dangling)
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }
}
