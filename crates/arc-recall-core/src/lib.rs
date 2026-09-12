pub mod ai;
pub mod dictionary;
pub mod history;
pub mod paths;
pub mod settings;
pub mod tools;

pub use dictionary::{
    DEFAULT_PAGE_SIZE, DatabaseRestoreInfo, DictionaryCandidateAddSummary,
    DictionaryCandidateEntry, DictionaryCandidateQuery, DictionaryCandidateStore, DictionaryError,
    DictionaryListResult, MAX_CANDIDATE_BYTES, inspect_database_restore, snapshot_database_restore,
};
pub use history::{
    DEFAULT_HISTORY_PAGE_SIZE, RecoveryHistoryEntry, RecoveryHistoryError,
    RecoveryHistoryListResult, RecoveryHistoryQuery, RecoveryHistoryRecord, RecoveryHistoryStore,
    StoredRecoveryPassword,
};
pub use paths::{APP_DATA_FOLDER_NAME, AppPaths};
pub use settings::{
    AiProfile, AiProviderKind, AiSettings, AppLogLevel, AppSettings, CURRENT_SETTINGS_VERSION,
    DEFAULT_AI_RENAME_PROMPT, DEFAULT_LOG_MAX_DISK_MIB, DatabaseInfo, EngineSettings,
    LoggingSettings, MAX_LOG_MAX_DISK_MIB, MIN_LOG_MAX_DISK_MIB, RecoverySettings, SettingsError,
    SettingsStore, resolve_tools_directory,
};
pub use tools::{
    ArchiveAnalysis, ArchiveFormat, CancellationToken, CompressionError, CompressionFormat,
    CompressionJob, CompressionPhase, CompressionResult, CompressionUpdate,
    DEFAULT_RECURSIVE_MAX_ARCHIVES, DEFAULT_RECURSIVE_MAX_DEPTH, ENGINE_BUNDLE_MANIFEST_VERSION,
    ENGINE_BUNDLE_TARGET, EngineBundleError, EngineComponentStatus, FullEngineBundleInstallResult,
    FullEngineBundleManager, FullEngineBundleStatus, HASHCAT_GITHUB_REPO, HASHCAT_MANIFEST_VERSION,
    HashcatInstallResult, HashcatProgress, HashcatStatus, HashcatToolDownloader, HashcatToolError,
    JOHN_VERSION, JohnPerlStatus, PERL_VERSION, PreparedCompressionJob, RecoveredArchive,
    RecoveryCapabilities, RecoveryComputeDevice, RecoveryComputeMode, RecoveryDictionary,
    RecoveryError, RecoveryJob, RecoveryMethodCapability, RecoveryPhase, RecoveryResult,
    RecoveryToolPaths, RecoveryUpdate, RecursiveRecoveryOptions, RecursiveRecoveryResult,
    SEVEN_ZIP_VERSION, analyze_archive, compress_archive, create_repaired_archive_copy,
    fingerprint_archive_sha256, fingerprint_archive_sha256_with_cancellation,
    fingerprint_file_sha256, path_for_display, prepare_compression, probe_john_perl,
    probe_recovery_capabilities, recover_and_extract, recover_and_extract_lazy,
    recover_and_extract_recursive_lazy, resolve_available_archive_path, sanitize_archive_base_name,
};

pub const SERVICE_NAME: &str = "arc-recall-core";

pub fn health_status() -> &'static str {
    "ok"
}
pub use ai::{
    AiClientConfig, AiConnectionTestResult, AiError, AiModelInfo, generate_archive_name,
    list_ai_models, test_ai_connection, validate_ai_base_url,
};
