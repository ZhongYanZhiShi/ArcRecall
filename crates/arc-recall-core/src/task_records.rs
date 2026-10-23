//! Durable, password-free execution records, separate from reusable password history.
use std::path::Path;

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskOperation {
    #[default]
    Recovery,
    Compression,
    SelectiveExtraction,
    IntegrityCheck,
    BatchIntegrityCheck,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskCheckItem {
    pub path: String,
    pub state: String,
    pub elapsed_ms: u64,
    pub checked_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskRecord {
    #[serde(default)]
    pub operation: TaskOperation,
    #[serde(default)]
    pub source_paths: Vec<String>,
    #[serde(default)]
    pub selected_paths: Vec<String>,
    #[serde(default)]
    pub output_path: Option<String>,
    #[serde(default)]
    pub check_items: Vec<TaskCheckItem>,
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
        self.list_filtered(skip, failed_only, None)
    }

    pub fn list_filtered(
        &self,
        skip: u32,
        failed_only: bool,
        operation: Option<TaskOperation>,
    ) -> Result<Vec<TaskRecord>, String> {
        let operation = operation.map(|op| {
            serde_json::to_value(op)
                .unwrap()
                .as_str()
                .unwrap()
                .to_string()
        });
        let mut stmt = self.0.prepare("SELECT record, state FROM task_records WHERE (?1=0 OR state NOT IN ('success','running')) AND (?3 IS NULL OR COALESCE(json_extract(record,'$.operation'),'recovery')=?3) ORDER BY started DESC, id DESC LIMIT 100 OFFSET ?2").map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![failed_only, skip, operation], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        rows.map(|row| {
            let (json, state) = row.map_err(|e| e.to_string())?;
            let mut record: TaskRecord = serde_json::from_str(&json).map_err(|e| e.to_string())?;
            record.state = state;
            if record.state == "interrupted" {
                for item in &mut record.check_items {
                    if matches!(item.state.as_str(), "waiting" | "checking") {
                        item.state = "interrupted".into();
                    }
                }
            }
            Ok(record)
        })
        .collect()
    }

    pub fn all(&self) -> Result<Vec<TaskRecord>, String> {
        let mut result = Vec::new();
        loop {
            let page = self.list(result.len() as u32, false)?;
            let done = page.len() < 100;
            result.extend(page);
            if done {
                return Ok(result);
            }
        }
    }

    pub fn replace_all(&mut self, records: &[TaskRecord]) -> Result<(), String> {
        let tx = self.0.transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM task_records", [])
            .map_err(|e| e.to_string())?;
        for record in records {
            let mut record = record.clone();
            if record.state == "running" {
                record.state = "interrupted".into();
            }
            let json = serde_json::to_string(&record).map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT INTO task_records VALUES (?1,?2,?3,?4,NULL)",
                params![record.task_id, record.started_at_ms, record.state, json],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
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
            ..TaskRecord::default()
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
    #[test]
    fn operation_filters_apply_before_pagination_and_old_rows_default_to_recovery() {
        let temp = tempfile::tempdir().unwrap();
        let store = TaskRecordStore::open(&temp.path().join("records.db")).unwrap();
        for index in 0..205 {
            let record = TaskRecord {
                task_id: format!("task-{index}"),
                started_at_ms: index,
                state: "success".into(),
                operation: if index % 2 == 0 {
                    TaskOperation::Compression
                } else {
                    TaskOperation::IntegrityCheck
                },
                ..Default::default()
            };
            store.save(&record).unwrap();
        }
        let old = TaskRecord {
            task_id: "legacy".into(),
            state: "failed".into(),
            ..Default::default()
        };
        let mut json = serde_json::to_value(old).unwrap();
        json.as_object_mut().unwrap().remove("operation");
        store
            .0
            .execute(
                "INSERT INTO task_records VALUES ('legacy',0,'failed',?1,NULL)",
                [json.to_string()],
            )
            .unwrap();
        assert_eq!(store.all().unwrap().len(), 206);
        assert_eq!(
            store
                .list_filtered(100, false, Some(TaskOperation::Compression))
                .unwrap()
                .len(),
            3
        );
        assert_eq!(
            store
                .list_filtered(0, true, Some(TaskOperation::Recovery))
                .unwrap()[0]
                .task_id,
            "legacy"
        );
        assert!(
            store
                .list_filtered(0, true, Some(TaskOperation::Compression))
                .unwrap()
                .is_empty()
        );
    }
}
