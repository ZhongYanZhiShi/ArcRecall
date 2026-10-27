use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::tools::{DEFAULT_SCAN_MAX_FILES_PER_DIRECTORY, RecoveryComputeMode};

pub const DEFAULT_LOG_MAX_DISK_MIB: u16 = 25;
pub const MIN_LOG_MAX_DISK_MIB: u16 = 5;
pub const MAX_LOG_MAX_DISK_MIB: u16 = 500;
pub const CURRENT_SETTINGS_VERSION: u32 = 1;
pub const DEFAULT_AI_RENAME_PROMPT: &str = "命名规则要以windows的文件命名规则来进行";
const LEGACY_AI_RENAME_PROMPT: &str = "在保留原意的前提下，将用户提供的归档基础名称改写为简洁、可读、适合文件系统的名称；只返回名称，不返回扩展名或解释。";

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum SettingsUpdate {
    AutoUpdate(bool),
    ExtractionLimits(ExtractionLimits),
    LogLevel(AppLogLevel),
    LogMaxDiskMib(u16),
    RecoveryComputeMode(RecoveryComputeMode),
    ScanMaxFilesPerDirectory(u32),
    RemoveEmptyDirectories(bool),
    FlattenOutputDirectories(bool),
    CompressionNaming(CompressionNamingSettings),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ExtractionLimits {
    pub max_gib: u32,
    pub max_entries: u32,
    pub max_depth: u32,
}
impl Default for ExtractionLimits {
    fn default() -> Self {
        Self {
            max_gib: 100,
            max_entries: 100_000,
            max_depth: crate::tools::DEFAULT_RECURSIVE_MAX_DEPTH,
        }
    }
}
impl ExtractionLimits {
    pub fn validate(&self) -> bool {
        (1..=100_000).contains(&self.max_gib)
            && (1..=10_000_000).contains(&self.max_entries)
            && (1..=64).contains(&self.max_depth)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressionNamingSettings {
    #[serde(default)]
    pub use_ai_rename: bool,
    #[serde(default)]
    pub use_ai_file_reference: bool,
    #[serde(default = "default_reference_extensions")]
    pub selected_extensions: Vec<String>,
    #[serde(default)]
    pub custom_extensions: Vec<String>,
}

fn default_reference_extensions() -> Vec<String> {
    vec!["txt".into(), "md".into()]
}

impl Default for CompressionNamingSettings {
    fn default() -> Self {
        Self {
            use_ai_rename: false,
            use_ai_file_reference: false,
            selected_extensions: default_reference_extensions(),
            custom_extensions: Vec::new(),
        }
    }
}

impl CompressionNamingSettings {
    fn is_valid(&self) -> bool {
        self.selected_extensions.len() <= 32
            && self
                .selected_extensions
                .iter()
                .chain(&self.custom_extensions)
                .all(|extension| {
                    !extension.is_empty()
                        && extension.len() <= 32
                        && !extension.starts_with('.')
                        && !extension.ends_with('.')
                        && extension.bytes().all(|byte| {
                            byte.is_ascii_alphanumeric()
                                || matches!(byte, b'.' | b'_' | b'-' | b'+')
                        })
                })
    }
}

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverySettings {
    #[serde(default)]
    pub extraction_limits: ExtractionLimits,
    #[serde(default)]
    pub compute_mode: RecoveryComputeMode,
    #[serde(default = "default_scan_max_files_per_directory")]
    pub scan_max_files_per_directory: u32,
    #[serde(default = "default_remove_empty_directories")]
    pub remove_empty_directories: bool,
    #[serde(default = "default_flatten_output_directories")]
    pub flatten_output_directories: bool,
}

const fn default_remove_empty_directories() -> bool {
    true
}

const fn default_flatten_output_directories() -> bool {
    true
}

const fn default_scan_max_files_per_directory() -> u32 {
    DEFAULT_SCAN_MAX_FILES_PER_DIRECTORY
}

impl Default for RecoverySettings {
    fn default() -> Self {
        Self {
            extraction_limits: ExtractionLimits::default(),
            compute_mode: RecoveryComputeMode::default(),
            scan_max_files_per_directory: default_scan_max_files_per_directory(),
            remove_empty_directories: default_remove_empty_directories(),
            flatten_output_directories: default_flatten_output_directories(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum AiProviderKind {
    Ollama,
    LmStudio,
    #[default]
    #[serde(alias = "deepSeek")]
    Custom,
}

impl AiProviderKind {
    pub const fn default_base_url(self) -> &'static str {
        match self {
            Self::Ollama => "http://127.0.0.1:11434/v1",
            Self::LmStudio => "http://127.0.0.1:1234/v1",
            Self::Custom => "",
        }
    }

    pub const fn default_model(self) -> &'static str {
        match self {
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
        if self.rename_prompt.is_empty() || self.rename_prompt == LEGACY_AI_RENAME_PROMPT {
            self.rename_prompt = DEFAULT_AI_RENAME_PROMPT.into();
        }
    }
}

/// Application preferences stored in settings.json.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    /// Enable scheduled checks and signed update downloads.
    #[serde(default = "default_auto_update")]
    pub auto_update: bool,
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
    #[serde(default)]
    pub compression_naming: CompressionNamingSettings,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            version: CURRENT_SETTINGS_VERSION,
            auto_update: default_auto_update(),
            engine: EngineSettings::default(),
            logging: LoggingSettings::default(),
            ai: AiSettings::default(),
            recovery: RecoverySettings::default(),
            compression_naming: CompressionNamingSettings::default(),
        }
    }
}

impl AppSettings {
    fn normalize(&mut self) {
        self.version = CURRENT_SETTINGS_VERSION;
        self.logging.normalize();
        if !self.recovery.extraction_limits.validate() {
            self.recovery.extraction_limits = ExtractionLimits::default();
        }
        self.ai.normalize();
    }
}

const fn default_settings_version() -> u32 {
    CURRENT_SETTINGS_VERSION
}

const fn default_auto_update() -> bool {
    true
}

fn default_ai_rename_prompt() -> String {
    DEFAULT_AI_RENAME_PROMPT.into()
}

#[derive(Debug, thiserror::Error)]
pub enum SettingsError {
    #[error("日志最大占用必须在 {MIN_LOG_MAX_DISK_MIB}–{MAX_LOG_MAX_DISK_MIB} MiB 之间。")]
    InvalidLogDiskLimit,
    #[error("解压限制无效：体积 1–100000 GiB，条目 1–10000000，深度 1–64。")]
    InvalidExtractionLimits,
    #[error("参考文件后缀无效，后缀长度须为 1–32 个字符，最多可选 32 种。")]
    InvalidCompressionNaming,
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
    /// Callers serialize this read-modify-write with all other settings writers.
    pub fn update_preferences(&self, update: SettingsUpdate) -> Result<AppSettings, SettingsError> {
        let mut settings = self.load()?;
        match update {
            SettingsUpdate::ExtractionLimits(value) => {
                if !value.validate() {
                    return Err(SettingsError::InvalidExtractionLimits);
                }
                settings.recovery.extraction_limits = value;
            }
            SettingsUpdate::AutoUpdate(value) => settings.auto_update = value,
            SettingsUpdate::LogLevel(value) => settings.logging.level = value,
            SettingsUpdate::LogMaxDiskMib(value) => {
                settings.logging.max_disk_mib = value;
                if !settings.logging.has_valid_disk_limit() {
                    return Err(SettingsError::InvalidLogDiskLimit);
                }
            }
            SettingsUpdate::RecoveryComputeMode(value) => settings.recovery.compute_mode = value,
            SettingsUpdate::ScanMaxFilesPerDirectory(value) => {
                settings.recovery.scan_max_files_per_directory = value
            }
            SettingsUpdate::RemoveEmptyDirectories(value) => {
                settings.recovery.remove_empty_directories = value
            }
            SettingsUpdate::FlattenOutputDirectories(value) => {
                settings.recovery.flatten_output_directories = value
            }
            SettingsUpdate::CompressionNaming(value) => {
                if !value.is_valid() {
                    return Err(SettingsError::InvalidCompressionNaming);
                }
                settings.compression_naming = value;
            }
        }
        self.save(&settings)?;
        Ok(settings)
    }

    pub fn open(path: impl Into<PathBuf>) -> Result<Self, SettingsError> {
        let path = path.into();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let store = Self { path };
        if !store.path.is_file() {
            let backup_path = settings_backup_path(&store.path);
            let initial = if backup_path.is_file() {
                read_settings(&backup_path).unwrap_or_default()
            } else {
                AppSettings::default()
            };
            store.save_without_backup(&initial)?;
        }
        Ok(store)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn load(&self) -> Result<AppSettings, SettingsError> {
        if !self.path.is_file() {
            return self.recover_settings();
        }

        match read_settings(&self.path) {
            Ok(settings) => Ok(settings),
            Err(SettingsError::Json(_)) => self.recover_settings(),
            Err(SettingsError::Io(error)) if error.kind() == std::io::ErrorKind::InvalidData => {
                self.recover_settings()
            }
            Err(error) => Err(error),
        }
    }

    pub fn save(&self, settings: &AppSettings) -> Result<(), SettingsError> {
        if self.path.is_file()
            && read_settings(&self.path).is_ok()
            && let Ok(existing) = fs::read(&self.path)
        {
            atomic_write(&settings_backup_path(&self.path), &existing)?;
        }
        self.save_without_backup(settings)
    }

    fn save_without_backup(&self, settings: &AppSettings) -> Result<(), SettingsError> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut normalized = settings.clone();
        normalized.normalize();
        let json = serde_json::to_string_pretty(&normalized)?;
        atomic_write(&self.path, json.as_bytes())?;
        Ok(())
    }

    fn recover_settings(&self) -> Result<AppSettings, SettingsError> {
        let backup_path = settings_backup_path(&self.path);
        let recovered = if backup_path.is_file() {
            read_settings(&backup_path).ok()
        } else {
            None
        };
        let settings = recovered.unwrap_or_default();
        self.save_without_backup(&settings)?;
        Ok(settings)
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

fn read_settings(path: &Path) -> Result<AppSettings, SettingsError> {
    let raw = fs::read_to_string(path)?;
    let mut settings = serde_json::from_str::<AppSettings>(&raw)?;
    settings.normalize();
    Ok(settings)
}

fn settings_backup_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("settings.json");
    path.with_file_name(format!("{file_name}.bak"))
}

fn atomic_write(path: &Path, content: &[u8]) -> Result<(), SettingsError> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    temporary.write_all(content)?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(path)
        .map_err(|error| SettingsError::Io(error.error))?;

    #[cfg(unix)]
    fs::File::open(parent)?.sync_all()?;

    Ok(())
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
    fn extraction_limits_validate_and_survive_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let store = SettingsStore::open(&path).unwrap();
        let limits = super::ExtractionLimits {
            max_gib: 8,
            max_entries: 500,
            max_depth: 3,
        };
        store
            .update_preferences(SettingsUpdate::ExtractionLimits(limits.clone()))
            .unwrap();
        assert_eq!(
            SettingsStore::open(&path)
                .unwrap()
                .load()
                .unwrap()
                .recovery
                .extraction_limits,
            limits
        );
        assert!(
            store
                .update_preferences(SettingsUpdate::ExtractionLimits(super::ExtractionLimits {
                    max_depth: 0,
                    ..limits.clone()
                }))
                .is_err()
        );
        assert_eq!(store.load().unwrap().recovery.extraction_limits, limits);
    }

    #[test]
    fn compression_naming_tags_and_selection_survive_reopen_and_deletion() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        fs::write(
            &path,
            r#"{"autoUpdate":false,"engine":{"hashcatPath":"keep-engine"}}"#,
        )
        .unwrap();
        let store = SettingsStore::open(&path).unwrap();
        assert_eq!(
            store.load().unwrap().compression_naming,
            CompressionNamingSettings::default()
        );
        let preferences = CompressionNamingSettings {
            use_ai_rename: true,
            use_ai_file_reference: true,
            selected_extensions: vec!["md".into(), "custom".into()],
            custom_extensions: vec!["custom".into(), "unselected".into()],
        };
        store
            .update_preferences(SettingsUpdate::CompressionNaming(preferences.clone()))
            .unwrap();
        let reopened = SettingsStore::open(&path).unwrap().load().unwrap();
        assert_eq!(reopened.compression_naming, preferences);
        assert!(!reopened.auto_update);
        assert_eq!(reopened.engine.hashcat_path, "keep-engine");
        store
            .update_preferences(SettingsUpdate::CompressionNaming(
                CompressionNamingSettings {
                    selected_extensions: Vec::new(),
                    custom_extensions: vec!["unselected".into()],
                    ..preferences.clone()
                },
            ))
            .unwrap();
        let reopened = SettingsStore::open(&path).unwrap().load().unwrap();
        assert!(reopened.compression_naming.selected_extensions.is_empty());
        assert_eq!(
            reopened.compression_naming.custom_extensions,
            ["unselected"]
        );
        assert!(
            store
                .update_preferences(SettingsUpdate::CompressionNaming(
                    CompressionNamingSettings {
                        selected_extensions: vec!["../txt".into()],
                        custom_extensions: Vec::new(),
                        ..CompressionNamingSettings::default()
                    }
                ))
                .is_err()
        );
        assert_eq!(store.load().unwrap(), reopened);
    }

    #[test]
    fn compression_naming_switches_migrate_and_persist_independently() {
        let legacy: CompressionNamingSettings =
            serde_json::from_str(r#"{"selectedExtensions":["md"],"customExtensions":["rst"]}"#)
                .unwrap();
        assert!(!legacy.use_ai_rename);
        assert!(!legacy.use_ai_file_reference);
        assert_eq!(legacy.selected_extensions, ["md"]);
        assert_eq!(legacy.custom_extensions, ["rst"]);
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let store = SettingsStore::open(&path).unwrap();
        for (use_ai_rename, use_ai_file_reference) in
            [(true, true), (false, true), (true, false), (false, false)]
        {
            let preferences = CompressionNamingSettings {
                use_ai_rename,
                use_ai_file_reference,
                ..legacy.clone()
            };
            store
                .update_preferences(SettingsUpdate::CompressionNaming(preferences.clone()))
                .unwrap();
            assert_eq!(
                SettingsStore::open(&path)
                    .unwrap()
                    .load()
                    .unwrap()
                    .compression_naming,
                preferences
            );
        }
    }

    #[test]
    fn automatic_updates_default_on_and_toggle_without_changing_other_preferences() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        std::fs::write(&path, r#"{"engine":{"hashcatPath":"test-engine"}}"#).unwrap();
        let store = super::SettingsStore::open(&path).unwrap();
        let before = store.load().unwrap();
        assert!(before.auto_update);
        store
            .update_preferences(super::SettingsUpdate::AutoUpdate(false))
            .unwrap();
        let mut after = super::SettingsStore::open(&path).unwrap().load().unwrap();
        assert!(!after.auto_update);
        after.auto_update = true;
        assert_eq!(before, after);
        store
            .update_preferences(super::SettingsUpdate::AutoUpdate(true))
            .unwrap();
        assert!(store.load().unwrap().auto_update);
    }

    #[test]
    fn preference_updates_preserve_installed_paths_and_other_preferences() {
        let directory = tempfile::tempdir().unwrap();
        let store = SettingsStore::open(directory.path().join("settings.json")).unwrap();
        let mut installed = store.load().unwrap();
        installed.engine.hashcat_path = "newly-installed-hashcat".into();
        installed.ai.rename_prompt = "keep this prompt".into();
        store.save(&installed).unwrap();
        store
            .update_preferences(SettingsUpdate::RecoveryComputeMode(
                RecoveryComputeMode::CpuOnly,
            ))
            .unwrap();
        store
            .update_preferences(SettingsUpdate::ScanMaxFilesPerDirectory(3))
            .unwrap();
        store
            .update_preferences(SettingsUpdate::RemoveEmptyDirectories(false))
            .unwrap();
        store
            .update_preferences(SettingsUpdate::LogLevel(AppLogLevel::Debug))
            .unwrap();
        let saved = store
            .update_preferences(SettingsUpdate::LogMaxDiskMib(100))
            .unwrap();
        assert_eq!(saved.engine, installed.engine);
        assert_eq!(saved.ai, installed.ai);
        assert_eq!(saved.recovery.compute_mode, RecoveryComputeMode::CpuOnly);
        assert_eq!(saved.recovery.scan_max_files_per_directory, 3);
        assert!(!saved.recovery.remove_empty_directories);
        assert_eq!(saved.logging.level, AppLogLevel::Debug);
        assert_eq!(saved.logging.max_disk_mib, 100);
        assert!(
            store
                .update_preferences(SettingsUpdate::LogMaxDiskMib(0))
                .is_err()
        );
        assert_eq!(store.load().unwrap(), saved);
    }

    #[test]
    fn scan_limit_defaults_for_legacy_settings_and_survives_reload() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        fs::write(&path, r#"{"recovery":{"computeMode":"cpuOnly"}}"#).unwrap();
        let store = SettingsStore::open(&path).unwrap();
        let mut settings = store.load().unwrap();
        assert_eq!(settings.recovery.scan_max_files_per_directory, 10);
        assert!(settings.recovery.remove_empty_directories);
        assert!(settings.recovery.flatten_output_directories);
        assert_eq!(settings.recovery.compute_mode, RecoveryComputeMode::CpuOnly);
        for limit in [0, 3, 10, 100] {
            settings.recovery.scan_max_files_per_directory = limit;
            store.save(&settings).unwrap();
            assert_eq!(
                store.load().unwrap().recovery.scan_max_files_per_directory,
                limit
            );
        }
        assert!(
            serde_json::from_str::<RecoverySettings>(r#"{"scanMaxFilesPerDirectory":-1}"#).is_err()
        );
        assert!(
            serde_json::from_str::<RecoverySettings>(r#"{"scanMaxFilesPerDirectory":1.5}"#)
                .is_err()
        );
    }

    #[test]
    fn empty_directory_cleanup_setting_survives_reload() {
        let directory = tempfile::tempdir().unwrap();
        let store = SettingsStore::open(directory.path().join("settings.json")).unwrap();
        for value in [false, true] {
            let update = serde_json::from_value(serde_json::json!({
                "kind": "removeEmptyDirectories",
                "value": value,
            }))
            .unwrap();
            store.update_preferences(update).unwrap();
            assert_eq!(
                store.load().unwrap().recovery.remove_empty_directories,
                value
            );
        }
    }

    #[test]
    fn flatten_setting_survives_reload_without_changing_empty_cleanup() {
        let directory = tempfile::tempdir().unwrap();
        let store = SettingsStore::open(directory.path().join("settings.json")).unwrap();
        for value in [false, true] {
            let update = serde_json::from_value(serde_json::json!({
                "kind": "flattenOutputDirectories", "value": value,
            }))
            .unwrap();
            store.update_preferences(update).unwrap();
            let saved = store.load().unwrap();
            assert_eq!(saved.recovery.flatten_output_directories, value);
            assert!(saved.recovery.remove_empty_directories);
        }
    }

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
        assert!(loaded.recovery.remove_empty_directories);
        assert!(loaded.recovery.flatten_output_directories);
        assert!(crate::tools::RecursiveRecoveryOptions::default().flatten_output_directories);
    }

    #[test]
    fn recovers_a_corrupt_primary_file_from_the_last_valid_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let store = SettingsStore::open(&path).unwrap();
        let mut previous = store.load().unwrap();
        previous.engine.hashcat_path = "previous-hashcat".into();
        store.save(&previous).unwrap();

        let mut latest = previous.clone();
        latest.engine.hashcat_path = "latest-hashcat".into();
        store.save(&latest).unwrap();
        fs::write(&path, "{truncated").unwrap();

        let recovered = store.load().unwrap();

        assert_eq!(recovered.engine.hashcat_path, "previous-hashcat");
        assert_eq!(read_settings(&path).unwrap(), recovered);
    }

    #[test]
    fn recovers_a_missing_primary_file_from_the_last_valid_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let store = SettingsStore::open(&path).unwrap();
        let mut previous = store.load().unwrap();
        previous.engine.hashcat_path = "previous-hashcat".into();
        store.save(&previous).unwrap();
        let mut latest = previous.clone();
        latest.engine.hashcat_path = "latest-hashcat".into();
        store.save(&latest).unwrap();
        fs::remove_file(&path).unwrap();

        let reopened = SettingsStore::open(&path).unwrap();

        assert_eq!(
            reopened.load().unwrap().engine.hashcat_path,
            "previous-hashcat"
        );
    }

    #[test]
    fn load_recovers_a_primary_file_removed_after_the_store_was_opened() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let store = SettingsStore::open(&path).unwrap();
        let mut previous = store.load().unwrap();
        previous.engine.hashcat_path = "previous-hashcat".into();
        store.save(&previous).unwrap();
        let mut latest = previous.clone();
        latest.engine.hashcat_path = "latest-hashcat".into();
        store.save(&latest).unwrap();
        fs::remove_file(&path).unwrap();

        assert_eq!(store.load().unwrap(), previous);
        assert_eq!(read_settings(&path).unwrap(), previous);
        assert_eq!(
            read_settings(&settings_backup_path(&path)).unwrap(),
            previous
        );
    }

    #[test]
    fn replaces_an_unrecoverable_settings_file_with_safe_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, "not-json").unwrap();
        let store = SettingsStore::open(&path).unwrap();

        let recovered = store.load().unwrap();

        assert_eq!(recovered, AppSettings::default());
        assert_eq!(read_settings(&path).unwrap(), AppSettings::default());
    }

    #[test]
    fn replaces_invalid_utf8_settings_with_safe_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, [0xff, 0xfe, 0xfd]).unwrap();
        let store = SettingsStore::open(&path).unwrap();

        assert_eq!(store.load().unwrap(), AppSettings::default());
        assert_eq!(read_settings(&path).unwrap(), AppSettings::default());
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
    fn migrates_legacy_ai_defaults_without_losing_profile_details() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(
            &path,
            format!(
                r#"{{
                    "version": 1,
                    "ai": {{
                        "profiles": [{{
                            "id": "legacy-remote",
                            "name": "远程模型",
                            "provider": "deepSeek",
                            "baseUrl": "https://api.example.com/v1",
                            "model": "legacy-chat"
                        }}],
                        "activeProfileId": "legacy-remote",
                        "renamePrompt": "{LEGACY_AI_RENAME_PROMPT}"
                    }}
                }}"#
            ),
        )
        .unwrap();

        let loaded = SettingsStore::open(&path).unwrap().load().unwrap();

        assert_eq!(loaded.ai.rename_prompt, DEFAULT_AI_RENAME_PROMPT);
        assert_eq!(loaded.ai.profiles[0].provider, AiProviderKind::Custom);
        assert_eq!(loaded.ai.profiles[0].base_url, "https://api.example.com/v1");
        assert_eq!(loaded.ai.profiles[0].model, "legacy-chat");

        let store = SettingsStore::open(&path).unwrap();
        store.save(&loaded).unwrap();
        assert!(!fs::read_to_string(path).unwrap().contains("deepSeek"));
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
        let default = PathBuf::from(concat!(
            r"C:\",
            "Users",
            r"\me\AppData\Local\ArcRecall\tools"
        ));
        assert_eq!(resolve_tools_directory(&default, ""), default);
        assert_eq!(
            resolve_tools_directory(&default, r"D:\Shared\ArcTools"),
            PathBuf::from(r"D:\Shared\ArcTools")
        );
    }
}
