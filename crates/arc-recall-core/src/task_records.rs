//! Durable, password-free execution records, separate from reusable password history.
use std::path::Path;

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

#[path = "task_record_query.rs"]
mod query;
pub use query::TaskRecordQuery;

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
    pub compression_succeeded: bool,
    #[serde(default)]
    pub compression_verification: Option<CompressionVerification>,
    #[serde(default)]
    pub compression: Option<crate::compression_presets::CompressionRecordOptions>,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CompressionVerification {
    Running,
    Passed,
    Failed,
    Cancelled,
    Interrupted,
}

impl TaskRecordStore {
    pub fn open(path: &Path) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        conn.execute_batch("PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS task_records (id TEXT PRIMARY KEY, started INTEGER NOT NULL, state TEXT NOT NULL, record TEXT NOT NULL, owner_session TEXT);").map_err(|e| e.to_string())?;
        conn.execute_batch("CREATE INDEX IF NOT EXISTS task_records_started_id ON task_records(started DESC, id DESC);").map_err(|e| e.to_string())?;
        Ok(Self(conn))
    }

    pub fn save(&self, record: &TaskRecord) -> Result<(), String> {
        self.save_owned(record, None)
    }

    pub fn find(&self, id: &str) -> Result<Option<TaskRecord>, String> {
        use rusqlite::OptionalExtension;
        let row: Option<(String, String)> = self
            .0
            .query_row(
                "SELECT record,state FROM task_records WHERE id=?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        row.map(|(json, state)| {
            let mut record: TaskRecord = serde_json::from_str(&json).map_err(|e| e.to_string())?;
            record.state = state;
            if record.state == "interrupted"
                && record.compression_verification == Some(CompressionVerification::Running)
            {
                record.compression_verification = Some(CompressionVerification::Interrupted);
            }
            Ok(record)
        })
        .transpose()
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
        self.search(
            &TaskRecordQuery {
                operation,
                failed_only,
                ..Default::default()
            },
            skip,
            100,
        )
    }

    pub fn all(&self) -> Result<Vec<TaskRecord>, String> {
        // A single SQLite read snapshot avoids re-scanning OFFSET pages and
        // cannot skip or duplicate rows if another connection writes records.
        let mut statement = self
            .0
            .prepare("SELECT record,state FROM task_records ORDER BY started DESC,id DESC")
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        rows.map(|row| {
            let (json, state) = row.map_err(|e| e.to_string())?;
            query::decode_record(&json, state)
        })
        .collect()
    }

    pub fn replace_all(&mut self, records: &[TaskRecord]) -> Result<(), String> {
        let tx = self.0.transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM task_records", [])
            .map_err(|e| e.to_string())?;
        for record in records {
            let mut record = record.clone();
            if record.state == "running" {
                record.state = "interrupted".into();
                if record.compression_verification == Some(CompressionVerification::Running) {
                    record.compression_verification = Some(CompressionVerification::Interrupted);
                }
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
    fn ordered_history_uses_an_index_and_full_reads_preserve_ties_and_interrupted_states() {
        let temp = tempfile::tempdir().unwrap();
        let store = TaskRecordStore::open(&temp.path().join("records.db")).unwrap();
        for index in 0..205 {
            store
                .save(&TaskRecord {
                    task_id: format!("task-{index:03}"),
                    started_at_ms: 1,
                    state: "interrupted".into(),
                    compression_verification: Some(CompressionVerification::Running),
                    check_items: vec![TaskCheckItem {
                        path: "测试归档.zip".into(),
                        state: "checking".into(),
                        elapsed_ms: 0,
                        checked_at_ms: None,
                    }],
                    ..Default::default()
                })
                .unwrap();
        }
        let all = store.all().unwrap();
        assert_eq!(all.len(), 205);
        assert_eq!(all[0].task_id, "task-204");
        assert_eq!(all[204].task_id, "task-000");
        assert!(all.iter().all(|row| row.compression_verification
            == Some(CompressionVerification::Interrupted)
            && row.check_items[0].state == "interrupted"));
        let mut query = store.0.prepare("EXPLAIN QUERY PLAN SELECT record,state FROM task_records ORDER BY started DESC,id DESC LIMIT 100").unwrap();
        let plan: Vec<String> = query
            .query_map([], |row| row.get(3))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert!(
            plan.iter().all(|line| !line.contains("TEMP B-TREE")),
            "{plan:?}"
        );
    }

    #[test]
    fn interrupted_records_survive_restart_and_can_be_removed() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("tasks.db");
        let record = TaskRecord {
            compression_succeeded: true,
            compression_verification: Some(CompressionVerification::Running),
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
        assert_eq!(
            rows[0].compression_verification,
            Some(CompressionVerification::Interrupted)
        );
        let found = store.find("task-1").unwrap().unwrap();
        assert_eq!(found.state, "interrupted");
        assert_eq!(
            found.compression_verification,
            Some(CompressionVerification::Interrupted)
        );
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
