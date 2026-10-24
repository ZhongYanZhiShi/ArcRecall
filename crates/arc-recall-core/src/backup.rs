//! Versioned portable data backup. Live queues and OS credentials are deliberately excluded.
use crate::{
    AppPaths, AppSettings, DatabaseRestoreInfo, DictionaryCandidateStore, SettingsStore,
    compression_presets::{CompressionPreset, CompressionPresetStore},
    processing_presets::{ProcessingPreset, ProcessingPresetStore},
    settings::{LoggingSettings, RecoverySettings},
    task_records::{TaskRecord, TaskRecordStore},
};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

const MAX_PAYLOAD: usize = 64 * 1024 * 1024;
const MARKER: &str = "data-restore-pending.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableSettings {
    pub auto_update: bool,
    pub logging: LoggingSettings,
    pub recovery: RecoverySettings,
}
impl PortableSettings {
    pub fn from_settings(settings: &AppSettings) -> Self {
        Self {
            auto_update: settings.auto_update,
            logging: settings.logging.clone(),
            recovery: settings.recovery.clone(),
        }
    }
    fn apply(&self, store: &SettingsStore) -> Result<(), String> {
        if !self.logging.has_valid_disk_limit() {
            return Err("备份的日志设置无效。".into());
        }
        let mut settings = store.load().map_err(|e| e.to_string())?;
        settings.auto_update = self.auto_update;
        settings.logging = self.logging.clone();
        settings.recovery = self.recovery.clone();
        store.save(&settings).map_err(|e| e.to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupContents {
    pub version: u32,
    #[serde(default)]
    pub compression_presets: Option<Vec<CompressionPreset>>,
    pub presets: Vec<ProcessingPreset>,
    pub records: Vec<TaskRecord>,
    pub settings: PortableSettings,
}
impl BackupContents {
    fn validate(&self) -> Result<(), String> {
        if !matches!(self.version, 1 | 2)
            || (self.version == 2 && self.compression_presets.is_none())
            || (self.version == 1 && self.compression_presets.is_some())
        {
            return Err("不支持此备份版本，请使用匹配版本的 ArcRecall。".into());
        }
        if !self.settings.logging.has_valid_disk_limit() {
            return Err("备份的日志设置无效。".into());
        }
        let temp = tempfile::tempdir().map_err(|e| e.to_string())?;
        if let Some(presets) = &self.compression_presets {
            CompressionPresetStore::open(&temp.path().join("compression.db"))?
                .replace_all(presets)?;
        }
        let mut presets = ProcessingPresetStore::open(&temp.path().join("presets.db"))?;
        for preset in &self.presets {
            presets.save(preset, false)?;
        }
        let mut ids = std::collections::HashSet::new();
        for record in &self.records {
            if let Some(options) = &record.compression {
                options.validate()?;
            }
            if record.task_id.is_empty()
                || !ids.insert(&record.task_id)
                || !matches!(
                    record.state.as_str(),
                    "running" | "success" | "partial" | "failed" | "cancelled" | "interrupted"
                )
                || record.started_at_ms > i64::MAX as u64
            {
                return Err("备份的任务记录无效或重复。".into());
            }
        }
        Ok(())
    }
}

/// Caller holds the application's data locks and excludes running archive tasks.
pub fn create(
    paths: &AppPaths,
    dictionary: &DictionaryCandidateStore,
    settings: &SettingsStore,
    destination: &Path,
) -> Result<u64, String> {
    let contents = BackupContents {
        version: 2,
        compression_presets: Some(
            CompressionPresetStore::open(&paths.root.join("compression-presets.db"))?.list()?,
        ),
        presets: ProcessingPresetStore::open(&paths.root.join("processing-presets.db"))?.list()?,
        records: TaskRecordStore::open(&paths.root.join("task-records.db"))?.all()?,
        settings: PortableSettings::from_settings(&settings.load().map_err(|e| e.to_string())?),
    };
    contents.validate()?;
    let json = serde_json::to_string(&contents).map_err(|e| e.to_string())?;
    if json.len() > MAX_PAYLOAD {
        return Err("预设与任务记录超过备份容量上限（64 MiB），请先清理旧记录。".into());
    }
    let parent = destination.parent().ok_or("备份路径无效。")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let directory = tempfile::tempdir_in(parent).map_err(|e| e.to_string())?;
    let snapshot = directory.path().join("backup.db");
    dictionary.backup(&snapshot).map_err(|e| e.to_string())?;
    {
        let conn = Connection::open(&snapshot).map_err(|e| e.to_string())?;
        conn.execute_batch("CREATE TABLE arcrecall_backup (payload TEXT NOT NULL);")
            .map_err(|e| e.to_string())?;
        conn.execute("INSERT INTO arcrecall_backup VALUES (?1)", [json])
            .map_err(|e| e.to_string())?;
    }
    let mut output = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    std::io::copy(
        &mut fs::File::open(snapshot).map_err(|e| e.to_string())?,
        &mut output,
    )
    .map_err(|e| e.to_string())?;
    output.as_file().sync_all().map_err(|e| e.to_string())?;
    let bytes = output
        .as_file()
        .metadata()
        .map_err(|e| e.to_string())?
        .len();
    output
        .persist_noclobber(destination)
        .map_err(|e| e.to_string())?;
    Ok(bytes)
}

/// Freeze the selected file before inspecting it. The resulting snapshot only contains
/// legacy dictionary/history tables, so all existing schema/constraint checks still apply.
pub fn prepare(
    source: &Path,
    snapshot: &Path,
) -> Result<(DatabaseRestoreInfo, Option<BackupContents>), String> {
    let conn = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string())?;
    conn.execute_batch("PRAGMA trusted_schema=OFF;")
        .map_err(|e| e.to_string())?;
    conn.execute("VACUUM INTO ?1", [snapshot.to_string_lossy().as_ref()])
        .map_err(|e| format!("无法读取完整备份：{e}"))?;
    drop(conn);
    let conn = Connection::open(snapshot).map_err(|e| e.to_string())?;
    conn.execute_batch("PRAGMA trusted_schema=OFF;")
        .map_err(|e| e.to_string())?;
    let has_payload: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='arcrecall_backup' AND type='table')", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    let contents = if has_payload {
        let count: u64 = conn
            .query_row("SELECT COUNT(*) FROM arcrecall_backup", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        let size: usize = conn
            .query_row(
                "SELECT length(CAST(payload AS BLOB)) FROM arcrecall_backup",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if count != 1 || size > MAX_PAYLOAD {
            return Err("统一备份内容不完整或超出容量上限。".into());
        }
        let json: String = conn
            .query_row("SELECT payload FROM arcrecall_backup", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        let contents: BackupContents =
            serde_json::from_str(&json).map_err(|_| "统一备份内容格式不受支持。".to_string())?;
        contents.validate()?;
        conn.execute_batch("DROP TABLE arcrecall_backup;")
            .map_err(|e| e.to_string())?;
        Some(contents)
    } else {
        None
    };
    drop(conn);
    let info = crate::inspect_database_restore(snapshot)?;
    Ok((info, contents))
}

fn apply(
    paths: &AppPaths,
    dictionary: &DictionaryCandidateStore,
    settings: &SettingsStore,
    snapshot: &Path,
    contents: Option<&BackupContents>,
) -> Result<DatabaseRestoreInfo, String> {
    // Validate all supplemental data before the first mutation.
    if let Some(contents) = contents {
        contents.validate()?;
    }
    if let Some(contents) = contents {
        contents.settings.apply(settings)?;
        if let Some(presets) = &contents.compression_presets {
            CompressionPresetStore::open(&paths.root.join("compression-presets.db"))?
                .replace_all(presets)?;
        }
        ProcessingPresetStore::open(&paths.root.join("processing-presets.db"))?
            .replace_all(&contents.presets)?;
        TaskRecordStore::open(&paths.root.join("task-records.db"))?
            .replace_all(&contents.records)?;
    }
    let temp = tempfile::tempdir_in(&paths.root).map_err(|e| e.to_string())?;
    dictionary.restore_snapshot(snapshot, &temp.path().join("prior.db"))
}

/// The durable marker makes the entire restore a recoverable operation across stores.
/// It is removed only after every component succeeds; startup rolls back any unfinished restore.
pub fn restore(
    paths: &AppPaths,
    dictionary: &DictionaryCandidateStore,
    settings: &SettingsStore,
    snapshot: &Path,
    contents: Option<&BackupContents>,
    safety_backup: &Path,
) -> Result<DatabaseRestoreInfo, String> {
    if paths.root.join(MARKER).exists() {
        return Err("上次恢复尚未完成，请重启应用以还原安全备份。".into());
    }
    create(paths, dictionary, settings, safety_backup)?;
    let mut marker = tempfile::NamedTempFile::new_in(&paths.root).map_err(|e| e.to_string())?;
    marker
        .write_all(
            serde_json::to_string(&safety_backup)
                .map_err(|e| e.to_string())?
                .as_bytes(),
        )
        .map_err(|e| e.to_string())?;
    marker.as_file().sync_all().map_err(|e| e.to_string())?;
    marker
        .persist_noclobber(paths.root.join(MARKER))
        .map_err(|e| e.to_string())?;
    match apply(paths, dictionary, settings, snapshot, contents) {
        Ok(info) => {
            fs::remove_file(paths.root.join(MARKER)).map_err(|_| {
                "数据已写入，但恢复尚未确认完成；请重启应用以还原安全备份。".to_string()
            })?;
            Ok(info)
        }
        Err(error) => match rollback_pending(paths, dictionary, settings) {
            Ok(()) => Err(format!("恢复失败，已还原原有数据：{error}")),
            Err(_) => Err(format!(
                "恢复失败且自动回滚未完成，请重启应用。安全备份：{}",
                safety_backup.display()
            )),
        },
    }
}

pub fn rollback_pending(
    paths: &AppPaths,
    dictionary: &DictionaryCandidateStore,
    settings: &SettingsStore,
) -> Result<(), String> {
    let marker = paths.root.join(MARKER);
    if !marker.exists() {
        return Ok(());
    }
    let source: PathBuf = serde_json::from_slice(&fs::read(&marker).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let source = source.canonicalize().map_err(|e| e.to_string())?;
    let exports = paths.exports.canonicalize().map_err(|e| e.to_string())?;
    if !source.starts_with(exports) {
        return Err("中断恢复的安全备份路径无效。".into());
    }
    let directory = tempfile::tempdir_in(&paths.root).map_err(|e| e.to_string())?;
    let snapshot = directory.path().join("restore.db");
    let (_, contents) = prepare(&source, &snapshot)?;
    let contents = contents.ok_or("中断恢复需要完整安全备份。")?;
    apply(paths, dictionary, settings, &snapshot, Some(&contents))?;
    fs::remove_file(marker).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        RecoveryHistoryStore, SettingsUpdate, task_records::TaskOperation,
        tools::RecoveryComputeMode,
    };

    fn setup(root: &Path) -> (AppPaths, DictionaryCandidateStore, SettingsStore) {
        let paths = AppPaths::from_root(root);
        paths.ensure_dirs().unwrap();
        let dictionary = DictionaryCandidateStore::open(&paths.database).unwrap();
        RecoveryHistoryStore::open(&paths.database).unwrap();
        let settings = SettingsStore::open(&paths.settings).unwrap();
        (paths, dictionary, settings)
    }
    fn seed(paths: &AppPaths, dictionary: &DictionaryCandidateStore, settings: &SettingsStore) {
        CompressionPresetStore::open(&paths.root.join("compression-presets.db"))
            .unwrap()
            .save(
                &CompressionPreset {
                    name: "资料压缩".into(),
                    options: crate::compression_presets::CompressionOptions {
                        format: crate::CompressionFormat::SevenZip,
                        level: 5,
                        encrypt_file_names: false,
                        output_directory: None,
                    },
                    name_template: "{name}".into(),
                    open_when_done: false,
                },
                false,
            )
            .unwrap();
        dictionary.add_candidates(["candidate"]).unwrap();
        dictionary.assign_group("测试分组", &[1]).unwrap();
        ProcessingPresetStore::open(&paths.root.join("processing-presets.db"))
            .unwrap()
            .save(
                &ProcessingPreset {
                    name: "资料检查".into(),
                    output_directory: None,
                    recursive: true,
                    compute_mode: RecoveryComputeMode::CpuOnly,
                    dictionary_group: Some("测试分组".into()),
                    open_when_done: false,
                },
                false,
            )
            .unwrap();
        TaskRecordStore::open(&paths.root.join("task-records.db"))
            .unwrap()
            .save(&TaskRecord {
                task_id: "check-1".into(),
                operation: TaskOperation::IntegrityCheck,
                state: "running".into(),
                archive_path: "[测试分组] 中文归档.zip".into(),
                started_at_ms: 1,
                ..Default::default()
            })
            .unwrap();
        settings
            .update_preferences(SettingsUpdate::AutoUpdate(false))
            .unwrap();
    }

    #[test]
    fn compression_presets_round_trip_and_old_versions_preserve_local_presets() {
        let temp = tempfile::tempdir().unwrap();
        let (paths, dictionary, settings) = setup(temp.path());
        let preset = CompressionPreset {
            name: "资料打包".into(),
            options: crate::compression_presets::CompressionOptions {
                format: crate::CompressionFormat::SevenZip,
                level: 5,
                encrypt_file_names: false,
                output_directory: None,
            },
            name_template: "{name}-{date}".into(),
            open_when_done: false,
        };
        let mut store =
            CompressionPresetStore::open(&paths.root.join("compression-presets.db")).unwrap();
        store.save(&preset, false).unwrap();
        let backup = paths.exports.join("compression.arcrecall");
        create(&paths, &dictionary, &settings, &backup).unwrap();
        let snapshot = paths.root.join("snapshot.db");
        let (_, contents) = prepare(&backup, &snapshot).unwrap();
        let mut contents = contents.unwrap();
        assert_eq!(contents.version, 2);
        assert_eq!(
            contents.compression_presets.as_ref().unwrap()[0].name,
            preset.name
        );
        store.replace_all(&[]).unwrap();
        restore(
            &paths,
            &dictionary,
            &settings,
            &snapshot,
            Some(&contents),
            &paths.exports.join("safety.arcrecall"),
        )
        .unwrap();
        assert_eq!(store.list().unwrap().len(), 1);
        contents.compression_presets = None;
        assert!(contents.validate().is_err());
        contents.version = 1;
        contents.validate().unwrap();
        restore(
            &paths,
            &dictionary,
            &settings,
            &snapshot,
            Some(&contents),
            &paths.exports.join("legacy-safety.arcrecall"),
        )
        .unwrap();
        assert_eq!(store.list().unwrap().len(), 1);
    }

    #[test]
    fn unified_backup_round_trip_restores_all_components_and_keeps_local_configuration() {
        let temp = tempfile::tempdir().unwrap();
        let (source, dictionary, settings) = setup(&temp.path().join("source"));
        seed(&source, &dictionary, &settings);
        let mut private = settings.load().unwrap();
        private.engine.hashcat_path = "private-engine-location".into();
        private.ai.rename_prompt = "private-ai-prompt".into();
        settings.save(&private).unwrap();
        let backup = source.exports.join("backup.arcrecall");
        create(&source, &dictionary, &settings, &backup).unwrap();
        let bytes = fs::read(&backup).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("private-"));
        assert!(create(&source, &dictionary, &settings, &backup).is_err());
        let snapshot = temp.path().join("snapshot.db");
        let (info, contents) = prepare(&backup, &snapshot).unwrap();
        assert_eq!(info.candidate_count, 1);
        let (target, destination, preferences) = setup(&temp.path().join("target"));
        let mut local = preferences.load().unwrap();
        local.engine.hashcat_path = "local-engine".into();
        preferences.save(&local).unwrap();
        destination.add_candidates(["keep-in-safety"]).unwrap();
        let safety = target.exports.join("safety.arcrecall");
        restore(
            &target,
            &destination,
            &preferences,
            &snapshot,
            contents.as_ref(),
            &safety,
        )
        .unwrap();
        assert_eq!(destination.groups().unwrap(), ["测试分组"]);
        assert_eq!(
            ProcessingPresetStore::open(&target.root.join("processing-presets.db"))
                .unwrap()
                .list()
                .unwrap()
                .len(),
            1
        );
        let records = TaskRecordStore::open(&target.root.join("task-records.db"))
            .unwrap()
            .all()
            .unwrap();
        assert_eq!(records[0].state, "interrupted");
        assert_eq!(records[0].operation, TaskOperation::IntegrityCheck);
        assert!(!preferences.load().unwrap().auto_update);
        assert_eq!(
            preferences.load().unwrap().engine.hashcat_path,
            "local-engine"
        );
        let prior = temp.path().join("prior.db");
        prepare(&safety, &prior).unwrap();
        assert_eq!(
            DictionaryCandidateStore::open(&prior)
                .unwrap()
                .get_value(1)
                .unwrap()
                .as_deref(),
            Some("keep-in-safety")
        );
        assert!(!target.root.join(MARKER).exists());
    }

    #[test]
    fn legacy_database_restore_keeps_presets_records_and_preferences() {
        let temp = tempfile::tempdir().unwrap();
        let (paths, dictionary, settings) = setup(temp.path());
        let legacy = paths.exports.join("old.db");
        dictionary.backup(&legacy).unwrap();
        seed(&paths, &dictionary, &settings);
        let snapshot = paths.root.join("snapshot.db");
        let (_, contents) = prepare(&legacy, &snapshot).unwrap();
        assert!(contents.is_none());
        restore(
            &paths,
            &dictionary,
            &settings,
            &snapshot,
            None,
            &paths.exports.join("safety.arcrecall"),
        )
        .unwrap();
        assert_eq!(dictionary.count().unwrap(), 0);
        assert!(!settings.load().unwrap().auto_update);
        assert_eq!(
            ProcessingPresetStore::open(&paths.root.join("processing-presets.db"))
                .unwrap()
                .list()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            TaskRecordStore::open(&paths.root.join("task-records.db"))
                .unwrap()
                .all()
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn failure_after_supplemental_writes_rolls_back_every_component() {
        let temp = tempfile::tempdir().unwrap();
        let (paths, dictionary, settings) = setup(temp.path());
        seed(&paths, &dictionary, &settings);
        let source = paths.exports.join("source.arcrecall");
        create(&paths, &dictionary, &settings, &source).unwrap();
        let snapshot = paths.root.join("snapshot.db");
        let (_, contents) = prepare(&source, &snapshot).unwrap();
        let mut contents = contents.unwrap();
        contents.presets.clear();
        contents.compression_presets = Some(vec![]);
        contents.records.clear();
        contents.settings.auto_update = true;
        let conn = Connection::open(&snapshot).unwrap();
        conn.execute_batch("PRAGMA foreign_keys=OFF; CREATE TABLE duplicate_candidates AS SELECT * FROM dictionary_candidates; DROP TABLE dictionary_candidates; ALTER TABLE duplicate_candidates RENAME TO dictionary_candidates; INSERT INTO dictionary_candidates SELECT * FROM dictionary_candidates;").unwrap();
        drop(conn);
        let result = restore(
            &paths,
            &dictionary,
            &settings,
            &snapshot,
            Some(&contents),
            &paths.exports.join("safety.arcrecall"),
        );
        assert!(result.unwrap_err().contains("已还原原有数据"));
        assert_eq!(
            CompressionPresetStore::open(&paths.root.join("compression-presets.db"))
                .unwrap()
                .list()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(dictionary.count().unwrap(), 1);
        assert!(!settings.load().unwrap().auto_update);
        assert_eq!(
            ProcessingPresetStore::open(&paths.root.join("processing-presets.db"))
                .unwrap()
                .list()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            TaskRecordStore::open(&paths.root.join("task-records.db"))
                .unwrap()
                .all()
                .unwrap()
                .len(),
            1
        );
        assert!(!paths.root.join(MARKER).exists());
    }

    #[test]
    fn startup_rolls_back_an_interrupted_multi_store_restore() {
        let temp = tempfile::tempdir().unwrap();
        let (paths, dictionary, settings) = setup(temp.path());
        seed(&paths, &dictionary, &settings);
        let safety = paths.exports.join("safety.arcrecall");
        create(&paths, &dictionary, &settings, &safety).unwrap();
        fs::write(
            paths.root.join(MARKER),
            serde_json::to_vec(&safety).unwrap(),
        )
        .unwrap();
        settings
            .update_preferences(SettingsUpdate::AutoUpdate(true))
            .unwrap();
        ProcessingPresetStore::open(&paths.root.join("processing-presets.db"))
            .unwrap()
            .replace_all(&[])
            .unwrap();
        dictionary.add_candidates(["partial-write"]).unwrap();
        CompressionPresetStore::open(&paths.root.join("compression-presets.db"))
            .unwrap()
            .replace_all(&[])
            .unwrap();
        rollback_pending(&paths, &dictionary, &settings).unwrap();
        assert_eq!(
            CompressionPresetStore::open(&paths.root.join("compression-presets.db"))
                .unwrap()
                .list()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(dictionary.count().unwrap(), 1);
        assert!(!settings.load().unwrap().auto_update);
        assert_eq!(
            ProcessingPresetStore::open(&paths.root.join("processing-presets.db"))
                .unwrap()
                .list()
                .unwrap()
                .len(),
            1
        );
        rollback_pending(&paths, &dictionary, &settings).unwrap();
    }

    #[test]
    fn invalid_version_and_secret_fields_are_rejected_before_restoring() {
        let temp = tempfile::tempdir().unwrap();
        let (paths, dictionary, settings) = setup(temp.path());
        seed(&paths, &dictionary, &settings);
        for (index, field) in ["version", "password"].iter().enumerate() {
            let backup = paths.exports.join(format!("invalid-{index}.arcrecall"));
            create(&paths, &dictionary, &settings, &backup).unwrap();
            let conn = Connection::open(&backup).unwrap();
            let json: String = conn
                .query_row("SELECT payload FROM arcrecall_backup", [], |r| r.get(0))
                .unwrap();
            let mut value: serde_json::Value = serde_json::from_str(&json).unwrap();
            if *field == "version" {
                value["version"] = 999.into();
            } else {
                value["records"][0]["password"] = "forbidden".into();
            }
            conn.execute(
                "UPDATE arcrecall_backup SET payload=?1",
                [value.to_string()],
            )
            .unwrap();
            drop(conn);
            assert!(prepare(&backup, &paths.root.join(format!("snapshot-{index}.db"))).is_err());
            assert_eq!(dictionary.count().unwrap(), 1);
        }
    }
}
