use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Reserved for future preferences (compress defaults, log level, etc.).
/// Dictionary import encoding is auto-detected and is not user-selectable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default)]
    pub version: u32,
}

#[derive(Debug, thiserror::Error)]
pub enum SettingsError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

/// Load/save `settings.json` next to the SQLite database.
pub struct SettingsStore {
    path: PathBuf,
}

impl SettingsStore {
    pub fn open(path: impl Into<PathBuf>) -> Result<Self, SettingsError> {
        let path = path.into();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let store = Self { path };
        if !store.path.is_file() {
            store.save(&AppSettings::default())?;
        }
        Ok(store)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn load(&self) -> Result<AppSettings, SettingsError> {
        if !self.path.is_file() {
            let defaults = AppSettings::default();
            self.save(&defaults)?;
            return Ok(defaults);
        }
        let raw = fs::read_to_string(&self.path)?;
        if raw.trim().is_empty() {
            let defaults = AppSettings::default();
            self.save(&defaults)?;
            return Ok(defaults);
        }
        Ok(serde_json::from_str(&raw)?)
    }

    pub fn save(&self, settings: &AppSettings) -> Result<(), SettingsError> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(settings)?;
        fs::write(&self.path, json)?;
        Ok(())
    }
}

/// Runtime info about on-disk data files (shown in Settings → 数据).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseInfo {
    pub path: String,
    pub exists: bool,
    pub candidate_count: u64,
    pub settings_path: String,
    pub root_path: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_default_settings_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let store = SettingsStore::open(&path).unwrap();
        assert!(path.is_file());
        let _ = store.load().unwrap();
    }
}
