use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

pub const DEFAULT_HISTORY_PAGE_SIZE: i64 = 100;
const HASH_PREFIX_LENGTH: usize = 12;

const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS recovery_history (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    fingerprint_sha256    TEXT    NOT NULL COLLATE NOCASE,
    archive_format        TEXT    NOT NULL,
    file_size             INTEGER NOT NULL,
    volume_count          INTEGER NOT NULL DEFAULT 1,
    first_success_at_ms   INTEGER NOT NULL,
    last_verified_at_ms   INTEGER NOT NULL,
    verification_count    INTEGER NOT NULL DEFAULT 1,
    password_text         TEXT,
    CHECK (length(fingerprint_sha256) = 64),
    CHECK (file_size >= 0),
    CHECK (volume_count > 0),
    CHECK (first_success_at_ms >= 0),
    CHECK (last_verified_at_ms >= first_success_at_ms),
    CHECK (verification_count > 0),
    UNIQUE (fingerprint_sha256)
);

CREATE INDEX IF NOT EXISTS ix_recovery_history_last_verified
ON recovery_history(last_verified_at_ms DESC, id DESC);
"#;

#[derive(Debug, thiserror::Error)]
pub enum RecoveryHistoryError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid SHA-256 fingerprint")]
    InvalidFingerprint,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryHistoryRecord {
    pub fingerprint_sha256: String,
    pub archive_format: String,
    pub file_size: u64,
    pub volume_count: u32,
    pub verified_at_ms: u64,
    pub password: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryHistoryEntry {
    pub id: i64,
    pub fingerprint_prefix: String,
    pub archive_format: String,
    pub file_size: u64,
    pub volume_count: u32,
    pub first_success_at_ms: u64,
    pub last_verified_at_ms: u64,
    pub verification_count: u64,
    pub has_password: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryHistoryQuery {
    #[serde(default)]
    pub search_text: String,
    #[serde(default)]
    pub skip: i64,
    #[serde(default = "default_take")]
    pub take: i64,
}

fn default_take() -> i64 {
    DEFAULT_HISTORY_PAGE_SIZE
}

impl Default for RecoveryHistoryQuery {
    fn default() -> Self {
        Self {
            search_text: String::new(),
            skip: 0,
            take: default_take(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryHistoryListResult {
    pub entries: Vec<RecoveryHistoryEntry>,
    pub total_count: u64,
    pub matched_count: u64,
    pub password_count: u64,
}

pub struct RecoveryHistoryStore {
    path: PathBuf,
    write_lock: Mutex<()>,
}

impl RecoveryHistoryStore {
    pub fn open(database_path: impl Into<PathBuf>) -> Result<Self, RecoveryHistoryError> {
        let path = database_path.into();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let store = Self {
            path,
            write_lock: Mutex::new(()),
        };
        store.with_connection(|conn| {
            conn.execute_batch(SCHEMA_SQL)?;
            Ok(())
        })?;
        Ok(store)
    }

    pub fn database_path(&self) -> &Path {
        &self.path
    }

    pub fn upsert(&self, record: &RecoveryHistoryRecord) -> Result<(), RecoveryHistoryError> {
        let fingerprint = normalize_fingerprint(&record.fingerprint_sha256)?;
        let file_size = i64::try_from(record.file_size)
            .map_err(|_| RecoveryHistoryError::InvalidFingerprint)?;
        let verified_at_ms = i64::try_from(record.verified_at_ms)
            .map_err(|_| RecoveryHistoryError::InvalidFingerprint)?;
        let volume_count = i64::from(record.volume_count.max(1));
        let password = record.password.as_deref().filter(|value| !value.is_empty());

        let _guard = self.write_lock.lock().expect("history write lock");
        self.with_connection(|conn| {
            conn.execute(
                "INSERT INTO recovery_history (
                    fingerprint_sha256, archive_format, file_size, volume_count,
                    first_success_at_ms, last_verified_at_ms, password_text
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)
                 ON CONFLICT(fingerprint_sha256) DO UPDATE SET
                    archive_format = excluded.archive_format,
                    file_size = excluded.file_size,
                    volume_count = excluded.volume_count,
                    last_verified_at_ms = MAX(
                        recovery_history.last_verified_at_ms,
                        excluded.last_verified_at_ms
                    ),
                    verification_count = CASE
                        WHEN recovery_history.verification_count < 9223372036854775807
                        THEN recovery_history.verification_count + 1
                        ELSE 9223372036854775807
                    END,
                    password_text = COALESCE(
                        excluded.password_text,
                        recovery_history.password_text
                    );",
                params![
                    fingerprint,
                    record.archive_format,
                    file_size,
                    volume_count,
                    verified_at_ms,
                    password,
                ],
            )?;
            Ok(())
        })
    }

    pub fn list(
        &self,
        query: &RecoveryHistoryQuery,
    ) -> Result<RecoveryHistoryListResult, RecoveryHistoryError> {
        self.with_connection(|conn| {
            let search = query.search_text.trim().to_ascii_lowercase();
            let skip = query.skip.max(0);
            let take = query.take.clamp(1, 500);

            let total_count = count_query(conn, "SELECT COUNT(*) FROM recovery_history;", None)?;
            let password_count = count_query(
                conn,
                "SELECT COUNT(*) FROM recovery_history WHERE password_text IS NOT NULL;",
                None,
            )?;
            let matched_count = count_query(
                conn,
                "SELECT COUNT(*) FROM recovery_history
                 WHERE ?1 = '' OR instr(fingerprint_sha256, ?1) = 1;",
                Some(&search),
            )?;

            let mut statement = conn.prepare_cached(
                "SELECT
                    id,
                    substr(fingerprint_sha256, 1, ?2),
                    archive_format,
                    file_size,
                    volume_count,
                    first_success_at_ms,
                    last_verified_at_ms,
                    verification_count,
                    password_text IS NOT NULL
                 FROM recovery_history
                 WHERE ?1 = '' OR instr(fingerprint_sha256, ?1) = 1
                 ORDER BY last_verified_at_ms DESC, id DESC
                 LIMIT ?3 OFFSET ?4;",
            )?;
            let rows = statement.query_map(
                params![search, HASH_PREFIX_LENGTH as i64, take, skip],
                |row| {
                    Ok(RecoveryHistoryEntry {
                        id: row.get(0)?,
                        fingerprint_prefix: row.get(1)?,
                        archive_format: row.get(2)?,
                        file_size: row.get::<_, i64>(3)?.max(0) as u64,
                        volume_count: row.get::<_, i64>(4)?.max(1) as u32,
                        first_success_at_ms: row.get::<_, i64>(5)?.max(0) as u64,
                        last_verified_at_ms: row.get::<_, i64>(6)?.max(0) as u64,
                        verification_count: row.get::<_, i64>(7)?.max(0) as u64,
                        has_password: row.get(8)?,
                    })
                },
            )?;
            let entries = rows.collect::<Result<Vec<_>, _>>()?;

            Ok(RecoveryHistoryListResult {
                entries,
                total_count,
                matched_count,
                password_count,
            })
        })
    }

    pub fn password_by_fingerprint(
        &self,
        fingerprint_sha256: &str,
    ) -> Result<Option<String>, RecoveryHistoryError> {
        let fingerprint = normalize_fingerprint(fingerprint_sha256)?;
        self.with_connection(|conn| {
            Ok(conn
                .query_row(
                    "SELECT password_text FROM recovery_history
                     WHERE fingerprint_sha256 = ?1;",
                    [fingerprint],
                    |row| row.get(0),
                )
                .optional()?
                .flatten())
        })
    }

    pub fn password_by_id(&self, id: i64) -> Result<Option<String>, RecoveryHistoryError> {
        self.with_connection(|conn| {
            Ok(conn
                .query_row(
                    "SELECT password_text FROM recovery_history WHERE id = ?1;",
                    [id],
                    |row| row.get(0),
                )
                .optional()?
                .flatten())
        })
    }

    pub fn contains(&self, fingerprint_sha256: &str) -> Result<bool, RecoveryHistoryError> {
        let fingerprint = normalize_fingerprint(fingerprint_sha256)?;
        self.with_connection(|conn| {
            let found = conn.query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM recovery_history WHERE fingerprint_sha256 = ?1
                 );",
                [fingerprint],
                |row| row.get(0),
            )?;
            Ok(found)
        })
    }

    pub fn delete(&self, id: i64) -> Result<bool, RecoveryHistoryError> {
        let _guard = self.write_lock.lock().expect("history write lock");
        self.with_connection(|conn| {
            Ok(conn.execute("DELETE FROM recovery_history WHERE id = ?1;", [id])? > 0)
        })
    }

    pub fn clear(&self) -> Result<u64, RecoveryHistoryError> {
        let _guard = self.write_lock.lock().expect("history write lock");
        self.with_connection(|conn| Ok(conn.execute("DELETE FROM recovery_history;", [])? as u64))
    }

    fn with_connection<T>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, RecoveryHistoryError>,
    ) -> Result<T, RecoveryHistoryError> {
        let conn = Connection::open(&self.path)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")?;
        f(&conn)
    }
}

fn normalize_fingerprint(value: &str) -> Result<String, RecoveryHistoryError> {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.len() != 64 || !normalized.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(RecoveryHistoryError::InvalidFingerprint);
    }
    Ok(normalized)
}

fn count_query(
    conn: &Connection,
    sql: &str,
    value: Option<&str>,
) -> Result<u64, RecoveryHistoryError> {
    let count: i64 = match value {
        Some(value) => conn.query_row(sql, [value], |row| row.get(0))?,
        None => conn.query_row(sql, [], |row| row.get(0))?,
    };
    Ok(count.max(0) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, RecoveryHistoryStore) {
        let directory = tempfile::tempdir().expect("tempdir");
        let store =
            RecoveryHistoryStore::open(directory.path().join("history.db")).expect("open store");
        (directory, store)
    }

    fn record(fingerprint: char, timestamp: u64, password: Option<&str>) -> RecoveryHistoryRecord {
        RecoveryHistoryRecord {
            fingerprint_sha256: fingerprint.to_string().repeat(64),
            archive_format: "7z".into(),
            file_size: 1_024,
            volume_count: 1,
            verified_at_ms: timestamp,
            password: password.map(str::to_owned),
        }
    }

    #[test]
    fn upsert_preserves_first_time_and_updates_latest_password() {
        let (_directory, store) = store();
        store
            .upsert(&record('a', 100, Some("first")))
            .expect("insert");
        store
            .upsert(&record('a', 250, Some("second")))
            .expect("update");

        let result = store.list(&RecoveryHistoryQuery::default()).expect("list");
        assert_eq!(result.total_count, 1);
        assert_eq!(result.password_count, 1);
        assert_eq!(result.entries[0].first_success_at_ms, 100);
        assert_eq!(result.entries[0].last_verified_at_ms, 250);
        assert_eq!(result.entries[0].verification_count, 2);
        assert_eq!(
            store
                .password_by_fingerprint(&"a".repeat(64))
                .expect("password")
                .as_deref(),
            Some("second")
        );
    }

    #[test]
    fn null_password_does_not_erase_an_existing_password() {
        let (_directory, store) = store();
        store
            .upsert(&record('b', 100, Some("saved")))
            .expect("insert");
        store.upsert(&record('b', 200, None)).expect("update");

        assert_eq!(
            store
                .password_by_fingerprint(&"b".repeat(64))
                .expect("password")
                .as_deref(),
            Some("saved")
        );
    }

    #[test]
    fn list_searches_by_prefix_and_delete_clear_remove_passwords() {
        let (_directory, store) = store();
        store.upsert(&record('c', 100, Some("one"))).expect("first");
        store.upsert(&record('d', 200, None)).expect("second");

        let filtered = store
            .list(&RecoveryHistoryQuery {
                search_text: "cccc".into(),
                ..RecoveryHistoryQuery::default()
            })
            .expect("filtered");
        assert_eq!(filtered.matched_count, 1);
        assert_eq!(filtered.entries[0].fingerprint_prefix, "c".repeat(12));

        assert!(store.delete(filtered.entries[0].id).expect("delete"));
        assert_eq!(store.clear().expect("clear"), 1);
        assert_eq!(
            store
                .list(&RecoveryHistoryQuery::default())
                .expect("empty")
                .total_count,
            0
        );
    }
}
