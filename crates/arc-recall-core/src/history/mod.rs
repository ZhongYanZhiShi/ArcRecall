mod grouped;

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
    password_protected    TEXT,
    archive_name          TEXT,
    archive_path          TEXT,
    output_directory      TEXT,
    root_fingerprint_sha256 TEXT,
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
    pub archive_name: Option<String>,
    pub archive_path: Option<String>,
    pub output_directory: Option<String>,
    pub archive_format: String,
    pub file_size: u64,
    pub volume_count: u32,
    pub verified_at_ms: u64,
    pub protected_password: Option<String>,
    pub root_fingerprint_sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredRecoveryPassword {
    pub id: i64,
    pub protected_password: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryHistoryEntry {
    pub id: i64,
    pub fingerprint_prefix: String,
    #[serde(default)]
    pub archive_name: Option<String>,
    #[serde(default)]
    pub archive_path: Option<String>,
    #[serde(default)]
    pub output_directory: Option<String>,
    pub archive_format: String,
    pub file_size: u64,
    pub volume_count: u32,
    pub first_success_at_ms: u64,
    pub last_verified_at_ms: u64,
    pub verification_count: u64,
    pub has_password: bool,
    #[serde(default)]
    pub children: Vec<RecoveryHistoryEntry>,
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
            migrate_password_column(conn)?;
            migrate_location_columns(conn)?;
            grouped::migrate(conn)?;
            Ok(())
        })?;
        Ok(store)
    }

    pub fn database_path(&self) -> &Path {
        &self.path
    }

    pub fn upsert(&self, record: &RecoveryHistoryRecord) -> Result<(), RecoveryHistoryError> {
        self.upsert_many(std::slice::from_ref(record))
    }

    /// Save a group of verified archives atomically using one connection and
    /// transaction. Invalid records leave the entire group unchanged.
    pub fn upsert_many(
        &self,
        records: &[RecoveryHistoryRecord],
    ) -> Result<(), RecoveryHistoryError> {
        if records.is_empty() {
            return Ok(());
        }
        let _guard = self.write_lock.lock().expect("history write lock");
        self.with_connection(|conn| {
            let tx = conn.unchecked_transaction()?;
            for record in records {
                Self::upsert_record(&tx, record)?;
            }
            tx.commit()?;
            Ok(())
        })
    }

    fn upsert_record(
        conn: &Connection,
        record: &RecoveryHistoryRecord,
    ) -> Result<(), RecoveryHistoryError> {
        let fingerprint = normalize_fingerprint(&record.fingerprint_sha256)?;
        let root_fingerprint = record
            .root_fingerprint_sha256
            .as_deref()
            .map(normalize_fingerprint)
            .transpose()?
            .filter(|root| root != &fingerprint);
        let file_size = i64::try_from(record.file_size)
            .map_err(|_| RecoveryHistoryError::InvalidFingerprint)?;
        let verified_at_ms = i64::try_from(record.verified_at_ms)
            .map_err(|_| RecoveryHistoryError::InvalidFingerprint)?;
        let volume_count = i64::from(record.volume_count.max(1));
        let protected_password = record
            .protected_password
            .as_deref()
            .filter(|value| !value.is_empty());

        conn.prepare_cached(
            "INSERT INTO recovery_history (
                    fingerprint_sha256, archive_format, file_size, volume_count,
                    first_success_at_ms, last_verified_at_ms, verification_count, password_protected,
                    archive_name, archive_path, output_directory, root_fingerprint_sha256
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?5, 1, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT(fingerprint_sha256) DO UPDATE SET
                    archive_name = COALESCE(recovery_history.archive_name, excluded.archive_name),
                    archive_path = CASE
                        WHEN excluded.last_verified_at_ms >= recovery_history.last_verified_at_ms
                        THEN COALESCE(excluded.archive_path, recovery_history.archive_path)
                        ELSE recovery_history.archive_path
                    END,
                    output_directory = CASE
                        WHEN excluded.last_verified_at_ms >= recovery_history.last_verified_at_ms
                        THEN COALESCE(excluded.output_directory, recovery_history.output_directory)
                        ELSE recovery_history.output_directory
                    END,
                    root_fingerprint_sha256 = CASE
                        WHEN excluded.last_verified_at_ms >= recovery_history.last_verified_at_ms
                        THEN excluded.root_fingerprint_sha256
                        ELSE recovery_history.root_fingerprint_sha256
                    END,
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
                    password_protected = COALESCE(
                        excluded.password_protected,
                        recovery_history.password_protected
                    );",
        )?
        .execute(params![
            fingerprint,
            record.archive_format,
            file_size,
            volume_count,
            verified_at_ms,
            protected_password,
            record.archive_name,
            record.archive_path,
            record.output_directory,
            root_fingerprint,
        ])?;
        // If a former top-level archive becomes nested, keep its old children
        // attached to the new top-level archive in the same transaction.
        conn.execute(
            "UPDATE recovery_history SET root_fingerprint_sha256 = (
                SELECT root_fingerprint_sha256 FROM recovery_history WHERE fingerprint_sha256 = ?1
             ) WHERE root_fingerprint_sha256 = ?1
               AND (SELECT root_fingerprint_sha256 FROM recovery_history WHERE fingerprint_sha256 = ?1) IS NOT NULL
               AND fingerprint_sha256 <> (SELECT root_fingerprint_sha256 FROM recovery_history WHERE fingerprint_sha256 = ?1);",
            [&fingerprint],
        )?;
        Ok(())
    }

    pub fn list(
        &self,
        query: &RecoveryHistoryQuery,
    ) -> Result<RecoveryHistoryListResult, RecoveryHistoryError> {
        self.with_connection(|conn| grouped::list(conn, query))
    }

    pub fn protected_password_by_fingerprint(
        &self,
        fingerprint_sha256: &str,
    ) -> Result<Option<String>, RecoveryHistoryError> {
        let fingerprint = normalize_fingerprint(fingerprint_sha256)?;
        self.with_connection(|conn| {
            Ok(conn
                .query_row(
                    "SELECT password_protected FROM recovery_history
                     WHERE fingerprint_sha256 = ?1;",
                    [fingerprint],
                    |row| row.get(0),
                )
                .optional()?
                .flatten())
        })
    }

    pub fn protected_password_by_id(
        &self,
        id: i64,
    ) -> Result<Option<String>, RecoveryHistoryError> {
        self.with_connection(|conn| {
            Ok(conn
                .query_row(
                    "SELECT password_protected FROM recovery_history WHERE id = ?1;",
                    [id],
                    |row| row.get(0),
                )
                .optional()?
                .flatten())
        })
    }

    pub fn stored_passwords(&self) -> Result<Vec<StoredRecoveryPassword>, RecoveryHistoryError> {
        self.with_connection(|conn| {
            let mut statement = conn.prepare_cached(
                "SELECT id, password_protected FROM recovery_history
                 WHERE password_protected IS NOT NULL;",
            )?;
            let rows = statement.query_map([], |row| {
                Ok(StoredRecoveryPassword {
                    id: row.get(0)?,
                    protected_password: row.get(1)?,
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(RecoveryHistoryError::from)
        })
    }

    pub fn replace_protected_password(
        &self,
        id: i64,
        protected_password: &str,
    ) -> Result<bool, RecoveryHistoryError> {
        if protected_password.is_empty() {
            return Ok(false);
        }
        let _guard = self.write_lock.lock().expect("history write lock");
        self.with_connection(|conn| {
            Ok(conn.execute(
                "UPDATE recovery_history SET password_protected = ?2 WHERE id = ?1;",
                params![id, protected_password],
            )? > 0)
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
            let deleted = conn.execute("DELETE FROM recovery_history WHERE id = ?1;", [id])? > 0;
            if deleted {
                checkpoint_deleted_content(conn)?;
            }
            Ok(deleted)
        })
    }

    pub fn clear(&self) -> Result<u64, RecoveryHistoryError> {
        let _guard = self.write_lock.lock().expect("history write lock");
        self.with_connection(|conn| {
            let deleted = conn.execute("DELETE FROM recovery_history;", [])? as u64;
            if deleted > 0 {
                checkpoint_deleted_content(conn)?;
            }
            Ok(deleted)
        })
    }

    fn with_connection<T>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, RecoveryHistoryError>,
    ) -> Result<T, RecoveryHistoryError> {
        let conn = Connection::open(&self.path)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch(
            "PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON; PRAGMA journal_mode = WAL;",
        )?;
        f(&conn)
    }
}

fn migrate_password_column(conn: &Connection) -> Result<(), RecoveryHistoryError> {
    let mut statement = conn.prepare("PRAGMA table_info(recovery_history);")?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);

    let has_protected = columns.iter().any(|column| column == "password_protected");
    let has_legacy = columns.iter().any(|column| column == "password_text");
    if !has_protected {
        conn.execute(
            "ALTER TABLE recovery_history ADD COLUMN password_protected TEXT;",
            [],
        )?;
    }
    if has_legacy {
        conn.execute_batch(
            "UPDATE recovery_history
             SET password_protected = COALESCE(password_protected, password_text)
             WHERE password_text IS NOT NULL;
             UPDATE recovery_history SET password_text = NULL WHERE password_text IS NOT NULL;",
        )?;
    }
    Ok(())
}

fn migrate_location_columns(conn: &Connection) -> Result<(), RecoveryHistoryError> {
    let tx = conn.unchecked_transaction()?;
    let columns = {
        let mut statement = tx.prepare("PRAGMA table_info(recovery_history);")?;
        statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?
    };
    for column in ["archive_name", "archive_path", "output_directory"] {
        if !columns.iter().any(|existing| existing == column) {
            tx.execute(
                &format!("ALTER TABLE recovery_history ADD COLUMN {column} TEXT;"),
                [],
            )?;
        }
    }
    tx.commit()?;
    Ok(())
}

fn checkpoint_deleted_content(conn: &Connection) -> Result<(), RecoveryHistoryError> {
    // `secure_delete=ON` clears deleted cells. A WAL truncate is sufficient to
    // remove the journal copy without a full rewrite of the shared database.
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
    Ok(())
}

fn normalize_fingerprint(value: &str) -> Result<String, RecoveryHistoryError> {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.len() != 64 || !normalized.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(RecoveryHistoryError::InvalidFingerprint);
    }
    Ok(normalized)
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
            archive_name: None,
            archive_path: None,
            output_directory: None,
            archive_format: "7z".into(),
            file_size: 1_024,
            volume_count: 1,
            verified_at_ms: timestamp,
            protected_password: password.map(str::to_owned),
            root_fingerprint_sha256: None,
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
                .protected_password_by_fingerprint(&"a".repeat(64))
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
                .protected_password_by_fingerprint(&"b".repeat(64))
                .expect("password")
                .as_deref(),
            Some("saved")
        );
    }

    #[test]
    fn history_preserves_original_name_and_tracks_latest_locations_after_reopening() {
        let (directory, store) = store();
        let mut first = record('a', 100, Some("secret"));
        first.archive_name = Some("原始资料.7z".into());
        first.archive_path = Some(r"C:\Downloads\原始资料.7z".into());
        first.output_directory = Some(r"C:\Downloads\原始资料".into());
        store.upsert(&first).unwrap();
        let mut renamed = record('a', 200, Some("secret"));
        renamed.archive_name = Some("renamed.7z".into());
        renamed.archive_path = Some(r"D:\Archive\renamed.7z".into());
        renamed.output_directory = Some(r"D:\Extracted\资料_100%".into());
        store.upsert(&renamed).unwrap();
        store.upsert(&first).unwrap(); // Older workers must not revert the latest locations.
        drop(store);

        let store = RecoveryHistoryStore::open(directory.path().join("history.db")).unwrap();
        let all = store.list(&RecoveryHistoryQuery::default()).unwrap();
        assert_eq!(all.total_count, 1);
        assert_eq!(all.entries[0].archive_name, first.archive_name);
        assert_eq!(all.entries[0].archive_path, renamed.archive_path);
        assert_eq!(all.entries[0].output_directory, renamed.output_directory);
        for search in ["原始资料", "RENamed", r"D:\Archive", "资料_100%"] {
            let found = store
                .list(&RecoveryHistoryQuery {
                    search_text: search.into(),
                    ..RecoveryHistoryQuery::default()
                })
                .unwrap();
            assert_eq!(found.matched_count, 1, "search: {search}");
            assert_eq!(found.entries.len(), 1);
        }
        let missing = store
            .list(&RecoveryHistoryQuery {
                search_text: "资料_100_".into(),
                ..RecoveryHistoryQuery::default()
            })
            .unwrap();
        assert_eq!(missing.matched_count, 0);
        assert!(missing.entries.is_empty());
    }

    #[test]
    fn history_batch_rolls_back_all_rows_if_any_record_is_invalid() {
        let (_directory, store) = store();
        let mut invalid = record('b', 200, Some("second"));
        invalid.fingerprint_sha256 = "invalid".into();

        assert!(
            store
                .upsert_many(&[record('a', 100, Some("first")), invalid])
                .is_err()
        );
        assert_eq!(
            store
                .list(&RecoveryHistoryQuery::default())
                .unwrap()
                .total_count,
            0
        );
    }

    #[test]
    fn history_batch_preserves_upsert_semantics_for_repeated_fingerprints() {
        let (_directory, store) = store();
        store
            .upsert_many(&[
                record('a', 100, Some("first")),
                record('b', 150, None),
                record('a', 200, Some("updated")),
            ])
            .unwrap();

        let result = store.list(&RecoveryHistoryQuery::default()).unwrap();
        assert_eq!(result.total_count, 2);
        assert_eq!(result.entries[0].verification_count, 2);
        assert_eq!(result.entries[0].first_success_at_ms, 100);
        assert_eq!(result.entries[0].last_verified_at_ms, 200);
        assert_eq!(
            store
                .protected_password_by_fingerprint(&"a".repeat(64))
                .unwrap()
                .as_deref(),
            Some("updated")
        );
    }

    #[test]
    fn migrates_legacy_plaintext_column_into_protected_storage() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("legacy.db");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE recovery_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    fingerprint_sha256 TEXT NOT NULL UNIQUE,
                    archive_format TEXT NOT NULL,
                    file_size INTEGER NOT NULL,
                    volume_count INTEGER NOT NULL,
                    first_success_at_ms INTEGER NOT NULL,
                    last_verified_at_ms INTEGER NOT NULL,
                    verification_count INTEGER NOT NULL,
                    password_text TEXT
                 );
                 INSERT INTO recovery_history VALUES (
                    1,
                    'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
                    'ZIP', 10, 1, 1, 1, 1, 'legacy-secret'
                 );",
            )
            .unwrap();
        drop(connection);

        let store = RecoveryHistoryStore::open(&path).unwrap();

        let legacy = store.list(&RecoveryHistoryQuery::default()).unwrap();
        assert_eq!(legacy.entries[0].archive_name, None);
        assert_eq!(legacy.entries[0].archive_path, None);
        assert_eq!(legacy.entries[0].output_directory, None);
        let mut enriched = record('e', 200, None);
        enriched.archive_name = Some("重新解压.zip".into());
        enriched.archive_path = Some(r"C:\重新解压.zip".into());
        store.upsert(&enriched).unwrap();
        assert_eq!(
            store
                .list(&RecoveryHistoryQuery::default())
                .unwrap()
                .entries[0]
                .archive_name,
            enriched.archive_name
        );

        assert_eq!(
            store.stored_passwords().unwrap()[0].protected_password,
            "legacy-secret"
        );
        let connection = Connection::open(path).unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT password_text FROM recovery_history WHERE id = 1;",
                    [],
                    |row| row.get::<_, Option<String>>(0),
                )
                .unwrap(),
            None
        );
    }

    #[test]
    fn list_supports_custom_page_sizes_above_500() {
        let (_directory, store) = store();
        let records: Vec<_> = (0..1205)
            .map(|index| {
                let mut row = record('a', 100, None);
                row.fingerprint_sha256 = format!("{index:064x}");
                row
            })
            .collect();
        store.upsert_many(&records).unwrap();
        let all = store
            .list(&RecoveryHistoryQuery {
                take: 20_000,
                ..RecoveryHistoryQuery::default()
            })
            .unwrap();
        assert_eq!(all.entries.len(), 1205);
        for size in [50, 100, 500, 1000, 1200] {
            let page = store
                .list(&RecoveryHistoryQuery {
                    skip: size,
                    take: size,
                    ..RecoveryHistoryQuery::default()
                })
                .unwrap();
            assert_eq!(page.entries.len(), size.min(1205 - size) as usize);
            assert_eq!(page.entries[0].id, all.entries[size as usize].id);
            assert_eq!(page.matched_count, 1205);
        }
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

    #[test]
    fn list_keeps_counts_and_rows_consistent_during_background_writes() {
        use std::sync::Barrier;
        use std::sync::atomic::{AtomicBool, Ordering};

        let (_directory, store) = store();
        store.upsert(&record('a', 100, Some("saved"))).unwrap();
        let barrier = Barrier::new(2);
        let stop = AtomicBool::new(false);
        std::thread::scope(|scope| {
            let writer = scope.spawn(|| {
                let mut connection = Connection::open(store.database_path()).unwrap();
                connection
                    .busy_timeout(std::time::Duration::from_secs(5))
                    .unwrap();
                barrier.wait();
                for index in 0..2_000 {
                    if stop.load(Ordering::Acquire) {
                        break;
                    }
                    let tx = connection.transaction().unwrap();
                    tx.execute("DELETE FROM recovery_history;", []).unwrap();
                    for fingerprint in if index % 2 == 0 { "ab" } else { "a" }.chars() {
                        RecoveryHistoryStore::upsert_record(
                            &tx,
                            &record(fingerprint, 100, Some("saved")),
                        )
                        .unwrap();
                    }
                    tx.commit().unwrap();
                }
            });
            barrier.wait();
            let mut mismatch = None;
            for _ in 0..200 {
                let result = store.list(&RecoveryHistoryQuery::default()).unwrap();
                let entry_count = result.entries.len() as u64;
                if result.total_count != entry_count
                    || result.matched_count != entry_count
                    || result.password_count != entry_count
                {
                    mismatch = Some(result);
                    break;
                }
            }
            stop.store(true, Ordering::Release);
            writer.join().unwrap();
            assert!(
                mismatch.is_none(),
                "inconsistent read snapshot: {mismatch:?}"
            );
        });
    }

    #[test]
    fn nested_history_stays_with_root_across_search_pagination_and_deletion() {
        let (_directory, store) = store();
        let mut root = record('a', 100, None);
        root.archive_name = Some("顶层归档.zip".into());
        let mut child = record('b', 100, Some("child-secret"));
        child.archive_name = Some("嵌套归档.zip".into());
        child.root_fingerprint_sha256 = Some(root.fingerprint_sha256.clone());
        let mut sibling = record('c', 100, None);
        sibling.root_fingerprint_sha256 = Some(root.fingerprint_sha256.clone());
        store
            .upsert_many(&[root.clone(), child, sibling, record('d', 200, None)])
            .unwrap();
        let page = store
            .list(&RecoveryHistoryQuery {
                skip: 1,
                take: 1,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(page.total_count, 2);
        assert_eq!(page.entries.len(), 1);
        assert_eq!(
            page.entries[0].archive_name.as_deref(),
            Some("顶层归档.zip")
        );
        assert_eq!(page.entries[0].children.len(), 2);
        assert_eq!(page.password_count, 1);
        let found = store
            .list(&RecoveryHistoryQuery {
                search_text: "嵌套归档".into(),
                take: 1,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(found.matched_count, 1);
        assert_eq!(found.entries[0].id, page.entries[0].id);
        assert_eq!(found.entries[0].children.len(), 2);
        let root_id = found.entries[0].id;
        assert!(store.delete(found.entries[0].children[0].id).unwrap());
        assert_eq!(
            store.list(&Default::default()).unwrap().entries[1]
                .children
                .len(),
            1
        );
        assert!(store.delete(root_id).unwrap());
        let remaining = store.list(&Default::default()).unwrap();
        assert_eq!(remaining.total_count, 2);
        assert!(
            remaining
                .entries
                .iter()
                .all(|entry| entry.children.is_empty())
        );
    }

    #[test]
    fn moving_a_former_root_keeps_its_existing_children_in_the_new_group() {
        let (_directory, store) = store();
        let mut old_root = record('a', 100, None);
        let mut child = record('b', 100, None);
        child.root_fingerprint_sha256 = Some(old_root.fingerprint_sha256.clone());
        store.upsert_many(&[old_root.clone(), child]).unwrap();
        let new_root = record('c', 200, None);
        old_root.root_fingerprint_sha256 = Some(new_root.fingerprint_sha256.clone());
        old_root.verified_at_ms = 200;
        store.upsert_many(&[new_root, old_root]).unwrap();
        let result = store.list(&Default::default()).unwrap();
        assert_eq!(result.total_count, 1);
        assert_eq!(result.entries[0].children.len(), 2);
    }

    #[test]
    fn legacy_history_groups_same_batch_paths_without_matching_neighboring_directories() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("history.db");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(&SCHEMA_SQL.replace("    root_fingerprint_sha256 TEXT,\n", ""))
            .unwrap();
        for (fingerprint, name, archive, output, timestamp) in [
            (
                'a',
                "顶层归档.zip",
                r"D:\输入\顶层归档.zip",
                r"D:\输出\顶层",
                100,
            ),
            (
                'b',
                "嵌套归档.zip",
                "d:/输出/顶层/嵌套归档.zip",
                r"D:\输出\顶层\内层",
                100,
            ),
            (
                'c',
                "独立归档.zip",
                r"D:\输出\顶层-other\独立归档.zip",
                r"D:\输出\独立",
                100,
            ),
            (
                'd',
                "其他批次.zip",
                r"D:\输出\顶层\其他批次.zip",
                r"D:\输出\顶层\其他",
                200,
            ),
        ] {
            conn.execute("INSERT INTO recovery_history (fingerprint_sha256,archive_format,file_size,first_success_at_ms,last_verified_at_ms,archive_name,archive_path,output_directory) VALUES (?1,'ZIP',1,?2,?2,?3,?4,?5)", params![fingerprint.to_string().repeat(64), timestamp, name, archive, output]).unwrap();
        }
        drop(conn);
        let store = RecoveryHistoryStore::open(&path).unwrap();
        let result = store.list(&Default::default()).unwrap();
        assert_eq!(result.total_count, 3);
        let root = result
            .entries
            .iter()
            .find(|entry| entry.archive_name.as_deref() == Some("顶层归档.zip"))
            .unwrap();
        assert_eq!(root.children.len(), 1);
        assert_eq!(
            root.children[0].archive_name.as_deref(),
            Some("嵌套归档.zip")
        );
    }

    #[test]
    fn deleting_history_removes_password_bytes_from_sqlite_files() {
        let (directory, store) = store();
        let secret = "arcrecall-unique-deleted-password-9f0ac8b7";
        store.upsert(&record('e', 100, Some(secret))).unwrap();
        let id = store
            .list(&RecoveryHistoryQuery::default())
            .unwrap()
            .entries[0]
            .id;

        assert!(store.delete(id).unwrap());

        for path in [
            store.database_path().to_path_buf(),
            directory.path().join("history.db-wal"),
            directory.path().join("history.db-shm"),
        ] {
            if path.is_file() {
                let bytes = std::fs::read(path).unwrap();
                assert!(
                    !bytes
                        .windows(secret.len())
                        .any(|window| window == secret.as_bytes())
                );
            }
        }
    }
}
