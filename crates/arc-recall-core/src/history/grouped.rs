use rusqlite::{Connection, params};

use super::{
    HASH_PREFIX_LENGTH, RecoveryHistoryEntry, RecoveryHistoryError, RecoveryHistoryListResult,
    RecoveryHistoryQuery,
};

const FAMILIES: &str = r#"
WITH families AS (
    SELECT h.id, COALESCE(root.id, h.id) AS family_id
    FROM recovery_history h
    LEFT JOIN recovery_history root
      ON root.fingerprint_sha256 = h.root_fingerprint_sha256 AND root.id <> h.id
), matched AS (
    SELECT DISTINCT f.family_id
    FROM families f JOIN recovery_history h ON h.id = f.id
    WHERE ?1 = '' OR instr(h.fingerprint_sha256, ?1) = 1
       OR instr(lower(h.archive_name), ?1) > 0
       OR instr(lower(h.archive_path), ?1) > 0
       OR instr(lower(h.output_directory), ?1) > 0
)
"#;

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

pub(super) fn list(
    conn: &Connection,
    query: &RecoveryHistoryQuery,
) -> Result<RecoveryHistoryListResult, RecoveryHistoryError> {
    // Family counts, pagination and children must share one read snapshot.
    let tx = conn.unchecked_transaction()?;
    let search = query.search_text.trim().to_ascii_lowercase();
    let (total_count, matched_count, password_count) = tx.query_row(
        &format!(
            "{FAMILIES} SELECT
            (SELECT COUNT(DISTINCT family_id) FROM families),
            (SELECT COUNT(*) FROM matched),
            (SELECT COUNT(*) FROM recovery_history WHERE password_protected IS NOT NULL);"
        ),
        [&search],
        |row| {
            Ok((
                row.get::<_, u64>(0)?,
                row.get::<_, u64>(1)?,
                row.get::<_, u64>(2)?,
            ))
        },
    )?;
    let mut statement = tx.prepare_cached(&format!(
        r#"{FAMILIES}, page AS (
        SELECT f.family_id, MAX(h.last_verified_at_ms) AS latest
        FROM families f JOIN recovery_history h ON h.id = f.id
        WHERE f.family_id IN (SELECT family_id FROM matched)
        GROUP BY f.family_id
        ORDER BY latest DESC, f.family_id DESC LIMIT ?2 OFFSET ?3
    ) SELECT h.id, substr(h.fingerprint_sha256, 1, ?4), h.archive_format,
        h.file_size, h.volume_count, h.first_success_at_ms, h.last_verified_at_ms,
        h.verification_count, h.password_protected IS NOT NULL,
        h.archive_name, h.archive_path, h.output_directory, f.family_id
      FROM recovery_history h JOIN families f ON f.id = h.id
      JOIN page p ON p.family_id = f.family_id
      ORDER BY p.latest DESC, p.family_id DESC, h.id <> f.family_id,
               h.last_verified_at_ms DESC, h.id DESC;"#
    ))?;
    let rows = statement.query_map(
        params![
            search,
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
    Ok(RecoveryHistoryListResult {
        entries,
        total_count,
        matched_count,
        password_count,
    })
}
