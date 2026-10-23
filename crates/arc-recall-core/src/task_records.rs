//! Durable, password-free execution records, separate from reusable password history.
use std::path::Path;

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRecord {
    pub task_id: String,
    pub archive_path: String,
    pub output_directory: String,
    pub started_at_ms: u64,
    pub elapsed_ms: u64,
    pub state: String,
    pub failure_kind: Option<String>,
    pub recursive: bool,
    pub compute_mode: String,
    pub dictionary_group: Option<String>,
    pub pending_archive_paths: Vec<String>,
    pub skipped_scan_directories: Vec<String>,
}

pub struct TaskRecordStore(Connection);

impl TaskRecordStore {
    pub fn open(path: &Path) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        conn.execute_batch("PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS task_records (id TEXT PRIMARY KEY, started INTEGER NOT NULL, state TEXT NOT NULL, record TEXT NOT NULL, owner_session TEXT);").map_err(|e| e.to_string())?;
        Ok(Self(conn))
    }

    pub fn save(&self, record: &TaskRecord) -> Result<(), String> {
        self.save_owned(record, None)
    }

    pub fn save_for_session(&self, record: &TaskRecord, session: &Path) -> Result<(), String> {
        self.save_owned(record, Some(session))
    }

    fn save_owned(&self, record: &TaskRecord, session: Option<&Path>) -> Result<(), String> {
        let json = serde_json::to_string(record).map_err(|e| e.to_string())?;
        self.0.execute("INSERT INTO task_records VALUES (?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET state=excluded.state, record=excluded.record, owner_session=excluded.owner_session", params![record.task_id, record.started_at_ms, record.state, json, session.map(|path| path.to_string_lossy().into_owned())]).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list(&self, skip: u32, failed_only: bool) -> Result<Vec<TaskRecord>, String> {
        let mut stmt = self.0.prepare("SELECT record, state FROM task_records WHERE ?1=0 OR state NOT IN ('success','running') ORDER BY started DESC, id DESC LIMIT 100 OFFSET ?2").map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![failed_only, skip], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        rows.map(|row| {
            let (json, state) = row.map_err(|e| e.to_string())?;
            let mut record: TaskRecord = serde_json::from_str(&json).map_err(|e| e.to_string())?;
            record.state = state;
            Ok(record)
        })
        .collect()
    }

    pub fn interrupt_running(&self) -> Result<(), String> {
        let mut statement = self
            .0
            .prepare("SELECT id, owner_session FROM task_records WHERE state='running'")
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        drop(statement);
        for (id, session) in rows {
            let abandoned = match session {
                None => true,
                Some(path) => match std::fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(Path::new(&path).join("owner.lock"))
                {
                    Ok(owner) => owner.try_lock().is_ok(),
                    Err(error) => error.kind() == std::io::ErrorKind::NotFound,
                },
            };
            if abandoned {
                self.0.execute("UPDATE task_records SET state='interrupted' WHERE id=?1 AND state='running'", [id]).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        self.0
            .execute(
                "DELETE FROM task_records WHERE id=?1 AND state!='running'",
                [id],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn interrupted_records_survive_restart_and_can_be_removed() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("tasks.db");
        let record = TaskRecord {
            task_id: "task-1".into(),
            archive_path: "嵌套归档.zip".into(),
            output_directory: "输出".into(),
            started_at_ms: 1,
            elapsed_ms: 0,
            state: "running".into(),
            failure_kind: None,
            recursive: true,
            compute_mode: "cpuOnly".into(),
            dictionary_group: Some("测试分组".into()),
            pending_archive_paths: vec![],
            skipped_scan_directories: vec![],
        };
        TaskRecordStore::open(&path).unwrap().save(&record).unwrap();
        let store = TaskRecordStore::open(&path).unwrap();
        let owner = std::fs::File::create(temp.path().join("owner.lock")).unwrap();
        owner.lock().unwrap();
        store.save_for_session(&record, temp.path()).unwrap();
        store.interrupt_running().unwrap();
        assert_eq!(store.list(0, false).unwrap()[0].state, "running");
        drop(owner);
        store.interrupt_running().unwrap();
        let rows = store.list(0, true).unwrap();
        assert_eq!(rows[0].state, "interrupted");
        assert_eq!(rows[0].dictionary_group, record.dictionary_group);
        assert!(store.list(100, false).unwrap().is_empty());
        store.delete("task-1").unwrap();
        assert!(store.list(0, false).unwrap().is_empty());
    }
}
