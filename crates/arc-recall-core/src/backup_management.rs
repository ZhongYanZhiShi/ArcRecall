//! Local scheduling policy and ownership catalog; deliberately excluded from portable backups.
use crate::{AppPaths, DictionaryCandidateStore, SettingsStore, backup};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupPolicy {
    pub enabled: bool,
    pub directory: Option<PathBuf>,
    pub interval_hours: u32,
    pub keep_count: usize,
}
impl Default for BackupPolicy {
    fn default() -> Self {
        Self {
            enabled: false,
            directory: None,
            interval_hours: 24,
            keep_count: 7,
        }
    }
}
impl BackupPolicy {
    pub fn validate(&self) -> Result<(), String> {
        if !matches!(self.interval_hours, 24 | 168)
            || !(1..=100).contains(&self.keep_count)
            || self.directory.as_ref().is_some_and(|p| !p.is_absolute())
            || (self.enabled && self.directory.is_none())
        {
            return Err("请选择绝对备份目录、每天或每周频率，以及 1–100 份保留数量。".into());
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BackupStatus {
    pub policy: BackupPolicy,
    pub last_attempt_ms: Option<u64>,
    pub last_success_ms: Option<u64>,
    pub last_error: Option<String>,
}
impl BackupStatus {
    pub fn due(&self, now: u64) -> bool {
        self.policy.enabled
            && self.last_success_ms.is_none_or(|last| {
                now.saturating_sub(last) >= u64::from(self.policy.interval_hours) * 3_600_000
            })
            && self
                .last_attempt_ms
                .is_none_or(|last| now.saturating_sub(last) >= 300_000)
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupEntry {
    pub path: PathBuf,
    pub created_at_ms: u64,
    pub byte_count: u64,
    pub automatic: bool,
    pub exists: bool,
}
pub struct BackupManager(Connection);
impl BackupManager {
    pub fn open(root: &Path) -> Result<Self, String> {
        let db = Connection::open(root.join("backup-management.db")).map_err(|e| e.to_string())?;
        db.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        db.execute_batch("CREATE TABLE IF NOT EXISTS config (id INTEGER PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS backups (path TEXT PRIMARY KEY, created INTEGER NOT NULL, bytes INTEGER NOT NULL, digest TEXT NOT NULL);").map_err(|e| e.to_string())?;
        Ok(Self(db))
    }
    pub fn status(&self) -> Result<BackupStatus, String> {
        let json: Option<String> = self
            .0
            .query_row("SELECT value FROM config WHERE id=1", [], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        let status: BackupStatus = json
            .map(|s| serde_json::from_str(&s))
            .transpose()
            .map_err(|e| e.to_string())?
            .unwrap_or_default();
        status.policy.validate()?;
        Ok(status)
    }
    fn save_status(&self, status: &BackupStatus) -> Result<(), String> {
        self.0.execute("INSERT INTO config VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET value=excluded.value", [serde_json::to_string(status).map_err(|e| e.to_string())?]).map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn configure(&self, policy: BackupPolicy) -> Result<BackupStatus, String> {
        policy.validate()?;
        let mut status = self.status()?;
        if status.policy.directory != policy.directory {
            status.last_success_ms = None;
            status.last_attempt_ms = None;
            status.last_error = None;
        }
        status.policy = policy;
        self.save_status(&status)?;
        Ok(status)
    }
    pub fn list(&self) -> Result<Vec<BackupEntry>, String> {
        let mut stmt = self
            .0
            .prepare("SELECT path, created, bytes FROM backups ORDER BY created DESC, path DESC")
            .map_err(|e| e.to_string())?;
        stmt.query_map([], |r| {
            let path = PathBuf::from(r.get::<_, String>(0)?);
            Ok(BackupEntry {
                exists: path.is_file(),
                path,
                created_at_ms: r.get(1)?,
                byte_count: r.get(2)?,
                automatic: true,
            })
        })
        .map_err(|e| e.to_string())?
        .map(|r| r.map_err(|e| e.to_string()))
        .collect()
    }
    pub fn run(
        &self,
        paths: &AppPaths,
        dictionary: &DictionaryCandidateStore,
        settings: &SettingsStore,
        now: u64,
        force: bool,
    ) -> Result<bool, String> {
        let mut status = self.status()?;
        if !force && !status.due(now) {
            return Ok(false);
        }
        let directory = status
            .policy
            .directory
            .clone()
            .ok_or("请先设置自动备份目录。")?;
        status.last_attempt_ms = Some(now);
        self.save_status(&status)?;
        let result = (|| {
            fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
            let directory = directory.canonicalize().map_err(|e| e.to_string())?;
            let destination = (0..1000)
                .map(|i| directory.join(format!("arcrecall-auto-{now}-{i}.arcrecall")))
                .find(|p| !p.exists())
                .ok_or("无法创建唯一备份名称。")?;
            let bytes = backup::create(paths, dictionary, settings, &destination)?;
            let digest = file_digest(&destination)?;
            self.0
                .execute(
                    "INSERT INTO backups VALUES(?1,?2,?3,?4)",
                    params![destination.to_string_lossy(), now, bytes, digest],
                )
                .map_err(|e| e.to_string())?;
            Ok::<_, String>(directory)
        })();
        match result {
            Ok(directory) => {
                status.last_success_ms = Some(now);
                status.last_error = self.prune(&directory, status.policy.keep_count).err();
                self.save_status(&status)?;
                Ok(true)
            }
            Err(error) => {
                status.last_error = Some(format!("自动备份失败：{error}"));
                self.save_status(&status)?;
                Err(error)
            }
        }
    }
    fn prune(&self, directory: &Path, keep: usize) -> Result<(), String> {
        let entries: Vec<_> = self
            .list()?
            .into_iter()
            .filter(|e| e.path.parent() == Some(directory))
            .collect();
        let mut warning = false;
        let mut retained = 0;
        for entry in entries {
            if !entry.path.exists() {
                self.0
                    .execute(
                        "DELETE FROM backups WHERE path=?1",
                        [entry.path.to_string_lossy()],
                    )
                    .map_err(|e| e.to_string())?;
                continue;
            }
            if retained < keep {
                retained += 1;
                continue;
            }
            let expected: String = self
                .0
                .query_row(
                    "SELECT digest FROM backups WHERE path=?1",
                    [entry.path.to_string_lossy()],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            // Never delete a file replaced since creation, a link, or a file redirected outside its registered directory.
            if fs::symlink_metadata(&entry.path)
                .map_err(|e| e.to_string())?
                .file_type()
                .is_symlink()
                || entry
                    .path
                    .canonicalize()
                    .map_err(|e| e.to_string())?
                    .parent()
                    != Some(directory)
                || file_digest(&entry.path)? != expected
            {
                warning = true;
                continue;
            }
            fs::remove_file(&entry.path).map_err(|e| e.to_string())?;
            self.0
                .execute(
                    "DELETE FROM backups WHERE path=?1",
                    [entry.path.to_string_lossy()],
                )
                .map_err(|e| e.to_string())?;
        }
        if warning {
            Err("备份已完成；部分旧文件已被更改，保留策略未删除这些文件。".into())
        } else {
            Ok(())
        }
    }
}
fn file_digest(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut digest = Sha256::new();
    let mut buffer = [0; 65536];
    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(hex::encode(digest.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn due_schedule_catches_up_after_restart_and_backs_off_failures() {
        let mut s = BackupStatus::default();
        assert!(!s.due(1));
        s.policy.enabled = true;
        assert!(s.due(1));
        s.last_attempt_ms = Some(1);
        assert!(!s.due(299_999));
        assert!(s.due(300_001));
        s.last_success_ms = Some(1);
        assert!(!s.due(300_001));
        assert!(s.due(86_400_001));
    }
    #[test]
    fn retention_only_removes_owned_unchanged_automatic_backups() {
        let dir = tempfile::tempdir().unwrap();
        let paths = AppPaths::from_root(dir.path());
        paths.ensure_dirs().unwrap();
        let dictionary = DictionaryCandidateStore::open(&paths.database).unwrap();
        crate::RecoveryHistoryStore::open(&paths.database).unwrap();
        let settings = SettingsStore::open(&paths.settings).unwrap();
        let manager = BackupManager::open(&paths.root).unwrap();
        manager
            .configure(BackupPolicy {
                enabled: true,
                directory: Some(paths.exports.clone()),
                keep_count: 1,
                ..Default::default()
            })
            .unwrap();
        let manual = paths.exports.join("manual.arcrecall");
        fs::write(&manual, "keep").unwrap();
        manager
            .run(&paths, &dictionary, &settings, 1, false)
            .unwrap();
        let first = manager.list().unwrap()[0].path.clone();
        assert!(
            !manager
                .run(&paths, &dictionary, &settings, 2, false)
                .unwrap()
        );
        manager
            .run(&paths, &dictionary, &settings, 3, true)
            .unwrap();
        assert!(!first.exists());
        assert!(manual.exists());
        let changed = manager.list().unwrap()[0].path.clone();
        fs::write(&changed, "user replacement").unwrap();
        manager
            .run(&paths, &dictionary, &settings, 4, true)
            .unwrap();
        assert!(changed.exists());
        assert!(manager.status().unwrap().last_error.is_some());
        drop(manager);
        assert_eq!(
            BackupManager::open(&paths.root)
                .unwrap()
                .status()
                .unwrap()
                .last_success_ms,
            Some(4)
        );
    }

    #[test]
    fn failed_backup_preserves_existing_files_and_persists_retry_backoff() {
        let dir = tempfile::tempdir().unwrap();
        let paths = AppPaths::from_root(dir.path());
        paths.ensure_dirs().unwrap();
        let dictionary = DictionaryCandidateStore::open(&paths.database).unwrap();
        crate::RecoveryHistoryStore::open(&paths.database).unwrap();
        let settings = SettingsStore::open(&paths.settings).unwrap();
        let manager = BackupManager::open(&paths.root).unwrap();
        let unavailable = paths.exports.join("被文件占用的目录");
        fs::write(&unavailable, "preserve").unwrap();
        manager
            .configure(BackupPolicy {
                enabled: true,
                directory: Some(unavailable.clone()),
                ..Default::default()
            })
            .unwrap();
        assert!(
            manager
                .run(&paths, &dictionary, &settings, 1000, false)
                .is_err()
        );
        let status = manager.status().unwrap();
        assert!(status.last_error.is_some());
        assert!(status.last_success_ms.is_none());
        assert!(!status.due(1001));
        assert!(status.due(301000));
        assert_eq!(fs::read_to_string(&unavailable).unwrap(), "preserve");
        assert!(manager.list().unwrap().is_empty());
        assert!(
            manager
                .configure(BackupPolicy {
                    keep_count: 0,
                    ..Default::default()
                })
                .is_err()
        );
    }

    #[test]
    fn missing_recent_backup_does_not_consume_a_retention_slot() {
        let dir = tempfile::tempdir().unwrap();
        let paths = AppPaths::from_root(dir.path());
        paths.ensure_dirs().unwrap();
        let dictionary = DictionaryCandidateStore::open(&paths.database).unwrap();
        crate::RecoveryHistoryStore::open(&paths.database).unwrap();
        let settings = SettingsStore::open(&paths.settings).unwrap();
        let manager = BackupManager::open(&paths.root).unwrap();
        manager
            .configure(BackupPolicy {
                directory: Some(paths.exports.clone()),
                keep_count: 2,
                ..Default::default()
            })
            .unwrap();
        manager
            .run(&paths, &dictionary, &settings, 1, true)
            .unwrap();
        let oldest = manager.list().unwrap()[0].path.clone();
        manager
            .run(&paths, &dictionary, &settings, 2, true)
            .unwrap();
        fs::remove_file(&manager.list().unwrap()[0].path).unwrap();
        manager
            .run(&paths, &dictionary, &settings, 3, true)
            .unwrap();
        assert!(oldest.exists());
        assert_eq!(manager.list().unwrap().len(), 2);
    }
}
