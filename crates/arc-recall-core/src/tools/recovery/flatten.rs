use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use super::super::runner::CancellationToken;
use super::cleanup::{directory_has_named_streams, is_directory_link, is_plain_directory};

#[derive(Default)]
pub(super) struct FlattenSummary {
    pub levels: u64,
    pub incomplete: bool,
    pub retained_paths: Vec<PathBuf>,
    pub fallback_root: Option<PathBuf>,
}

impl FlattenSummary {
    pub fn merge(&mut self, other: Self) {
        self.levels += other.levels;
        self.incomplete |= other.incomplete;
        self.retained_paths.extend(other.retained_paths);
    }

    pub fn message(&self) -> String {
        let mut message = format!("本次已去除 {} 层多余嵌套。", self.levels);
        if self.incomplete {
            message.push_str("部分层级未完成整理，文件已保留。");
        }
        for path in &self.retained_paths {
            message.push_str(&format!(" 保留目录：{}。", super::path_for_display(path)));
        }
        message
    }
}

/// Only call for a newly created archive output, before discovering nested
/// archives. Its public path stays unchanged, including after a successful fold.
pub(super) fn flatten_output(
    root: &Path,
    archive: &Path,
    cancellation: &CancellationToken,
) -> FlattenSummary {
    flatten_with(root, archive, cancellation, rename_without_replace)
}

fn flatten_with(
    root: &Path,
    archive: &Path,
    cancellation: &CancellationToken,
    mut rename: impl FnMut(&Path, &Path) -> io::Result<()>,
) -> FlattenSummary {
    let mut summary = FlattenSummary::default();
    let result = (|| -> io::Result<()> {
        // A single child alone does not imply a meaningless hierarchy. Only
        // repeated exact archive-name wrappers qualify; never guess aliases or strip
        // dates, version numbers, case, spaces, or archive-looking suffixes.
        let Some(name) = archive.file_stem().filter(|name| !name.is_empty()) else {
            return Ok(());
        };
        if archive.extension().is_none() {
            return Ok(());
        }
        let (wrappers, current) = wrapper_chain(root, name, cancellation)?;
        if wrappers.is_empty() || contains_protected_entries(root, cancellation)? {
            return Ok(());
        }
        let relative_content = current.strip_prefix(root).map_err(io::Error::other)?;
        let parent = root
            .parent()
            .ok_or_else(|| io::Error::other("缺少输出父目录"))?;
        check_cancelled(cancellation)?;
        // Keep the transaction directory BEFORE moving data into it. A failure,
        // cancellation or process exit must never trigger recursive auto-deletion.
        let holding = tempfile::Builder::new()
            .prefix(".arcrecall-unwrap-")
            .tempdir_in(parent)?
            .keep();
        let original = holding.join("original");
        if let Err(error) = rename(root, &original) {
            let _ = fs::remove_dir(&holding);
            return Err(error);
        }
        // Once the root has moved, finish or roll back before honoring cancellation.
        let publish = (|| {
            check_cancelled(cancellation)?;
            // Revalidate after taking ownership of the root. A new sibling,
            // link or stream invalidates the plan and restores the original.
            let (checked_wrappers, checked_content) = wrapper_chain(&original, name, cancellation)?;
            if checked_wrappers.len() != wrappers.len()
                || checked_content != original.join(relative_content)
                || contains_protected_entries(&original, cancellation)?
            {
                return Err(io::Error::other("目录内容已变化，保留原层级"));
            }
            rename(&checked_content, root)
        })();
        if let Err(error) = publish {
            if rename(&original, root).is_err() {
                summary.fallback_root = Some(original.clone());
                summary.retained_paths.push(original);
            } else {
                let _ = fs::remove_dir(&holding);
            }
            return Err(error);
        }
        summary.levels = wrappers.len() as u64;
        // The original root and wrappers are now empty. Never use remove_dir_all:
        // concurrent additions must survive, with their location reported.
        for wrapper in wrappers.into_iter().rev() {
            let path = original.join(wrapper.strip_prefix(root).map_err(io::Error::other)?);
            let remove = directory_has_named_streams(&path).and_then(|has_streams| {
                if has_streams {
                    Err(io::Error::other("目录出现附加数据，已保留"))
                } else {
                    fs::remove_dir(path)
                }
            });
            if let Err(error) = remove {
                summary.retained_paths.push(original);
                return Err(error);
            }
        }
        if let Err(error) = fs::remove_dir(&holding) {
            summary.retained_paths.push(holding);
            return Err(error);
        }
        Ok(())
    })();
    summary.incomplete = result.is_err();
    summary
}

fn wrapper_chain(
    root: &Path,
    name: &std::ffi::OsStr,
    cancellation: &CancellationToken,
) -> io::Result<(Vec<PathBuf>, PathBuf)> {
    let mut current = root.to_path_buf();
    let mut wrappers = Vec::new();
    loop {
        check_cancelled(cancellation)?;
        if !is_plain_directory(&fs::symlink_metadata(&current)?) {
            return Ok((Vec::new(), root.to_path_buf()));
        }
        let mut entries = fs::read_dir(&current)?;
        let Some(entry) = entries.next() else {
            // Flattening must not act as empty-directory cleanup when that
            // independent setting is off.
            return Ok((Vec::new(), root.to_path_buf()));
        };
        let entry = entry?;
        // Any sibling (including a hidden file) ends the wrapper chain.
        if let Some(entry) = entries.next() {
            entry?;
            break;
        }
        if entry.file_name() != name || !is_plain_directory(&fs::symlink_metadata(entry.path())?) {
            break;
        }
        wrappers.push(current);
        current = entry.path();
        if wrappers.len() > 1_024 {
            return Err(io::Error::other("目录层级超过整理上限"));
        }
    }
    // A single archive-named directory (e.g. src.zip -> src/main) is ordinary
    // structure. Require repetition and retain the innermost original name.
    if wrappers.len() < 2 {
        return Ok((Vec::new(), root.to_path_buf()));
    }
    current = wrappers.pop().expect("at least two matching wrappers");
    Ok((wrappers, current))
}

fn check_cancelled(cancellation: &CancellationToken) -> io::Result<()> {
    if cancellation.is_cancelled() {
        Err(io::Error::new(io::ErrorKind::Interrupted, "整理已取消"))
    } else {
        Ok(())
    }
}

// Moving relative symlinks can change what they reference. Preserve the entire
// output if any link/reparse point appears anywhere in the tree.
fn contains_protected_entries(root: &Path, cancellation: &CancellationToken) -> io::Result<bool> {
    let mut pending = vec![root.to_path_buf()];
    let mut seen = 0;
    while let Some(path) = pending.pop() {
        check_cancelled(cancellation)?;
        let metadata = fs::symlink_metadata(&path)?;
        if is_directory_link(&metadata) {
            return Ok(true);
        }
        if metadata.is_dir() {
            if directory_has_named_streams(&path)? {
                return Ok(true);
            }
            for entry in fs::read_dir(path)? {
                check_cancelled(cancellation)?;
                seen += 1;
                if seen > 1_000_000 {
                    return Err(io::Error::other("目录整理达到条目上限"));
                }
                pending.push(entry?.path());
            }
        }
    }
    Ok(false)
}

#[cfg(windows)]
fn rename_without_replace(source: &Path, destination: &Path) -> io::Result<()> {
    let source = super::cleanup::windows_path(source)?;
    let destination = super::cleanup::windows_path(destination)?;
    // SAFETY: both paths are NUL-terminated and live through the call. No
    // REPLACE_EXISTING or COPY_ALLOWED flags: never overwrite or copy volumes.
    if unsafe {
        windows_sys::Win32::Storage::FileSystem::MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            0,
        )
    } == 0
    {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(any(target_os = "linux", target_os = "android", target_vendor = "apple"))]
fn rename_without_replace(source: &Path, destination: &Path) -> io::Result<()> {
    use rustix::fs::{CWD, RenameFlags, renameat_with};
    renameat_with(CWD, source, CWD, destination, RenameFlags::NOREPLACE).map_err(Into::into)
}

#[cfg(not(any(
    windows,
    target_os = "linux",
    target_os = "android",
    target_vendor = "apple"
)))]
fn rename_without_replace(_source: &Path, _destination: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "系统不支持安全移动目录",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, PathBuf) {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("output");
        fs::create_dir_all(root.join("package/package/assets")).unwrap();
        fs::write(
            root.join("package/package/package"),
            b"filename matches outer wrapper",
        )
        .unwrap();
        fs::write(
            root.join("package/package/assets/.hidden"),
            b"hidden content",
        )
        .unwrap();
        fs::write(root.join("package/package/zero.txt"), b"").unwrap();
        (directory, root)
    }

    #[test]
    fn preserves_meaningful_single_child_directory_chains() {
        for (archive, path) in [
            ("照片.7z", "照片/2026/旅行"),
            ("src.zip", "src/main/java/com/example"),
            ("课程.rar", "课程/第一章/讲义"),
        ] {
            let directory = tempfile::tempdir().unwrap();
            let root = directory.path().join("output");
            fs::create_dir_all(root.join(path)).unwrap();
            let file = root.join(path).join("content.txt");
            fs::write(&file, b"meaningful hierarchy").unwrap();
            let result = flatten_output(&root, Path::new(archive), &CancellationToken::default());
            assert_eq!(result.levels, 0, "must preserve {path}");
            assert_eq!(fs::read(file).unwrap(), b"meaningful hierarchy");
        }
    }

    #[test]
    fn only_exact_archive_wrappers_are_folded_and_meaningful_children_survive() {
        for name in [
            "src",
            "2026",
            "第一章",
            "Package",
            "package-v2",
            "package (1)",
            "package.tar",
        ] {
            let directory = tempfile::tempdir().unwrap();
            let root = directory.path().join("custom-output");
            let content = root.join("package/package").join(name).join("details");
            fs::create_dir_all(&content).unwrap();
            fs::write(content.join("keep.txt"), b"keep hierarchy").unwrap();
            let result = flatten_output(
                &root,
                Path::new("package.7z"),
                &CancellationToken::default(),
            );
            assert_eq!(result.levels, 1, "{name}");
            assert!(!result.incomplete);
            assert_eq!(
                fs::read(root.join("package").join(name).join("details/keep.txt")).unwrap(),
                b"keep hierarchy"
            );
        }
    }

    #[test]
    fn flattening_does_not_remove_an_empty_chain() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("output");
        fs::create_dir_all(root.join("package/package")).unwrap();
        let result = flatten_output(
            &root,
            Path::new("package.7z"),
            &CancellationToken::default(),
        );
        assert_eq!(result.levels, 0);
        assert!(root.join("package/package").is_dir());
    }

    #[test]
    fn a_new_sibling_after_the_first_move_restores_the_original_hierarchy() {
        let (_directory, root) = fixture();
        let mut calls = 0;
        let result = flatten_with(
            &root,
            Path::new("package.7z"),
            &CancellationToken::default(),
            |from, to| {
                rename_without_replace(from, to)?;
                calls += 1;
                if calls == 1 {
                    fs::write(to.join("late-file"), b"concurrent content")?;
                }
                Ok(())
            },
        );
        assert!(result.incomplete);
        assert_eq!(result.levels, 0);
        assert!(result.retained_paths.is_empty());
        assert!(root.join("package/package/zero.txt").is_file());
        assert_eq!(
            fs::read(root.join("late-file")).unwrap(),
            b"concurrent content"
        );
    }

    #[test]
    fn additions_to_old_wrappers_during_publication_survive_with_a_reported_path() {
        let (_directory, root) = fixture();
        let mut calls = 0;
        let mut original = PathBuf::new();
        let result = flatten_with(
            &root,
            Path::new("package.7z"),
            &CancellationToken::default(),
            |from, to| {
                rename_without_replace(from, to)?;
                calls += 1;
                if calls == 1 {
                    original = to.to_path_buf();
                } else if calls == 2 {
                    fs::write(original.join("late-file"), b"concurrent content")?;
                }
                Ok(())
            },
        );
        assert!(result.incomplete);
        assert_eq!(result.levels, 1);
        assert!(root.join("package/zero.txt").is_file());
        assert_eq!(result.retained_paths, [original.clone()]);
        assert_eq!(
            fs::read(original.join("late-file")).unwrap(),
            b"concurrent content"
        );
    }

    #[cfg(windows)]
    #[test]
    fn preserves_alternate_data_streams_on_wrappers() {
        let (_directory, root) = fixture();
        let mut stream = root.join("package").into_os_string();
        stream.push(":notes");
        fs::write(&stream, b"wrapper data must survive").unwrap();
        let result = flatten_output(
            &root,
            Path::new("package.7z"),
            &CancellationToken::default(),
        );
        assert_eq!(result.levels, 0);
        assert_eq!(fs::read(stream).unwrap(), b"wrapper data must survive");
    }

    #[cfg(windows)]
    #[test]
    fn streams_added_during_either_move_are_preserved() {
        for stage in [1, 2] {
            let (_directory, root) = fixture();
            let mut original = PathBuf::new();
            let mut calls = 0;
            let result = flatten_with(
                &root,
                Path::new("package.7z"),
                &CancellationToken::default(),
                |from, to| {
                    rename_without_replace(from, to)?;
                    calls += 1;
                    if calls == 1 {
                        original = to.to_path_buf();
                    }
                    if calls == stage {
                        let mut stream = original.clone().into_os_string();
                        stream.push(":late-notes");
                        fs::write(stream, b"concurrent stream")?;
                    }
                    Ok(())
                },
            );
            assert!(result.incomplete);
            let mut stream = if stage == 1 {
                assert_eq!(result.levels, 0);
                assert!(result.retained_paths.is_empty());
                assert!(root.join("package/package/zero.txt").is_file());
                root.into_os_string()
            } else {
                assert_eq!(result.levels, 1);
                assert!(root.join("package/zero.txt").is_file());
                assert_eq!(result.retained_paths, [original.clone()]);
                original.into_os_string()
            };
            stream.push(":late-notes");
            assert_eq!(fs::read(stream).unwrap(), b"concurrent stream");
        }
    }

    #[test]
    fn folds_top_chain_and_keeps_payload_branches_and_root_path() {
        let (directory, root) = fixture();
        let result = flatten_output(
            &root,
            Path::new("package.7z"),
            &CancellationToken::default(),
        );
        assert_eq!(result.levels, 1);
        assert!(!result.incomplete);
        assert_eq!(
            fs::read(root.join("package/package")).unwrap(),
            b"filename matches outer wrapper"
        );
        assert_eq!(
            fs::read(root.join("package/assets/.hidden")).unwrap(),
            b"hidden content"
        );
        assert_eq!(
            fs::metadata(root.join("package/zero.txt")).unwrap().len(),
            0
        );
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
        assert_eq!(
            flatten_output(
                &root,
                Path::new("package.7z"),
                &CancellationToken::default()
            )
            .levels,
            0
        );
    }

    #[test]
    fn siblings_end_the_chain_including_hidden_files() {
        for sibling in [".keep", "readme.txt", "branch"] {
            let (_directory, root) = fixture();
            if sibling == "branch" {
                fs::create_dir(root.join(sibling)).unwrap();
            } else {
                fs::write(root.join(sibling), b"keep sibling").unwrap();
            }
            assert_eq!(
                flatten_output(
                    &root,
                    Path::new("package.7z"),
                    &CancellationToken::default()
                )
                .levels,
                0
            );
            assert!(root.join("package/package/zero.txt").is_file());
        }
    }

    #[test]
    fn folds_deep_chains_including_long_windows_paths() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("output");
        let mut leaf = root.clone();
        for _ in 0..140 {
            leaf.push("package");
        }
        fs::create_dir_all(&leaf).unwrap();
        fs::write(leaf.join("data.txt"), b"deep content").unwrap();
        let result = flatten_output(
            &root,
            Path::new("package.7z"),
            &CancellationToken::default(),
        );
        assert_eq!(result.levels, 139);
        assert!(!result.incomplete, "{}", result.message());
        assert_eq!(
            fs::read(root.join("package/data.txt")).unwrap(),
            b"deep content"
        );
    }

    #[test]
    fn failed_publication_rolls_back_without_losing_files() {
        let (directory, root) = fixture();
        let mut calls = 0;
        let result = flatten_with(
            &root,
            Path::new("package.7z"),
            &CancellationToken::default(),
            |from, to| {
                calls += 1;
                if calls == 2 {
                    return Err(io::Error::other("injected publication failure"));
                }
                rename_without_replace(from, to)
            },
        );
        assert!(result.incomplete);
        assert_eq!(result.levels, 0);
        assert!(result.retained_paths.is_empty());
        assert!(root.join("package/package/zero.txt").is_file());
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn late_destination_collision_keeps_both_outputs_and_reports_original_location() {
        let (_directory, root) = fixture();
        let mut calls = 0;
        let result = flatten_with(
            &root,
            Path::new("package.7z"),
            &CancellationToken::default(),
            |from, to| {
                calls += 1;
                if calls == 2 {
                    fs::create_dir(&root).unwrap();
                    fs::write(root.join("late-file"), b"never overwrite").unwrap();
                }
                rename_without_replace(from, to)
            },
        );
        assert!(result.incomplete);
        assert_eq!(result.levels, 0);
        assert_eq!(result.retained_paths.len(), 1);
        assert_eq!(result.fallback_root.as_ref(), result.retained_paths.first());
        assert!(
            result.retained_paths[0]
                .join("package/package/zero.txt")
                .is_file()
        );
        assert_eq!(
            fs::read(root.join("late-file")).unwrap(),
            b"never overwrite"
        );
        assert!(result.message().contains("保留目录"));
    }

    #[test]
    fn cancellation_after_first_move_restores_original_root() {
        let (directory, root) = fixture();
        let cancellation = CancellationToken::default();
        let result = flatten_with(&root, Path::new("package.7z"), &cancellation, |from, to| {
            rename_without_replace(from, to)?;
            cancellation.cancel();
            Ok(())
        });
        assert!(result.incomplete);
        assert_eq!(result.levels, 0);
        assert!(result.retained_paths.is_empty());
        assert!(root.join("package/package/zero.txt").is_file());
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn rename_never_overwrites_existing_files_or_directories() {
        let directory = tempfile::tempdir().unwrap();
        for as_directory in [false, true] {
            let source = directory.path().join(format!("source-{as_directory}"));
            let destination = directory.path().join(format!("destination-{as_directory}"));
            if as_directory {
                fs::create_dir(&source).unwrap();
                fs::create_dir(&destination).unwrap();
            } else {
                fs::write(&source, b"source").unwrap();
                fs::write(&destination, b"destination").unwrap();
            }
            assert!(rename_without_replace(&source, &destination).is_err());
            assert!(source.exists());
            assert!(destination.exists());
            if !as_directory {
                assert_eq!(fs::read(destination).unwrap(), b"destination");
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn directory_links_anywhere_in_payload_prevent_folding() {
        use std::os::windows::process::CommandExt;
        let (_directory, root) = fixture();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("outside.txt"), b"outside").unwrap();
        let link = root
            .join("package")
            .join("package")
            .join("assets")
            .join("link");
        let output = std::process::Command::new("cmd.exe")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(outside.path())
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        assert_eq!(
            flatten_output(
                &root,
                Path::new("package.7z"),
                &CancellationToken::default()
            )
            .levels,
            0
        );
        assert!(root.join("package/package/zero.txt").is_file());
        assert_eq!(
            fs::read(outside.path().join("outside.txt")).unwrap(),
            b"outside"
        );
        fs::remove_dir(link).unwrap();
    }
}
