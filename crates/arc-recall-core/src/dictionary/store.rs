use std::fs::File;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension, params};

use super::models::{
    DictionaryCandidateAddSummary, DictionaryCandidateEntry, DictionaryCandidateQuery,
    DictionaryListResult,
};

/// Max UTF-8 byte length of a single candidate (matches original ArcRecall).
pub const MAX_CANDIDATE_BYTES: usize = 64 * 1024;

/// Default page size for the dictionary library UI.
pub const DEFAULT_PAGE_SIZE: i64 = 500;

/// Batch size when importing a text dictionary file.
const IMPORT_BATCH_SIZE: usize = 4096;

const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS dictionary_candidates (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_text  TEXT    NOT NULL COLLATE BINARY,
    byte_count      INTEGER NOT NULL,
    success_count   INTEGER NOT NULL DEFAULT 0,
    CHECK (byte_count >= 0),
    CHECK (success_count >= 0),
    UNIQUE (candidate_text)
);

CREATE INDEX IF NOT EXISTS ix_dictionary_candidates_insertion_order
ON dictionary_candidates(id);
"#;

/// Errors from the global dictionary candidate store.
#[derive(Debug, thiserror::Error)]
pub enum DictionaryError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("dictionary source not found: {0}")]
    NotFound(String),
}

/// Thread-safe SQLite-backed global password candidate set.
///
/// Candidates are stored as exact strings (no trim / case fold). Duplicates use
/// ordinal uniqueness via `UNIQUE (candidate_text)` + `INSERT OR IGNORE`.
pub struct DictionaryCandidateStore {
    path: PathBuf,
    write_lock: Mutex<()>,
}

impl DictionaryCandidateStore {
    pub fn open(database_path: impl Into<PathBuf>) -> Result<Self, DictionaryError> {
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

    pub fn add_candidates(
        &self,
        candidates: impl IntoIterator<Item = impl AsRef<str>>,
    ) -> Result<DictionaryCandidateAddSummary, DictionaryError> {
        let _guard = self.write_lock.lock().expect("dictionary write lock");
        self.with_connection(|conn| {
            let tx = conn.unchecked_transaction()?;
            let mut insert = tx.prepare_cached(
                "INSERT OR IGNORE INTO dictionary_candidates (candidate_text, byte_count) \
                 VALUES (?1, ?2);",
            )?;

            let mut submitted = 0u64;
            let mut added = 0u64;
            let mut invalid = 0u64;

            for candidate in candidates {
                submitted += 1;
                let text = candidate.as_ref();
                let byte_count = text.len();
                if text.is_empty() || byte_count > MAX_CANDIDATE_BYTES {
                    invalid += 1;
                    continue;
                }
                let changed = insert.execute(params![text, byte_count as i64])?;
                added += changed as u64;
            }

            drop(insert);
            tx.commit()?;

            Ok(DictionaryCandidateAddSummary {
                submitted_count: submitted,
                added_count: added,
                duplicate_count: submitted.saturating_sub(invalid).saturating_sub(added),
                invalid_count: invalid,
            })
        })
    }

    /// Import a local text dictionary: each line is one candidate (as-is).
    /// Does not record source path, filename, or content hash.
    pub fn import_file(
        &self,
        source_path: impl AsRef<Path>,
    ) -> Result<DictionaryCandidateAddSummary, DictionaryError> {
        let path = source_path.as_ref();
        if !path.is_file() {
            return Err(DictionaryError::NotFound(path.display().to_string()));
        }

        let file = File::open(path)?;
        let mut reader = BufReader::with_capacity(64 * 1024, file);
        let mut batch = Vec::with_capacity(IMPORT_BATCH_SIZE);
        let mut summary = DictionaryCandidateAddSummary::EMPTY;

        while let Some(line) = read_bounded_candidate_line(&mut reader)? {
            match line {
                BoundedCandidateLine::Valid(line) => {
                    batch.push(line);
                    if batch.len() >= IMPORT_BATCH_SIZE {
                        summary = summary.merge(self.add_candidates(batch.drain(..))?);
                    }
                }
                BoundedCandidateLine::Oversized => {
                    summary.submitted_count += 1;
                    summary.invalid_count += 1;
                }
            }
        }

        if !batch.is_empty() {
            summary = summary.merge(self.add_candidates(batch)?);
        }

        Ok(summary)
    }

    pub fn list_entries(
        &self,
        query: &DictionaryCandidateQuery,
    ) -> Result<Vec<DictionaryCandidateEntry>, DictionaryError> {
        self.with_connection(|conn| {
            let take = query.take.clamp(1, DEFAULT_PAGE_SIZE);
            let skip = query.skip.max(0);
            let mut stmt = conn.prepare_cached(
                "SELECT id, candidate_text, byte_count, success_count \
                 FROM dictionary_candidates \
                 WHERE ?1 = '' OR instr(candidate_text, ?1) > 0 \
                 ORDER BY id ASC \
                 LIMIT ?2 OFFSET ?3;",
            )?;

            let rows = stmt.query_map(params![query.search_text.as_str(), take, skip], |row| {
                Ok(DictionaryCandidateEntry {
                    id: row.get(0)?,
                    value: row.get(1)?,
                    byte_count: row.get(2)?,
                    success_count: row.get(3)?,
                })
            })?;

            let mut entries = Vec::new();
            for row in rows {
                entries.push(row?);
            }
            Ok(entries)
        })
    }

    pub fn count(&self) -> Result<u64, DictionaryError> {
        self.with_connection(|conn| {
            let count: i64 =
                conn.query_row("SELECT COUNT(*) FROM dictionary_candidates;", [], |row| {
                    row.get(0)
                })?;
            Ok(count as u64)
        })
    }

    pub fn count_matches(&self, search_text: &str) -> Result<u64, DictionaryError> {
        self.with_connection(|conn| {
            let count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM dictionary_candidates \
                 WHERE ?1 = '' OR instr(candidate_text, ?1) > 0;",
                [search_text],
                |row| row.get(0),
            )?;
            Ok(count as u64)
        })
    }

    pub fn list(
        &self,
        query: &DictionaryCandidateQuery,
    ) -> Result<DictionaryListResult, DictionaryError> {
        Ok(DictionaryListResult {
            entries: self.list_entries(query)?,
            total_count: self.count()?,
            matched_count: self.count_matches(&query.search_text)?,
        })
    }

    pub fn delete(&self, ids: &[i64]) -> Result<u64, DictionaryError> {
        if ids.is_empty() {
            return Ok(0);
        }

        let _guard = self.write_lock.lock().expect("dictionary write lock");
        self.with_connection(|conn| {
            let tx = conn.unchecked_transaction()?;
            let mut stmt = tx.prepare_cached("DELETE FROM dictionary_candidates WHERE id = ?1;")?;
            let mut deleted = 0u64;
            for id in ids {
                deleted += stmt.execute(params![id])? as u64;
            }
            drop(stmt);
            tx.commit()?;
            if deleted > 0 {
                checkpoint_deleted_content(conn)?;
            }
            Ok(deleted)
        })
    }

    pub fn increment_success(&self, candidate: &str) -> Result<(), DictionaryError> {
        let _guard = self.write_lock.lock().expect("dictionary write lock");
        self.with_connection(|conn| {
            conn.execute(
                "UPDATE dictionary_candidates \
                 SET success_count = CASE \
                     WHEN success_count < 9223372036854775807 THEN success_count + 1 \
                     ELSE 9223372036854775807 \
                 END \
                 WHERE candidate_text = ?1;",
                params![candidate],
            )?;
            Ok(())
        })
    }

    /// Materialize all line-safe candidates as a UTF-8 wordlist.
    ///
    /// Successful candidates are tried first. Values containing a line break
    /// or NUL cannot be represented losslessly by line-oriented Hashcat/John
    /// wordlists and are skipped.
    pub fn export_wordlist(&self, destination: impl AsRef<Path>) -> Result<u64, DictionaryError> {
        let destination = destination.as_ref();
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)?;
        }

        self.with_connection(|conn| {
            let file = File::create(destination)?;
            let mut writer = BufWriter::with_capacity(64 * 1024, file);
            let mut stmt = conn.prepare_cached(
                "SELECT candidate_text \
                 FROM dictionary_candidates \
                 ORDER BY success_count DESC, id ASC;",
            )?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            let mut exported = 0u64;
            for row in rows {
                let candidate = row?;
                if candidate.contains(['\r', '\n', '\0']) {
                    continue;
                }
                writer.write_all(candidate.as_bytes())?;
                writer.write_all(b"\n")?;
                exported += 1;
            }
            writer.flush()?;
            Ok(exported)
        })
    }

    /// Create a consistent SQLite snapshot, including committed WAL contents.
    ///
    /// `VACUUM INTO` requires the destination to be absent and leaves the live
    /// database untouched.
    pub fn backup(&self, destination: impl AsRef<Path>) -> Result<u64, DictionaryError> {
        let destination = destination.as_ref();
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let _guard = self.write_lock.lock().expect("dictionary write lock");
        self.with_connection(|conn| {
            conn.execute("VACUUM INTO ?1;", [destination.display().to_string()])?;
            Ok(std::fs::metadata(destination)?.len())
        })
    }

    /// Read a single candidate text by id (for tests / diagnostics).
    pub fn get_value(&self, id: i64) -> Result<Option<String>, DictionaryError> {
        self.with_connection(|conn| {
            let value = conn
                .query_row(
                    "SELECT candidate_text FROM dictionary_candidates WHERE id = ?1;",
                    params![id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            Ok(value)
        })
    }

    fn with_connection<T>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, DictionaryError>,
    ) -> Result<T, DictionaryError> {
        let conn = Connection::open(&self.path)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch(
            "PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON; PRAGMA journal_mode = WAL;",
        )?;
        f(&conn)
    }
}

enum BoundedCandidateLine {
    Valid(String),
    Oversized,
}

fn read_bounded_candidate_line(
    reader: &mut impl BufRead,
) -> Result<Option<BoundedCandidateLine>, std::io::Error> {
    let mut bytes = Vec::with_capacity(MAX_CANDIDATE_BYTES.min(64 * 1024));
    let mut saw_data = false;
    let mut oversized = false;
    let mut ended_with_newline = false;

    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            if !saw_data {
                return Ok(None);
            }
            break;
        }

        saw_data = true;
        let newline = available.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map_or(available.len(), |index| index + 1);
        let content = newline.map_or(&available[..consumed], |index| &available[..index]);

        if !oversized {
            // Keep one extra byte only so a max-sized CRLF line remains valid.
            let capacity = MAX_CANDIDATE_BYTES + 1;
            let remaining = capacity.saturating_sub(bytes.len());
            if content.len() > remaining {
                oversized = true;
                bytes.clear();
            } else {
                bytes.extend_from_slice(content);
            }
        }

        reader.consume(consumed);
        if newline.is_some() {
            ended_with_newline = true;
            break;
        }
    }

    if oversized {
        return Ok(Some(BoundedCandidateLine::Oversized));
    }
    if ended_with_newline && bytes.last() == Some(&b'\r') {
        bytes.pop();
    }
    if bytes.len() > MAX_CANDIDATE_BYTES {
        return Ok(Some(BoundedCandidateLine::Oversized));
    }

    String::from_utf8(bytes)
        .map(BoundedCandidateLine::Valid)
        .map(Some)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))
}

fn checkpoint_deleted_content(conn: &Connection) -> Result<(), DictionaryError> {
    // `secure_delete=ON` clears deleted cell content. Truncating the WAL makes
    // that deletion durable without rewriting the entire shared database for
    // every removed candidate; full compaction is reserved for explicit
    // maintenance/backup workflows.
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_db() -> (tempfile::TempDir, DictionaryCandidateStore) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("arcrecall.db");
        let store = DictionaryCandidateStore::open(&path).expect("open store");
        (dir, store)
    }

    #[test]
    fn backup_creates_consistent_database_snapshot() {
        let (dir, store) = temp_db();
        store.add_candidates(["alpha", "beta"]).unwrap();
        let backup_path = dir.path().join("backup.db");

        let size = store.backup(&backup_path).unwrap();
        let backup = DictionaryCandidateStore::open(&backup_path).unwrap();

        assert!(size > 0);
        assert_eq!(backup.count().unwrap(), 2);
    }

    #[test]
    fn add_candidates_uses_ordinal_dedupe_without_trim_or_case_fold() {
        let (_dir, store) = temp_db();
        let summary = store
            .add_candidates(["alpha", "Alpha", "alpha", " alpha ", ""])
            .expect("add");

        assert_eq!(
            summary,
            DictionaryCandidateAddSummary {
                submitted_count: 5,
                added_count: 3,
                duplicate_count: 1,
                invalid_count: 1,
            }
        );

        let entries = store
            .list_entries(&DictionaryCandidateQuery::default())
            .expect("list");
        let values: Vec<_> = entries.iter().map(|e| e.value.as_str()).collect();
        assert_eq!(values, ["alpha", "Alpha", " alpha "]);
    }

    #[test]
    fn list_search_pagination_and_delete() {
        let (_dir, store) = temp_db();
        store
            .add_candidates(["alpha", "beta", "alphabet"])
            .expect("add");

        let page = store
            .list(&DictionaryCandidateQuery {
                search_text: String::new(),
                skip: 1,
                take: 1,
            })
            .expect("page");
        assert_eq!(page.total_count, 3);
        assert_eq!(page.matched_count, 3);
        assert_eq!(page.entries[0].value, "beta");

        let result = store
            .list(&DictionaryCandidateQuery {
                search_text: "alpha".into(),
                skip: 0,
                take: 10,
            })
            .expect("search");
        assert_eq!(result.total_count, 3);
        assert_eq!(result.matched_count, 2);
        assert_eq!(
            result
                .entries
                .iter()
                .map(|e| e.value.as_str())
                .collect::<Vec<_>>(),
            ["alpha", "alphabet"]
        );

        store.delete(&[result.entries[0].id]).expect("delete");
        let remaining = store
            .list_entries(&DictionaryCandidateQuery::default())
            .expect("list");
        let values: Vec<_> = remaining.iter().map(|e| e.value.as_str()).collect();
        assert_eq!(values, ["beta", "alphabet"]);
        assert_eq!(store.count().expect("count"), 2);
    }

    #[test]
    fn import_file_streams_lines() {
        let dir = tempfile::tempdir().expect("tempdir");
        let dict_path = dir.path().join("dict.txt");
        {
            let mut file = File::create(&dict_path).expect("create");
            writeln!(file, "one").unwrap();
            writeln!(file, "two").unwrap();
            writeln!(file, "one").unwrap();
            writeln!(file).unwrap(); // empty invalid
        }

        let db_path = dir.path().join("arcrecall.db");
        let store = DictionaryCandidateStore::open(&db_path).expect("open");
        let summary = store.import_file(&dict_path).expect("import");
        assert_eq!(summary.added_count, 2);
        assert_eq!(summary.duplicate_count, 1);
        assert_eq!(summary.invalid_count, 1);
        assert_eq!(store.count().expect("count"), 2);
    }

    #[test]
    fn increment_success_count() {
        let (_dir, store) = temp_db();
        store.add_candidates(["alpha", "beta"]).expect("add");
        store.increment_success("beta").expect("inc1");
        store.increment_success("beta").expect("inc2");

        let entries = store
            .list_entries(&DictionaryCandidateQuery::default())
            .expect("list");
        assert_eq!(
            entries
                .iter()
                .find(|e| e.value == "alpha")
                .unwrap()
                .success_count,
            0
        );
        assert_eq!(
            entries
                .iter()
                .find(|e| e.value == "beta")
                .unwrap()
                .success_count,
            2
        );
    }

    #[test]
    fn export_wordlist_prioritizes_success_and_skips_multiline_values() {
        let (dir, store) = temp_db();
        store
            .add_candidates(["first", "winner", "line\nbreak", "nul\0value"])
            .expect("add");
        store.increment_success("winner").expect("increment");
        let destination = dir.path().join("dictionary.txt");

        let exported = store.export_wordlist(&destination).expect("export");

        assert_eq!(exported, 2);
        assert_eq!(
            std::fs::read_to_string(destination).expect("read"),
            "winner\nfirst\n"
        );
    }

    #[test]
    fn import_file_discards_oversized_line_and_continues() {
        let dir = tempfile::tempdir().expect("tempdir");
        let dict_path = dir.path().join("oversized.txt");
        {
            let mut file = File::create(&dict_path).expect("create");
            file.write_all(&vec![b'x'; MAX_CANDIDATE_BYTES + 1])
                .unwrap();
            writeln!(file).unwrap();
            writeln!(file, "valid-after-oversized").unwrap();
        }
        let store = DictionaryCandidateStore::open(dir.path().join("dictionary.db")).unwrap();

        let summary = store.import_file(&dict_path).unwrap();

        assert_eq!(summary.submitted_count, 2);
        assert_eq!(summary.added_count, 1);
        assert_eq!(summary.invalid_count, 1);
        assert_eq!(
            store
                .list_entries(&DictionaryCandidateQuery::default())
                .unwrap()[0]
                .value,
            "valid-after-oversized"
        );
    }

    #[test]
    fn list_entries_clamps_requested_page_size() {
        let (_dir, store) = temp_db();
        let candidates = (0..DEFAULT_PAGE_SIZE + 10).map(|index| format!("candidate-{index}"));
        store.add_candidates(candidates).unwrap();

        let entries = store
            .list_entries(&DictionaryCandidateQuery {
                take: i64::MAX,
                ..DictionaryCandidateQuery::default()
            })
            .unwrap();

        assert_eq!(entries.len(), DEFAULT_PAGE_SIZE as usize);
    }
}
