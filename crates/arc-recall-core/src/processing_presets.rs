use crate::tools::RecoveryComputeMode;
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Explicit allowlist: credentials and live task state never enter this store.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessingPreset {
    pub name: String,
    pub output_directory: Option<String>,
    pub recursive: bool,
    pub compute_mode: RecoveryComputeMode,
    pub dictionary_group: Option<String>,
    pub open_when_done: bool,
}

impl ProcessingPreset {
    pub fn validate(&self) -> Result<(), String> {
        if self.name.trim() != self.name
            || self.name.is_empty()
            || self.name.chars().count() > 80
            || self.name.chars().any(char::is_control)
        {
            return Err("预设名称需为 1–80 个可见字符。".into());
        }
        if self
            .output_directory
            .as_ref()
            .is_some_and(|p| p.is_empty() || !Path::new(p).is_absolute())
        {
            return Err("自定义输出位置必须是绝对路径。".into());
        }
        Ok(())
    }
}

pub(crate) fn validate_presets(presets: &[ProcessingPreset]) -> Result<(), String> {
    if presets.len() > 100 {
        return Err("最多保存 100 个预设，请先删除不再使用的预设。".into());
    }
    let mut names = std::collections::HashSet::new();
    for preset in presets {
        preset.validate()?;
        if !names.insert(&preset.name) {
            return Err("同名预设已存在，请确认覆盖。".into());
        }
    }
    Ok(())
}

pub struct ProcessingPresetStore(Connection);
impl ProcessingPresetStore {
    pub fn open(path: &Path) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        conn.execute_batch("CREATE TABLE IF NOT EXISTS processing_presets(name TEXT PRIMARY KEY, payload TEXT NOT NULL);").map_err(|e| e.to_string())?;
        Ok(Self(conn))
    }
    pub fn list(&self) -> Result<Vec<ProcessingPreset>, String> {
        let mut stmt = self
            .0
            .prepare("SELECT payload FROM processing_presets ORDER BY name")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.map(|row| {
            serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect()
    }
    pub fn save(&mut self, preset: &ProcessingPreset, overwrite: bool) -> Result<(), String> {
        preset.validate()?;
        let tx = self.0.transaction().map_err(|e| e.to_string())?;
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM processing_presets WHERE name=?1)",
                [&preset.name],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if exists && !overwrite {
            return Err("同名预设已存在，请确认覆盖。".into());
        }
        let count: u32 = tx
            .query_row("SELECT COUNT(*) FROM processing_presets", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if !exists && count >= 100 {
            return Err("最多保存 100 个预设，请先删除不再使用的预设。".into());
        }
        let payload = serde_json::to_string(preset).map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO processing_presets VALUES (?1,?2) ON CONFLICT(name) DO UPDATE SET payload=excluded.payload", params![preset.name, payload]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }
    pub fn replace_all(&mut self, presets: &[ProcessingPreset]) -> Result<(), String> {
        validate_presets(presets)?;
        let tx = self.0.transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM processing_presets", [])
            .map_err(|e| e.to_string())?;
        for preset in presets {
            let json = serde_json::to_string(preset).map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT INTO processing_presets VALUES (?1,?2)",
                params![preset.name, json],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn delete(&self, name: &str) -> Result<(), String> {
        self.0
            .execute("DELETE FROM processing_presets WHERE name=?1", [name])
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invalid_replacements_preserve_saved_presets() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = ProcessingPresetStore::open(&temp.path().join("presets.db")).unwrap();
        let preset = ProcessingPreset {
            name: "资料预设".into(),
            output_directory: None,
            recursive: true,
            compute_mode: RecoveryComputeMode::CpuOnly,
            dictionary_group: None,
            open_when_done: false,
        };
        store.save(&preset, false).unwrap();
        for name in ["", " 空白", "控制\n字符", &"名".repeat(81)] {
            let mut invalid = preset.clone();
            invalid.name = name.into();
            assert!(store.replace_all(&[invalid]).is_err());
        }
        let mut invalid = preset.clone();
        invalid.output_directory = Some("相对目录".into());
        assert!(store.replace_all(&[invalid]).is_err());
        assert!(
            store
                .replace_all(&[preset.clone(), preset.clone()])
                .is_err()
        );
        let presets: Vec<_> = (0..101)
            .map(|index| ProcessingPreset {
                name: format!("预设-{index:03}"),
                ..preset.clone()
            })
            .collect();
        assert!(store.replace_all(&presets).is_err());
        assert_eq!(store.list().unwrap()[0].name, preset.name);
        store.replace_all(&presets[..100]).unwrap();
        assert_eq!(store.list().unwrap().len(), 100);
        let mut absolute = presets[0].clone();
        absolute.output_directory = Some(temp.path().to_string_lossy().into_owned());
        store.save(&absolute, true).unwrap();
    }
    #[test]
    fn presets_survive_restart_and_require_explicit_overwrite() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("presets.db");
        let mut store = ProcessingPresetStore::open(&path).unwrap();
        let mut preset = ProcessingPreset {
            name: "资料归档".into(),
            output_directory: None,
            recursive: true,
            compute_mode: RecoveryComputeMode::CpuOnly,
            dictionary_group: Some("资料".into()),
            open_when_done: false,
        };
        store.save(&preset, false).unwrap();
        preset.recursive = false;
        assert!(store.save(&preset, false).is_err());
        store.save(&preset, true).unwrap();
        drop(store);
        let reopened = ProcessingPresetStore::open(&path).unwrap();
        assert!(!reopened.list().unwrap()[0].recursive);
        reopened.delete(&preset.name).unwrap();
        assert!(reopened.list().unwrap().is_empty());
    }
    #[test]
    fn preset_payload_rejects_password_fields() {
        let json = r#"{"name":"资料","outputDirectory":null,"recursive":true,"computeMode":"cpuOnly","dictionaryGroup":null,"openWhenDone":false,"knownPassword":"secret"}"#;
        assert!(serde_json::from_str::<ProcessingPreset>(json).is_err());
    }
}
