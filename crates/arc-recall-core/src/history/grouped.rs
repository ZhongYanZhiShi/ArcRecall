use rusqlite::{Connection, params};

use super::{
    HASH_PREFIX_LENGTH, RecoveryHistoryEntry, RecoveryHistoryError, RecoveryHistoryListResult,
    RecoveryHistoryQuery,
};

pub(super) fn migrate(conn: &Connection) -> Result<(), RecoveryHistoryError> {
    let tx = conn.unchecked_transaction()?;
    let has_column = {
        let mut statement = tx.prepare("PRAGMA table_info(recovery_history);")?;
        statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?
            .iter()
            .any(|column| column == "root_fingerprint_sha256")
    };
    if !has_column {
        tx.execute_batch(
            r#"
            ALTER TABLE recovery_history ADD COLUMN root_fingerprint_sha256 TEXT;
            UPDATE recovery_history AS child SET root_fingerprint_sha256 = (
                SELECT parent.fingerprint_sha256 FROM recovery_history parent
                WHERE parent.id <> child.id
                  AND parent.last_verified_at_ms = child.last_verified_at_ms
                  AND parent.output_directory IS NOT NULL
                  AND parent.archive_path IS NOT NULL
                  AND instr(lower(replace(child.archive_path, '\', '/')),
                      lower(rtrim(replace(parent.output_directory, '\', '/'), '/')) || '/') = 1
                  AND instr(lower(replace(parent.archive_path, '\', '/')),
                      lower(rtrim(replace(parent.output_directory, '\', '/'), '/')) || '/') <> 1
                ORDER BY length(parent.output_directory), parent.id
                LIMIT 1
            );
        "#,
        )?;
    }
    tx.execute_batch("CREATE INDEX IF NOT EXISTS ix_recovery_history_root ON recovery_history(root_fingerprint_sha256);")?;
    tx.commit()?;
    Ok(())
}

// A connection-local index: never persisted in backups and never contains
// passwords or paths. All main-database writes use other connections, so
// data_version also invalidates this cache after external writes and restores.
pub(super) struct ListCache {
    conn: Connection,
    version: Option<i64>,
    search: Option<String>,
    password_count: u64,
}

impl ListCache {
    pub(super) fn new(conn: Connection) -> Result<Self, RecoveryHistoryError> {
        conn.execute_batch(
            "CREATE TEMP TABLE history_members (id INTEGER PRIMARY KEY, family_id INTEGER NOT NULL);
             CREATE INDEX temp.ix_history_members_family ON history_members(family_id);
             CREATE TEMP TABLE history_families (family_id INTEGER PRIMARY KEY, latest INTEGER NOT NULL);
             CREATE INDEX temp.ix_history_families_latest ON history_families(latest DESC, family_id DESC);
             CREATE TEMP TABLE history_matches (family_id INTEGER PRIMARY KEY, latest INTEGER NOT NULL);
             CREATE INDEX temp.ix_history_matches_latest ON history_matches(latest DESC, family_id DESC);",
        )?;
        Ok(Self {
            conn,
            version: None,
            search: None,
            password_count: 0,
        })
    }

    pub(super) fn list(
        &mut self,
        query: &RecoveryHistoryQuery,
    ) -> Result<RecoveryHistoryListResult, RecoveryHistoryError> {
        let search = query.search_text.trim().to_ascii_lowercase();
        let tx = self.conn.unchecked_transaction()?;
        // Pin the main database read snapshot before checking its version. The
        // counts, cached membership and returned rows must describe that snapshot.
        tx.query_row(
            "SELECT COUNT(*) FROM (SELECT id FROM main.recovery_history LIMIT 1)",
            [],
            |_| Ok(()),
        )?;
        let version: i64 = tx.query_row("PRAGMA main.data_version", [], |row| row.get(0))?;
        let changed = self.version != Some(version);
        let password_count = if changed {
            tx.execute_batch(
                "DELETE FROM temp.history_members;
                 DELETE FROM temp.history_families;
                 INSERT INTO temp.history_members
                   SELECT h.id, COALESCE(root.id, h.id)
                   FROM main.recovery_history h LEFT JOIN main.recovery_history root
                     ON root.fingerprint_sha256 = h.root_fingerprint_sha256 AND root.id <> h.id;
                 INSERT INTO temp.history_families
                   SELECT m.family_id, MAX(h.last_verified_at_ms)
                   FROM temp.history_members m JOIN main.recovery_history h ON h.id = m.id
                   GROUP BY m.family_id;",
            )?;
            tx.query_row(
                "SELECT COUNT(*) FROM main.recovery_history WHERE password_protected IS NOT NULL",
                [],
                |row| row.get(0),
            )?
        } else {
            self.password_count
        };
        if changed || self.search.as_deref() != Some(search.as_str()) {
            tx.execute("DELETE FROM temp.history_matches", [])?;
            if !search.is_empty() {
                tx.execute(
                    "INSERT INTO temp.history_matches
                     SELECT DISTINCT m.family_id, f.latest
                     FROM main.recovery_history h JOIN temp.history_members m ON m.id = h.id
                     JOIN temp.history_families f ON f.family_id = m.family_id
                     WHERE instr(h.fingerprint_sha256, ?1) = 1
                        OR instr(lower(h.archive_name), ?1) > 0
                        OR instr(lower(h.archive_path), ?1) > 0
                        OR instr(lower(h.output_directory), ?1) > 0",
                    [&search],
                )?;
            }
        }
        let total_count =
            tx.query_row("SELECT COUNT(*) FROM temp.history_families", [], |row| {
                row.get(0)
            })?;
        let matched_count = if search.is_empty() {
            total_count
        } else {
            tx.query_row("SELECT COUNT(*) FROM temp.history_matches", [], |row| {
                row.get(0)
            })?
        };
        let families = if search.is_empty() {
            "history_families"
        } else {
            "history_matches"
        };
        let mut statement = tx.prepare_cached(&format!(
            "WITH page AS MATERIALIZED (
               SELECT f.family_id, f.latest FROM temp.{families} f
               ORDER BY f.latest DESC, f.family_id DESC LIMIT ?1 OFFSET ?2
             ) SELECT h.id, substr(h.fingerprint_sha256, 1, ?3), h.archive_format,
                 h.file_size, h.volume_count, h.first_success_at_ms, h.last_verified_at_ms,
                 h.verification_count, h.password_protected IS NOT NULL,
                 h.archive_name, h.archive_path, h.output_directory, m.family_id
               FROM page p JOIN temp.history_members m ON m.family_id = p.family_id
               JOIN main.recovery_history h ON h.id = m.id
               ORDER BY p.latest DESC, p.family_id DESC, h.id <> m.family_id,
                        h.last_verified_at_ms DESC, h.id DESC;"
        ))?;
        let rows = statement.query_map(
            params![
                query.take.max(1),
                query.skip.max(0),
                HASH_PREFIX_LENGTH as i64
            ],
            |row| {
                Ok((
                    row.get::<_, i64>(12)?,
                    RecoveryHistoryEntry {
                        id: row.get(0)?,
                        fingerprint_prefix: row.get(1)?,
                        archive_format: row.get(2)?,
                        file_size: row.get::<_, i64>(3)?.max(0) as u64,
                        volume_count: row.get::<_, i64>(4)?.max(1) as u32,
                        first_success_at_ms: row.get::<_, i64>(5)?.max(0) as u64,
                        last_verified_at_ms: row.get::<_, i64>(6)?.max(0) as u64,
                        verification_count: row.get::<_, i64>(7)?.max(0) as u64,
                        has_password: row.get(8)?,
                        archive_name: row.get(9)?,
                        archive_path: row.get(10)?,
                        output_directory: row.get(11)?,
                        children: Vec::new(),
                    },
                ))
            },
        )?;
        let mut entries: Vec<RecoveryHistoryEntry> = Vec::new();
        for row in rows {
            let (family_id, entry) = row?;
            if family_id == entry.id {
                entries.push(entry);
            } else if let Some(root) = entries.last_mut() {
                root.children.push(entry);
            }
        }
        drop(statement);
        tx.commit()?;
        // Publish cache metadata only after the temporary-index transaction commits.
        self.version = Some(version);
        self.search = Some(search);
        self.password_count = password_count;
        Ok(RecoveryHistoryListResult {
            entries,
            total_count,
            matched_count,
            password_count,
        })
    }
}
