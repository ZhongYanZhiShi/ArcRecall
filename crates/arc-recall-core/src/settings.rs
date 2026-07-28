use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::tools::RecoveryComputeMode;

pub const DEFAULT_LOG_MAX_DISK_MIB: u16 = 25;
pub const MIN_LOG_MAX_DISK_MIB: u16 = 5;
pub const MAX_LOG_MAX_DISK_MIB: u16 = 500;
pub const CURRENT_SETTINGS_VERSION: u32 = 1;
pub const DEFAULT_AI_RENAME_PROMPT: &str = "在保留原意的前提下，将用户提供的归档基础名称改写为简洁、可读、适合文件系统的名称；只返回名称，不返回扩展名或解释。";

/// Maximum log verbosity persisted by the desktop application.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum AppLogLevel {
    Error,
    Warn,
    #[default]
    Info,
    Debug,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoggingSettings {
    #[serde(default)]
    pub level: AppLogLevel,
    #[serde(default = "default_log_max_disk_mib")]
    pub max_disk_mib: u16,
}

impl Default for LoggingSettings {
    fn default() -> Self {
        Self {
            level: AppLogLevel::default(),
            max_disk_mib: DEFAULT_LOG_MAX_DISK_MIB,
        }
    }
}

impl LoggingSettings {
    pub fn has_valid_disk_limit(&self) -> bool {
        (MIN_LOG_MAX_DISK_MIB..=MAX_LOG_MAX_DISK_MIB).contains(&self.max_disk_mib)
    }

    fn normalize(&mut self) {
        self.max_disk_mib = self
            .max_disk_mib
            .clamp(MIN_LOG_MAX_DISK_MIB, MAX_LOG_MAX_DISK_MIB);
    }
}

const fn default_log_max_disk_mib() -> u16 {
    DEFAULT_LOG_MAX_DISK_MIB
}

/// External cracking / engine tool paths.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EngineSettings {
    /// Shared public directory for downloaded engines (hashcat 等).
    /// Empty = use default `{LocalAppData}/ArcRecall/tools`.
    #[serde(default)]
    pub tools_directory: String,
    /// Absolute path to hashcat.exe (or empty if not configured).
    #[serde(default)]
    pub hashcat_path: String,
    /// Absolute path to John tools directory (7z2john / rar2john).
    #[serde(default)]
    pub john_tools_directory: String,
    /// Absolute path to perl.exe (for 7z2john.pl).
    #[serde(default)]
    pub perl_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RecoverySettings {
    #[serde(default)]
    pub compute_mode: RecoveryComputeMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum AiProviderKind {
    DeepSeek,
    Ollama,
    LmStudio,
    #[default]
    Custom,
}

impl AiProviderKind {
    pub const fn default_base_url(self) -> &'static str {
        match self {
            Self::DeepSeek => "https://api.deepseek.com/v1",
            Self::Ollama => "http://127.0.0.1:11434/v1",
            Self::LmStudio => "http://127.0.0.1:1234/v1",
            Self::Custom => "",
        }
    }

    pub const fn default_model(self) -> &'static str {
        match self {
            Self::DeepSeek => "deepseek-chat",
            Self::Ollama | Self::LmStudio | Self::Custom => "",
        }
    }

    pub const fn is_local(self) -> bool {
        matches!(self, Self::Ollama | Self::LmStudio)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProfile {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub provider: AiProviderKind,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub model: String,
}

impl AiProfile {
    pub fn normalize(&mut self) {
        self.id = self.id.trim().to_string();
        self.name = self.name.trim().to_string();
        self.base_url = self.base_url.trim().trim_end_matches('/').to_string();
        self.model = self.model.trim().to_string();
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSettings {
    #[serde(default)]
    pub profiles: Vec<AiProfile>,
    #[serde(default)]
    pub active_profile_id: String,
    #[serde(default = "default_ai_rename_prompt")]
    pub rename_prompt: String,
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            profiles: Vec::new(),
            active_profile_id: String::new(),
            rename_prompt: DEFAULT_AI_RENAME_PROMPT.into(),
        }
    }
}

impl AiSettings {
    fn normalize(&mut self) {
        for profile in &mut self.profiles {
            profile.normalize();
        }
        self.profiles.retain(|profile| {
            !profile.id.is_empty() && !profile.name.is_empty() && !profile.base_url.is_empty()
        });
        let mut seen = std::collections::HashSet::new();
        self.profiles
            .retain(|profile| seen.insert(profile.id.to_ascii_lowercase()));
        if !self
            .profiles
            .iter()
            .any(|profile| profile.id == self.active_profile_id)
        {
            self.active_profile_id = self
                .profiles
                .first()
                .map(|profile| profile.id.clone())
                .unwrap_or_default();
        }
        self.rename_prompt = self.rename_prompt.trim().to_string();
        if self.rename_prompt.is_empty() {
            self.rename_prompt = DEFAULT_AI_RENAME_PROMPT.into();
        }
    }
}

/// Application preferences stored in settings.json.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default = "default_settings_version")]
    pub version: u32,
    #[serde(default)]
    pub engine: EngineSettings,
    #[serde(default)]
    pub logging: LoggingSettings,
    #[serde(default)]
    pub ai: AiSettings,
    #[serde(default)]
    pub recovery: RecoverySettings,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            version: CURRENT_SETTINGS_VERSION,
            engine: EngineSettings::default(),
            logging: LoggingSettings::default(),
            ai: AiSettings::default(),
            recovery: RecoverySettings::default(),
        }
    }
}

impl AppSettings {
    fn normalize(&mut self) {
        self.version = CURRENT_SETTINGS_VERSION;
        self.logging.normalize();
        self.ai.normalize();
    }
}

const fn default_settings_version() -> u32 {
    CURRENT_SETTINGS_VERSION
}

fn default_ai_rename_prompt() -> String {
    DEFAULT_AI_RENAME_PROMPT.into()
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
        let mut settings = serde_json::from_str::<AppSettings>(&raw)?;
        settings.normalize();
        Ok(settings)
    }

    pub fn save(&self, settings: &AppSettings) -> Result<(), SettingsError> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut normalized = settings.clone();
        normalized.normalize();
        let json = serde_json::to_string_pretty(&normalized)?;
        fs::write(&self.path, json)?;
        Ok(())
    }

    pub fn save_hashcat_path(&self, hashcat_path: &str) -> Result<AppSettings, SettingsError> {
        let mut settings = self.load()?;
        settings.engine.hashcat_path = hashcat_path.trim().to_string();
        self.save(&settings)?;
        Ok(settings)
    }

    pub fn save_tools_directory(
        &self,
        tools_directory: &str,
    ) -> Result<AppSettings, SettingsError> {
        let mut settings = self.load()?;
        settings.engine.tools_directory = tools_directory.trim().to_string();
        self.save(&settings)?;
        Ok(settings)
    }

    pub fn save_john_perl(
        &self,
        john_tools_directory: &str,
        perl_path: &str,
    ) -> Result<AppSettings, SettingsError> {
        let mut settings = self.load()?;
        settings.engine.john_tools_directory = john_tools_directory.trim().to_string();
        settings.engine.perl_path = perl_path.trim().to_string();
        self.save(&settings)?;
        Ok(settings)
    }
}

/// Resolve the effective tools root: custom setting if set, else app default.
pub fn resolve_tools_directory(default_tools: &Path, configured_tools_directory: &str) -> PathBuf {
    let custom = configured_tools_directory.trim();
    if custom.is_empty() {
        return default_tools.to_path_buf();
    }
    PathBuf::from(custom)
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
    pub logs_path: String,
    pub tools_path: String,
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
        let loaded = store.load().unwrap();
        assert!(loaded.engine.hashcat_path.is_empty());
        assert_eq!(loaded.logging.level, AppLogLevel::Info);
        assert_eq!(loaded.logging.max_disk_mib, DEFAULT_LOG_MAX_DISK_MIB);
    }

    #[test]
    fn loads_default_log_capacity_from_older_settings() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(
            &path,
            r#"{"version":0,"engine":{},"logging":{"level":"debug"}}"#,
        )
        .unwrap();

        let loaded = SettingsStore::open(&path).unwrap().load().unwrap();

        assert_eq!(loaded.logging.level, AppLogLevel::Debug);
        assert_eq!(loaded.logging.max_disk_mib, DEFAULT_LOG_MAX_DISK_MIB);
        assert_eq!(loaded.version, CURRENT_SETTINGS_VERSION);
        assert!(loaded.ai.profiles.is_empty());
        assert_eq!(loaded.ai.rename_prompt, DEFAULT_AI_RENAME_PROMPT);
    }

    #[test]
    fn saves_ai_profiles_without_secret_fields() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let store = SettingsStore::open(&path).unwrap();
        let mut settings = store.load().unwrap();
        settings.ai.profiles.push(AiProfile {
            id: "local-ollama".into(),
            name: "本机 Ollama".into(),
            provider: AiProviderKind::Ollama,
            base_url: "http://127.0.0.1:11434/v1/".into(),
            model: "qwen3".into(),
        });
        settings.ai.active_profile_id = "local-ollama".into();
        store.save(&settings).unwrap();

        let raw = fs::read_to_string(&path).unwrap();
        assert!(raw.contains("local-ollama"));
        assert!(!raw.to_ascii_lowercase().contains("apikey"));
        assert!(!raw.to_ascii_lowercase().contains("password"));
        assert_eq!(
            store.load().unwrap().ai.profiles[0].base_url,
            "http://127.0.0.1:11434/v1"
        );
    }

    #[test]
    fn clamps_manually_edited_log_capacity() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(
            &path,
            r#"{"version":0,"engine":{},"logging":{"maxDiskMib":65535}}"#,
        )
        .unwrap();

        let loaded = SettingsStore::open(&path).unwrap().load().unwrap();

        assert_eq!(loaded.logging.max_disk_mib, MAX_LOG_MAX_DISK_MIB);
    }

    #[test]
    fn saves_hashcat_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let store = SettingsStore::open(&path).unwrap();
        store
            .save_hashcat_path(r"C:\tools\hashcat\hashcat.exe")
            .unwrap();
        assert_eq!(
            store.load().unwrap().engine.hashcat_path,
            r"C:\tools\hashcat\hashcat.exe"
        );
    }

    #[test]
    fn resolve_tools_directory_uses_default_when_empty() {
        let default = PathBuf::from(concat!(r"C:\", "Users", r"\me\AppData\Local\ArcRecall\tools"));
        assert_eq!(resolve_tools_directory(&default, ""), default);
        assert_eq!(
            resolve_tools_directory(&default, r"D:\Shared\ArcTools"),
            PathBuf::from(r"D:\Shared\ArcTools")
        );
    }
}
