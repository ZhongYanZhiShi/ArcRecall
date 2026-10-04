//! Opt-in queue checkpoints. Deliberately excludes passwords, logs and raw task events.
use std::{collections::BTreeMap, fs, io::Write, path::PathBuf, time::UNIX_EPOCH};

use arc_recall_core::{RecoveryComputeMode, analyze_archive};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::AppState;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct QueueEntry {
    id: u32,
    path: String,
    state: QueueState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    options: Option<QueueOptions>,
    #[serde(default)]
    stamp: Option<Vec<SourceStamp>>,
    #[serde(default)]
    blocked_reason: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
enum QueueState {
    Waiting,
    Analyzing,
    Running,
    Success,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QueueOptions {
    output_directory: Option<String>,
    exact_output_directory: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    recursive: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    compute_mode: Option<RecoveryComputeMode>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceStamp {
    path: PathBuf,
    bytes: u64,
    modified_nanos: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Journal {
    version: u32,
    enabled: bool,
    items: Vec<QueueEntry>,
}

pub(crate) struct QueueJournal {
    path: PathBuf,
    // A completed worker wins over a stale renderer checkpoint for the same run.
    finished: BTreeMap<u32, QueueState>,
}

fn source_stamp(path: &str) -> Result<Vec<SourceStamp>, String> {
    let analysis = analyze_archive(path)
        .map_err(|_| "源文件缺失、分卷不完整或归档已不可读，请移除后重新添加。")?;
    analysis
        .volume_paths
        .iter()
        .map(|path| {
            let meta = fs::metadata(path).map_err(|_| "无法读取源文件，请移除后重新添加。")?;
            Ok(SourceStamp {
                path: fs::canonicalize(path).map_err(|e| e.to_string())?,
                bytes: meta.len(),
                modified_nanos: meta
                    .modified()
                    .map_err(|e| e.to_string())?
                    .duration_since(UNIX_EPOCH)
                    .map_err(|e| e.to_string())?
                    .as_nanos()
                    .to_string(),
            })
        })
        .collect()
}

impl QueueJournal {
    pub(crate) fn new(path: PathBuf) -> Self {
        Self {
            path,
            finished: BTreeMap::new(),
        }
    }

    fn read(&self) -> Result<Journal, String> {
        if !self.path.exists() {
            return Ok(Journal {
                version: 1,
                enabled: false,
                items: vec![],
            });
        }
        if fs::metadata(&self.path).map_err(|e| e.to_string())?.len() > 4 * 1024 * 1024 {
            return Err("任务记录过大，请关闭任务记忆后重新启用。".into());
        }
        let journal: Journal =
            serde_json::from_slice(&fs::read(&self.path).map_err(|e| e.to_string())?)
                .map_err(|_| "任务记录损坏，请关闭任务记忆后重新启用。".to_string())?;
        if journal.version != 1 || journal.items.len() > 200 {
            return Err("任务记录版本或数量无效。".into());
        }
        Ok(journal)
    }

    fn write(&self, journal: &Journal) -> Result<(), String> {
        let parent = self.path.parent().ok_or("任务记录目录无效")?;
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
        let content = serde_json::to_vec(journal).map_err(|e| e.to_string())?;
        if content.len() > 4 * 1024 * 1024 {
            return Err("任务记录过大。".into());
        }
        file.write_all(&content).map_err(|e| e.to_string())?;
        file.as_file().sync_all().map_err(|e| e.to_string())?;
        file.persist(&self.path).map_err(|e| e.to_string())?;
        Ok(())
    }

    fn load(&self) -> Result<Journal, String> {
        let mut journal = self.read()?;
        for entry in &mut journal.items {
            if matches!(entry.state, QueueState::Analyzing | QueueState::Running) {
                entry.state = QueueState::Waiting;
            }
            entry.blocked_reason = match source_stamp(&entry.path) {
                Ok(stamp) if entry.stamp.as_ref() == Some(&stamp) => None,
                Ok(_) => Some("源文件或分卷的大小、修改时间已改变，请移除后重新添加。".into()),
                Err(error) => Some(error),
            };
        }
        Ok(journal)
    }

    fn save(&mut self, enabled: bool, mut items: Vec<QueueEntry>) -> Result<(), String> {
        if !enabled {
            match fs::remove_file(&self.path) {
                Ok(()) => (),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                Err(e) => return Err(e.to_string()),
            }
            self.finished.clear();
            return Ok(());
        }
        if items.len() > 200 {
            return Err("单个队列最多保存 200 项。".into());
        }
        let previous = self.read()?;
        let mut ids = std::collections::BTreeSet::new();
        for item in &mut items {
            if !ids.insert(item.id) || item.path.len() > 32768 {
                return Err("任务记录无效。".into());
            }
            if item.stamp.is_none() {
                item.stamp = previous
                    .items
                    .iter()
                    .find(|old| old.id == item.id && old.path == item.path)
                    .and_then(|old| old.stamp.clone());
            }
            if item.stamp.is_none() {
                match source_stamp(&item.path) {
                    Ok(stamp) => item.stamp = Some(stamp),
                    Err(error) => item.blocked_reason = Some(error),
                }
            }
            if item.state == QueueState::Waiting {
                self.finished.remove(&item.id);
            } else if let Some(state) = self.finished.get(&item.id) {
                item.state = *state;
            }
        }
        self.write(&Journal {
            version: 1,
            enabled,
            items,
        })
    }

    pub(crate) fn finish(&mut self, id: u32, success: bool, cancelled: bool) -> Result<(), String> {
        let mut journal = self.read()?;
        if !journal.enabled {
            return Ok(());
        }
        let state = if cancelled {
            QueueState::Cancelled
        } else if success {
            QueueState::Success
        } else {
            QueueState::Failed
        };
        self.finished.insert(id, state);
        if let Some(entry) = journal.items.iter_mut().find(|entry| entry.id == id) {
            entry.state = state;
        }
        self.write(&journal)
    }

    pub(crate) fn validate(&self, id: u32, path: &str) -> Result<(), String> {
        let journal = self.read()?;
        if !journal.enabled {
            return Ok(());
        }
        let entry = journal
            .items
            .iter()
            .find(|entry| entry.id == id)
            .ok_or("未找到任务记录，请重新添加任务。")?;
        if entry.stamp.as_ref() != Some(&source_stamp(path)?) {
            return Err("源文件或分卷已改变，请移除后重新添加。".into());
        }
        Ok(())
    }
}

#[tauri::command]
pub(crate) async fn recovery_queue_load(state: State<'_, AppState>) -> Result<Journal, String> {
    let journal = state.queue_journal.clone();
    let lease = state.lifecycle.begin()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _lease = lease;
        journal.lock().map_err(|e| e.to_string())?.load()
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn recovery_queue_save(
    state: State<'_, AppState>,
    enabled: bool,
    items: Vec<QueueEntry>,
) -> Result<(), String> {
    let journal = state.queue_journal.clone();
    let lease = state.lifecycle.begin()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _lease = lease;
        journal
            .lock()
            .map_err(|e| e.to_string())?
            .save(enabled, items)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &str) -> QueueEntry {
        QueueEntry {
            id: 1,
            path: path.into(),
            state: QueueState::Running,
            options: None,
            stamp: None,
            blocked_reason: None,
        }
    }

    #[test]
    fn opt_in_atomic_replacement_worker_completion_and_disable() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("queue.json");
        let mut store = QueueJournal::new(path.clone());
        assert!(!store.load().unwrap().enabled);
        assert!(!path.exists());
        store.save(true, vec![entry("missing.zip")]).unwrap();
        assert_eq!(store.load().unwrap().items[0].state, QueueState::Waiting);
        assert!(store.load().unwrap().items[0].blocked_reason.is_some());
        store.finish(1, true, false).unwrap();
        store.save(true, vec![entry("missing.zip")]).unwrap();
        assert_eq!(store.load().unwrap().items[0].state, QueueState::Success);
        store.save(false, vec![]).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn rejects_passwords_and_allows_disabling_corrupt_journal() {
        assert!(
            serde_json::from_value::<QueueEntry>(
                serde_json::json!({"id":1,"path":"x","state":"waiting","knownPassword":"secret"})
            )
            .is_err()
        );
        assert!(serde_json::from_value::<QueueEntry>(serde_json::json!({"id":1,"path":"x","state":"waiting","options":{"knownPassword":"secret"}})).is_err());
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("queue.json");
        fs::write(&path, "broken").unwrap();
        let mut store = QueueJournal::new(path);
        assert!(store.load().is_err());
        store.save(false, vec![]).unwrap();
        assert!(!store.load().unwrap().enabled);
    }

    #[test]
    fn restart_detects_changed_and_missing_sources_without_rebaselining_on_save() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("empty.zip");
        let mut bytes = vec![b'P', b'K', 5, 6];
        bytes.resize(22, 0);
        fs::write(&source, &bytes).unwrap();
        let mut store = QueueJournal::new(root.path().join("queue.json"));
        let item = entry(source.to_str().unwrap());
        store.save(true, vec![item.clone()]).unwrap();
        assert!(store.load().unwrap().items[0].blocked_reason.is_none());
        store.validate(1, source.to_str().unwrap()).unwrap();
        // Valid ZIP comment changes size without damaging the container.
        bytes[20] = 1;
        bytes.push(b'x');
        fs::write(&source, bytes).unwrap();
        store.save(true, vec![item]).unwrap();
        assert!(store.validate(1, source.to_str().unwrap()).is_err());
        let reopened = QueueJournal::new(root.path().join("queue.json"));
        assert!(reopened.load().unwrap().items[0].blocked_reason.is_some());
        fs::remove_file(source).unwrap();
        assert!(reopened.load().unwrap().items[0].blocked_reason.is_some());
    }
}
