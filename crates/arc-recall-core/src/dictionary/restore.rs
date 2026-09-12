use std::path::Path;

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;

use super::DictionaryCandidateStore;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseRestoreInfo {
    pub candidate_count: u64,
    pub history_count: u64,
    pub password_count: u64,
}

fn readonly(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("无法读取备份：{error}"))?;
    connection
        .busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|error| error.to_string())?;
    connection
        .execute_batch("PRAGMA trusted_schema=OFF;")
        .map_err(|error| error.to_string())?;
    Ok(connection)
}

/// Prepare a consistent, private snapshot. Later confirmation restores these
/// exact bytes even if the selected file changes in the meantime.
pub fn snapshot_database_restore(
    source: &Path,
    snapshot: &Path,
) -> Result<DatabaseRestoreInfo, String> {
    inspect_database_restore(source)?;
    readonly(source)?
        .execute("VACUUM INTO ?1", [snapshot.to_string_lossy().as_ref()])
        .map_err(|error| error.to_string())?;
    inspect_database_restore(snapshot)
}

pub fn inspect_database_restore(path: &Path) -> Result<DatabaseRestoreInfo, String> {
    let connection = readonly(path)?;
    let validate = || -> rusqlite::Result<DatabaseRestoreInfo> {
        let integrity: String =
            connection.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
        if integrity != "ok" {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let unexpected: u64 = connection.query_row(
            "SELECT COUNT(*) FROM sqlite_schema WHERE type IN ('trigger', 'view') OR (type='table' AND name NOT IN ('dictionary_candidates','recovery_history','sqlite_sequence'))", [], |row| row.get(0))?;
        if unexpected != 0 {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let invalid: u64 = connection.query_row(
            "SELECT COUNT(*) FROM dictionary_candidates WHERE typeof(id) != 'integer' OR id <= 0 OR typeof(candidate_text) != 'text' OR length(CAST(candidate_text AS BLOB)) NOT BETWEEN 1 AND 65536 OR byte_count != length(CAST(candidate_text AS BLOB)) OR typeof(byte_count) != 'integer' OR typeof(success_count) != 'integer' OR success_count < 0", [], |row| row.get(0))?;
        let invalid_history: u64 = connection.query_row(
            "SELECT COUNT(*) FROM recovery_history WHERE typeof(id) != 'integer' OR id <= 0 OR typeof(fingerprint_sha256) != 'text' OR length(fingerprint_sha256) != 64 OR fingerprint_sha256 GLOB '*[^0-9a-fA-F]*' OR archive_format NOT IN ('7z','ZIP','RAR3','RAR5') OR typeof(file_size) != 'integer' OR file_size < 0 OR typeof(volume_count) != 'integer' OR volume_count <= 0 OR typeof(first_success_at_ms) != 'integer' OR first_success_at_ms < 0 OR typeof(last_verified_at_ms) != 'integer' OR last_verified_at_ms < first_success_at_ms OR typeof(verification_count) != 'integer' OR verification_count <= 0 OR (password_protected IS NOT NULL AND typeof(password_protected) != 'text')", [], |row| row.get(0))?;
        if invalid != 0 || invalid_history != 0 {
            return Err(rusqlite::Error::InvalidQuery);
        }
        Ok(DatabaseRestoreInfo {
            candidate_count: connection.query_row(
                "SELECT COUNT(*) FROM dictionary_candidates",
                [],
                |row| row.get(0),
            )?,
            history_count: connection.query_row(
                "SELECT COUNT(*) FROM recovery_history",
                [],
                |row| row.get(0),
            )?,
            password_count: connection.query_row(
                "SELECT COUNT(*) FROM recovery_history WHERE password_protected IS NOT NULL",
                [],
                |row| row.get(0),
            )?,
        })
    };
    validate().map_err(|_| {
        "备份不完整、已损坏或数据库结构不受支持；请选择当前版本创建的 ArcRecall SQLite 备份。"
            .into()
    })
}

impl DictionaryCandidateStore {
    /// Replace only application rows in one transaction, preserving the current
    /// schema and constraints. Callers must exclude concurrent history writes.
    pub fn restore_snapshot(
        &self,
        snapshot: &Path,
        safety_backup: &Path,
    ) -> Result<DatabaseRestoreInfo, String> {
        let info = inspect_database_restore(snapshot)?;
        self.backup(safety_backup)
            .map_err(|error| error.to_string())?;
        let mut connection =
            Connection::open(self.database_path()).map_err(|error| error.to_string())?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|error| error.to_string())?;
        connection
            .execute_batch("PRAGMA trusted_schema=OFF; PRAGMA secure_delete=ON;")
            .map_err(|error| error.to_string())?;
        connection
            .execute(
                "ATTACH DATABASE ?1 AS restore_source",
                [snapshot.to_string_lossy().as_ref()],
            )
            .map_err(|error| error.to_string())?;
        let tx = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        tx.execute_batch("DELETE FROM dictionary_candidates;
            INSERT INTO dictionary_candidates (id,candidate_text,byte_count,success_count) SELECT id,candidate_text,byte_count,success_count FROM restore_source.dictionary_candidates;
            DELETE FROM recovery_history;
            INSERT INTO recovery_history (id,fingerprint_sha256,archive_format,file_size,volume_count,first_success_at_ms,last_verified_at_ms,verification_count,password_protected)
            SELECT id,fingerprint_sha256,archive_format,file_size,volume_count,first_success_at_ms,last_verified_at_ms,verification_count,password_protected FROM restore_source.recovery_history;")
            .map_err(|error| format!("恢复失败，当前数据已回滚：{error}"))?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok(info)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::RecoveryHistoryStore;

    #[test]
    fn snapshot_is_consistent_and_restore_keeps_safety_backup() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.db");
        let source_store = DictionaryCandidateStore::open(&source).unwrap();
        RecoveryHistoryStore::open(&source).unwrap();
        source_store.add_candidates(["one", " two "]).unwrap();
        let snapshot = dir.path().join("snapshot.db");
        assert_eq!(
            snapshot_database_restore(&source, &snapshot)
                .unwrap()
                .candidate_count,
            2
        );
        source_store.add_candidates(["after-preview"]).unwrap();
        let destination = dir.path().join("current.db");
        let target = DictionaryCandidateStore::open(&destination).unwrap();
        RecoveryHistoryStore::open(&destination).unwrap();
        target.add_candidates(["old"]).unwrap();
        let safety = dir.path().join("safety.db");
        target.restore_snapshot(&snapshot, &safety).unwrap();
        assert_eq!(target.count().unwrap(), 2);
        assert_eq!(target.get_value(2).unwrap().as_deref(), Some(" two "));
        assert_eq!(
            DictionaryCandidateStore::open(safety)
                .unwrap()
                .get_value(1)
                .unwrap()
                .as_deref(),
            Some("old")
        );
    }

    #[test]
    fn corrupt_or_wrong_schema_cannot_replace_current_data() {
        let dir = tempfile::tempdir().unwrap();
        let current = DictionaryCandidateStore::open(dir.path().join("current.db")).unwrap();
        current.add_candidates(["keep"]).unwrap();
        let bad = dir.path().join("bad.db");
        std::fs::write(&bad, b"not sqlite").unwrap();
        assert!(
            current
                .restore_snapshot(&bad, &dir.path().join("backup.db"))
                .is_err()
        );
        assert_eq!(current.count().unwrap(), 1);
        std::fs::remove_file(&bad).unwrap();
        Connection::open(&bad)
            .unwrap()
            .execute_batch("CREATE TABLE unrelated (id INTEGER);")
            .unwrap();
        assert!(inspect_database_restore(&bad).is_err());
    }

    #[test]
    fn constraint_failure_rolls_back_deletes_and_keeps_the_safety_backup() {
        let dir = tempfile::tempdir().unwrap();
        let current = dir.path().join("current.db");
        let store = DictionaryCandidateStore::open(&current).unwrap();
        RecoveryHistoryStore::open(&current).unwrap();
        store.add_candidates(["keep"]).unwrap();
        let snapshot = dir.path().join("snapshot.db");
        store.backup(&snapshot).unwrap();
        let connection = Connection::open(&snapshot).unwrap();
        connection.execute_batch("CREATE TABLE duplicate_candidates AS SELECT * FROM dictionary_candidates; DROP TABLE dictionary_candidates; ALTER TABLE duplicate_candidates RENAME TO dictionary_candidates; INSERT INTO dictionary_candidates SELECT * FROM dictionary_candidates;").unwrap();
        drop(connection);
        // Structurally readable but incompatible with the destination's uniqueness constraints.
        let safety = dir.path().join("safety.db");
        assert!(store.restore_snapshot(&snapshot, &safety).is_err());
        assert_eq!(store.count().unwrap(), 1);
        assert_eq!(store.get_value(1).unwrap().as_deref(), Some("keep"));
        assert!(safety.is_file());
    }
}
