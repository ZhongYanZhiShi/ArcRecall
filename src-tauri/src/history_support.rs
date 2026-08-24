use std::path::Path;

use arc_recall_core::{RecoveredArchive, RecoveryHistoryRecord, RecoveryHistoryStore};

use crate::credential_protection::{
    is_protected_history_password, protect_history_password, unprotect_history_password,
};

#[derive(Debug, Default)]
pub struct HistoryMigrationReport {
    pub migrated_count: usize,
    pub failed_count: usize,
}

#[derive(Debug, Default)]
pub struct HistorySaveReport {
    pub saved_count: usize,
    pub failed_count: usize,
}

pub fn migrate_legacy_history_passwords(
    store: &RecoveryHistoryStore,
) -> Result<HistoryMigrationReport, String> {
    let records = store
        .stored_passwords()
        .map_err(|error| error.to_string())?;
    let mut report = HistoryMigrationReport::default();
    for record in records {
        if is_protected_history_password(&record.protected_password) {
            continue;
        }
        let migrated = protect_history_password(&record.protected_password).and_then(|protected| {
            store
                .replace_protected_password(record.id, &protected)
                .map_err(|error| error.to_string())
        });
        match migrated {
            Ok(true) => report.migrated_count += 1,
            Ok(false) | Err(_) => report.failed_count += 1,
        }
    }
    Ok(report)
}

pub fn reveal_history_password(
    store: &RecoveryHistoryStore,
    id: i64,
) -> Result<Option<String>, String> {
    store
        .protected_password_by_id(id)
        .map_err(|error| error.to_string())?
        .map(|protected| unprotect_history_password(&protected))
        .transpose()
}

pub fn history_password_by_fingerprint(
    store: &RecoveryHistoryStore,
    fingerprint_sha256: &str,
) -> Result<Option<String>, String> {
    store
        .protected_password_by_fingerprint(fingerprint_sha256)
        .map_err(|error| error.to_string())?
        .map(|protected| unprotect_history_password(&protected))
        .transpose()
}

pub fn save_recovered_history(
    database_path: &Path,
    archives: &[RecoveredArchive],
    verified_at_ms: u64,
) -> HistorySaveReport {
    let Ok(store) = RecoveryHistoryStore::open(database_path) else {
        return HistorySaveReport {
            failed_count: archives.len(),
            ..HistorySaveReport::default()
        };
    };
    let mut report = HistorySaveReport::default();
    for archive in archives {
        let protected_password = archive
            .password
            .as_deref()
            .map(protect_history_password)
            .transpose();
        let saved = protected_password.and_then(|protected_password| {
            store
                .upsert(&RecoveryHistoryRecord {
                    fingerprint_sha256: archive.fingerprint_sha256.clone(),
                    archive_format: archive.archive_format.label().into(),
                    file_size: archive.file_size,
                    volume_count: archive.volume_count,
                    verified_at_ms,
                    protected_password,
                })
                .map_err(|error| error.to_string())
        });
        if saved.is_ok() {
            report.saved_count += 1;
        } else {
            report.failed_count += 1;
        }
    }
    report
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use arc_recall_core::ArchiveFormat;

    #[test]
    fn recovered_password_is_encrypted_before_reaching_sqlite() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("history.db");
        let secret = "history-plaintext-must-not-leak";
        let report = save_recovered_history(
            &database,
            &[RecoveredArchive {
                fingerprint_sha256: "f".repeat(64),
                archive_format: ArchiveFormat::Zip,
                file_size: 42,
                volume_count: 1,
                password: Some(secret.into()),
            }],
            100,
        );

        assert_eq!(report.saved_count, 1);
        assert_eq!(report.failed_count, 0);
        let store = RecoveryHistoryStore::open(&database).unwrap();
        assert_eq!(
            history_password_by_fingerprint(&store, &"f".repeat(64)).unwrap(),
            Some(secret.into())
        );
        drop(store);

        for entry in std::fs::read_dir(directory.path()).unwrap() {
            let path = entry.unwrap().path();
            if !path.is_file() {
                continue;
            }
            let bytes = std::fs::read(path).unwrap();
            assert!(
                !bytes
                    .windows(secret.len())
                    .any(|window| window == secret.as_bytes()),
                "plaintext password was present in a SQLite file"
            );
        }
    }
}
