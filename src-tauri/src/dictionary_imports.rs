use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use crate::task_lifecycle::{TaskLease, TaskLifecycle};

/// Owns the gap between IPC batches, including browser-side encoding validation.
#[derive(Default)]
pub(crate) struct DictionaryImports(Mutex<(u64, BTreeMap<String, Arc<TaskLease>>)>);

impl DictionaryImports {
    pub(crate) fn begin(&self, lifecycle: &Arc<TaskLifecycle>) -> Result<String, String> {
        let mut imports = self.0.lock().map_err(|e| e.to_string())?;
        let lease = Arc::new(lifecycle.begin()?);
        imports.0 += 1;
        let id = format!("import-{}", imports.0);
        imports.1.insert(id.clone(), lease);
        Ok(id)
    }

    pub(crate) fn batch(&self, id: &str) -> Result<Arc<TaskLease>, String> {
        let imports = self.0.lock().map_err(|e| e.to_string())?;
        let lease = imports.1.get(id).ok_or("字典导入已结束或取消。")?;
        if lease.cancellation.is_cancelled() {
            return Err("字典导入已取消。".into());
        }
        Ok(Arc::clone(lease))
    }

    pub(crate) fn finish(&self, id: &str) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .1
            .remove(id);
    }

    pub(crate) fn cancel_all(&self) {
        let mut imports = self.0.lock().unwrap_or_else(|e| e.into_inner());
        for lease in imports.1.values() {
            lease.cancellation.cancel();
        }
        // A batch already in Rust retains its own lease until its transaction
        // completes. Shutdown never depends on a live WebView acknowledging it.
        imports.1.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn imports_block_maintenance_between_batches_and_shutdown_joins_the_committing_batch() {
        let lifecycle = Arc::new(TaskLifecycle::default());
        let imports = DictionaryImports::default();
        let id = imports.begin(&lifecycle).unwrap();
        assert!(lifecycle.reserve_update().is_err());
        assert!(lifecycle.reserve_idle_maintenance().is_err());
        let batch = imports.batch(&id).unwrap();
        assert!(lifecycle.request_shutdown());
        imports.cancel_all();
        assert!(batch.cancellation.is_cancelled());
        assert!(imports.batch(&id).is_err());
        assert!(imports.begin(&lifecycle).is_err());
        let (sender, receiver) = mpsc::channel();
        let thread = std::thread::spawn(move || {
            lifecycle.wait_until_finished();
            sender.send(()).unwrap();
        });
        assert!(receiver.recv_timeout(Duration::from_millis(30)).is_err());
        drop(batch);
        receiver.recv_timeout(Duration::from_secs(2)).unwrap();
        thread.join().unwrap();
    }

    #[test]
    fn completed_imports_allow_maintenance_and_reject_late_batches() {
        let lifecycle = Arc::new(TaskLifecycle::default());
        let imports = DictionaryImports::default();
        let id = imports.begin(&lifecycle).unwrap();
        imports.finish(&id);
        imports.finish(&id);
        assert!(imports.batch(&id).is_err());
        let maintenance = lifecycle.reserve_idle_maintenance().unwrap();
        assert!(imports.begin(&lifecycle).is_err());
        drop(maintenance);
        assert!(imports.begin(&lifecycle).is_ok());
        imports.cancel_all();
    }
}
