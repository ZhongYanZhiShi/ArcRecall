use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};

use arc_recall_core::CancellationToken;

#[derive(Default)]
struct LifecycleState {
    closing: bool,
    next_id: u64,
    tasks: BTreeMap<u64, CancellationToken>,
}

/// A lease covers preparation, execution and cleanup, so closing cannot race a start.
#[derive(Default)]
pub(crate) struct TaskLifecycle {
    state: Mutex<LifecycleState>,
    finished: Condvar,
}

impl TaskLifecycle {
    pub(crate) fn begin(self: &Arc<Self>) -> Result<TaskLease, String> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.closing {
            return Err("应用正在退出，无法启动新任务。".into());
        }
        state.next_id += 1;
        let id = state.next_id;
        let cancellation = CancellationToken::default();
        state.tasks.insert(id, cancellation.clone());
        Ok(TaskLease {
            lifecycle: Arc::clone(self),
            id,
            cancellation,
        })
    }

    /// Returns true only for the first shutdown request.
    pub(crate) fn request_shutdown(&self) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.closing {
            return false;
        }
        state.closing = true;
        for token in state.tasks.values() {
            token.cancel();
        }
        true
    }

    pub(crate) fn wait_until_finished(&self) {
        let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        drop(
            self.finished
                .wait_while(state, |state| !state.tasks.is_empty())
                .unwrap_or_else(|error| error.into_inner()),
        );
    }
}

pub(crate) struct TaskLease {
    lifecycle: Arc<TaskLifecycle>,
    id: u64,
    pub(crate) cancellation: CancellationToken,
}

impl Drop for TaskLease {
    fn drop(&mut self) {
        let mut state = self
            .lifecycle
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.tasks.remove(&self.id);
        self.lifecycle.finished.notify_all();
    }
}

/// The locked marker distinguishes abandoned work from another running instance.
pub(crate) struct RecoverySession {
    directory: PathBuf,
    _owner: File,
}

impl RecoverySession {
    pub(crate) fn create(temp: &Path) -> std::io::Result<Self> {
        let root = temp.join("recovery-sessions");
        fs::create_dir_all(&root)?;
        cleanup_abandoned_sessions(&root)?;
        for sequence in 0u64.. {
            let directory = root.join(format!(
                "session-{}-{}-{sequence}",
                std::process::id(),
                crate::current_time_ms()
            ));
            match fs::create_dir(&directory) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
            let pending_marker = directory.join("owner.pending");
            let owner = File::create_new(&pending_marker)?;
            owner.lock()?;
            fs::rename(pending_marker, directory.join("owner.lock"))?;
            return Ok(Self {
                directory,
                _owner: owner,
            });
        }
        unreachable!()
    }

    pub(crate) fn directory(&self) -> &Path {
        &self.directory
    }

    pub(crate) fn cleanup(&self) -> std::io::Result<()> {
        // Keep the marker locked until this instance has stopped all its workers.
        for entry in fs::read_dir(&self.directory)? {
            let entry = entry?;
            if entry.file_name() == "owner.lock" {
                continue;
            }
            if entry.file_type()?.is_dir() {
                fs::remove_dir_all(entry.path())?;
            } else {
                fs::remove_file(entry.path())?;
            }
        }
        Ok(())
    }
}

impl Drop for RecoverySession {
    fn drop(&mut self) {
        // The marker stays locked through deletion; the field closes afterward.
        let _ = fs::remove_dir_all(&self.directory);
    }
}

fn cleanup_abandoned_sessions(root: &Path) -> std::io::Result<()> {
    let root = root.canonicalize()?;
    for entry in fs::read_dir(&root)? {
        let entry = entry?;
        if !entry.file_name().to_string_lossy().starts_with("session-") {
            continue;
        }
        match entry.file_type() {
            Ok(kind) if kind.is_dir() => {}
            Ok(_) => continue,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        }
        let directory = match entry.path().canonicalize() {
            Ok(directory) => directory,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        if directory.parent() != Some(root.as_path()) {
            continue;
        }
        let marker = directory.join("owner.lock");
        if !fs::symlink_metadata(&marker).is_ok_and(|metadata| metadata.is_file()) {
            continue;
        }
        let Ok(owner) = OpenOptions::new().read(true).write(true).open(&marker) else {
            continue;
        };
        if owner.try_lock().is_err() {
            continue;
        }
        // Keep ownership through deletion so concurrent startup cannot also clean this session.
        let result = fs::remove_dir_all(&directory);
        drop(owner);
        if let Err(error) = result
            && error.kind() != std::io::ErrorKind::NotFound
        {
            return Err(error);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn shutdown_cancels_preparing_tasks_and_waits_for_cleanup() {
        let lifecycle = Arc::new(TaskLifecycle::default());
        let lease = lifecycle.begin().unwrap();
        assert!(lifecycle.request_shutdown());
        assert!(!lifecycle.request_shutdown());
        assert!(lease.cancellation.is_cancelled());
        assert!(lifecycle.begin().is_err());
        let (sender, receiver) = mpsc::channel();
        let waiter = std::thread::spawn(move || {
            lifecycle.wait_until_finished();
            sender.send(()).unwrap();
        });
        assert!(receiver.recv_timeout(Duration::from_millis(30)).is_err());
        drop(lease);
        receiver.recv_timeout(Duration::from_secs(2)).unwrap();
        waiter.join().unwrap();
    }

    #[test]
    fn startup_preserves_live_and_unmarked_directories_but_removes_abandoned_work() {
        let temp = tempfile::tempdir().unwrap();
        let live = RecoverySession::create(temp.path()).unwrap();
        fs::write(live.directory().join("dictionary.txt"), "synthetic").unwrap();
        let root = live.directory().parent().unwrap();
        let abandoned = root.join("session-abandoned");
        fs::create_dir(&abandoned).unwrap();
        File::create_new(abandoned.join("owner.lock")).unwrap();
        fs::write(abandoned.join("dictionary.txt"), "synthetic").unwrap();
        let unrelated = root.join("session-unmarked");
        fs::create_dir(&unrelated).unwrap();
        let other = RecoverySession::create(temp.path()).unwrap();
        assert!(live.directory().join("dictionary.txt").exists());
        assert!(!abandoned.exists());
        assert!(unrelated.exists());
        live.cleanup().unwrap();
        assert!(!live.directory().join("dictionary.txt").exists());
        let other_directory = other.directory().to_path_buf();
        drop(other);
        assert!(!other_directory.exists());
    }

    #[test]
    fn simultaneous_startups_can_clean_the_same_abandoned_sessions() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("recovery-sessions");
        fs::create_dir(&root).unwrap();
        for number in 0..40 {
            let abandoned = root.join(format!("session-abandoned-{number}"));
            fs::create_dir(&abandoned).unwrap();
            File::create_new(abandoned.join("owner.lock")).unwrap();
            fs::write(abandoned.join("dictionary.txt"), "synthetic").unwrap();
        }
        let barrier = Arc::new(std::sync::Barrier::new(2));
        std::thread::scope(|scope| {
            let workers: Vec<_> = (0..2)
                .map(|_| {
                    let barrier = Arc::clone(&barrier);
                    let root = &root;
                    scope.spawn(move || {
                        barrier.wait();
                        cleanup_abandoned_sessions(root).unwrap();
                    })
                })
                .collect();
            for worker in workers {
                worker.join().unwrap();
            }
        });
        assert_eq!(fs::read_dir(root).unwrap().count(), 0);
    }
}
