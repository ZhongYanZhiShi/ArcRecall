use crate::tools::{CompressionFormat, sanitize_archive_base_name};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Only reusable options. Credentials and credential-store references are never serialized.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompressionOptions {
    pub format: CompressionFormat,
    pub level: u8,
    pub encrypt_file_names: bool,
    pub output_directory: Option<String>,
}
impl CompressionOptions {
    pub fn validate(&self) -> Result<(), String> {
        if ![0, 1, 3, 5, 7, 9].contains(&self.level) {
            return Err("压缩级别必须是 0、1、3、5、7 或 9。".into());
        }
        if self.encrypt_file_names && self.format != CompressionFormat::SevenZip {
            return Err("仅 7z 格式支持文件名加密。".into());
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
    pub fn check_output(&self) -> Result<(), String> {
        self.validate()?;
        if self
            .output_directory
            .as_ref()
            .is_some_and(|p| !Path::new(p).is_dir())
        {
            return Err("输出目录已不存在或不可访问，请选择新的输出目录。".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompressionPreset {
    pub name: String,
    pub options: CompressionOptions,
    pub name_template: String,
    pub open_when_done: bool,
}
impl CompressionPreset {
    pub fn validate(&self) -> Result<(), String> {
        if self.name.trim() != self.name
            || self.name.is_empty()
            || self.name.chars().count() > 80
            || self.name.chars().any(char::is_control)
        {
            return Err("预设名称需为 1–80 个可见字符。".into());
        }
        self.options.validate()?;
        validate_name_template(&self.name_template)
    }
}
pub fn validate_name_template(template: &str) -> Result<(), String> {
    let literal = template
        .replace("{name}", "资料")
        .replace("{date}", "2026-01-01");
    if template.is_empty()
        || template.chars().count() > 120
        || literal.contains(['{', '}', '/', '\\'])
        || literal.chars().any(char::is_control)
    {
        return Err(
            "命名规则最多 120 字符，只支持 {name} 和 {date} 占位符，不允许路径分隔符。".into(),
        );
    }
    sanitize_archive_base_name(&literal).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompressionRecordOptions {
    pub options: CompressionOptions,
    pub base_name: String,
    /// A hint to request a fresh password, never the password or its storage reference.
    pub password_required: bool,
}
impl CompressionRecordOptions {
    pub fn validate(&self) -> Result<(), String> {
        self.options.validate()?;
        sanitize_archive_base_name(&self.base_name).map_err(|e| e.to_string())?;
        Ok(())
    }
}

pub struct CompressionPresetStore(Connection);
impl CompressionPresetStore {
    pub fn open(path: &Path) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        conn.execute_batch("CREATE TABLE IF NOT EXISTS compression_presets(name TEXT PRIMARY KEY, payload TEXT NOT NULL);").map_err(|e| e.to_string())?;
        Ok(Self(conn))
    }
    pub fn list(&self) -> Result<Vec<CompressionPreset>, String> {
        let mut stmt = self
            .0
            .prepare("SELECT payload FROM compression_presets ORDER BY name")
            .map_err(|e| e.to_string())?;
        stmt.query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .map(|row| {
                let preset: CompressionPreset =
                    serde_json::from_str(&row.map_err(|e| e.to_string())?)
                        .map_err(|e| e.to_string())?;
                preset.validate()?;
                Ok(preset)
            })
            .collect()
    }
    pub fn save(&mut self, preset: &CompressionPreset, overwrite: bool) -> Result<(), String> {
        preset.validate()?;
        let tx = self.0.transaction().map_err(|e| e.to_string())?;
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM compression_presets WHERE name=?1)",
                [&preset.name],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if exists && !overwrite {
            return Err("同名压缩预设已存在，请确认覆盖。".into());
        }
        let count: u32 = tx
            .query_row("SELECT COUNT(*) FROM compression_presets", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if !exists && count >= 100 {
            return Err("最多保存 100 个压缩预设。".into());
        }
        tx.execute("INSERT INTO compression_presets VALUES(?1,?2) ON CONFLICT(name) DO UPDATE SET payload=excluded.payload", params![preset.name, serde_json::to_string(preset).map_err(|e| e.to_string())?]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }
    pub fn delete(&self, name: &str) -> Result<(), String> {
        self.0
            .execute("DELETE FROM compression_presets WHERE name=?1", [name])
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn replace_all(&mut self, presets: &[CompressionPreset]) -> Result<(), String> {
        let mut names = std::collections::HashSet::new();
        if presets.len() > 100 {
            return Err("压缩预设超过 100 个。".into());
        }
        for preset in presets {
            preset.validate()?;
            if !names.insert(&preset.name) {
                return Err("压缩预设名称重复。".into());
            }
        }
        let tx = self.0.transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM compression_presets", [])
            .map_err(|e| e.to_string())?;
        for preset in presets {
            tx.execute(
                "INSERT INTO compression_presets VALUES(?1,?2)",
                params![
                    preset.name,
                    serde_json::to_string(preset).map_err(|e| e.to_string())?
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    pub fn fixture() -> CompressionPreset {
        CompressionPreset {
            name: "资料压缩".into(),
            options: CompressionOptions {
                format: CompressionFormat::SevenZip,
                level: 5,
                encrypt_file_names: true,
                output_directory: None,
            },
            name_template: "{name}-{date}".into(),
            open_when_done: false,
        }
    }
    #[test]
    fn preset_limit_allows_overwrite_and_invalid_replacement_preserves_existing_rows() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = CompressionPresetStore::open(&directory.path().join("presets.db")).unwrap();
        let mut presets = Vec::new();
        for index in 0..100 {
            let mut preset = fixture();
            preset.name = format!("资料预设-{index}");
            presets.push(preset);
        }
        store.replace_all(&presets).unwrap();
        assert!(store.save(&fixture(), false).is_err());
        presets[0].options.level = 9;
        store.save(&presets[0], true).unwrap();
        presets.push(fixture());
        assert!(store.replace_all(&presets).is_err());
        assert!(store.replace_all(&[fixture(), fixture()]).is_err());
        assert_eq!(store.list().unwrap().len(), 100);
        assert_eq!(store.list().unwrap()[0].options.level, 9);
    }

    #[test]
    fn presets_persist_require_overwrite_and_reject_credentials_and_invalid_rules() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("presets.db");
        let mut store = CompressionPresetStore::open(&path).unwrap();
        let mut preset = fixture();
        store.save(&preset, false).unwrap();
        preset.options.level = 9;
        assert!(store.save(&preset, false).is_err());
        store.save(&preset, true).unwrap();
        assert_eq!(
            CompressionPresetStore::open(&path).unwrap().list().unwrap()[0]
                .options
                .level,
            9
        );
        let mut json = serde_json::to_value(&preset).unwrap();
        json["password"] = "secret".into();
        assert!(serde_json::from_value::<CompressionPreset>(json).is_err());
        assert!(validate_name_template("../{name}").is_err());
        assert!(validate_name_template("{unknown}").is_err());
        preset.options.format = CompressionFormat::Zip;
        assert!(store.replace_all(&[preset]).is_err());
        assert_eq!(store.list().unwrap().len(), 1);
        store.delete("资料压缩").unwrap();
        assert!(store.list().unwrap().is_empty());
    }
}
