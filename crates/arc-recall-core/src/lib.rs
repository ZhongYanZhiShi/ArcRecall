pub mod dictionary;
pub mod history;
pub mod paths;
pub mod settings;
pub mod tools;

pub use dictionary::{
    DEFAULT_PAGE_SIZE, DictionaryCandidateAddSummary, DictionaryCandidateEntry,
    DictionaryCandidateQuery, DictionaryCandidateStore, DictionaryError, DictionaryListResult,
    MAX_CANDIDATE_BYTES,
};
pub use history::{
    DEFAULT_HISTORY_PAGE_SIZE, RecoveryHistoryEntry, RecoveryHistoryError,
    RecoveryHistoryListResult, RecoveryHistoryQuery, RecoveryHistoryRecord, RecoveryHistoryStore,
};
pub use paths::{APP_DATA_FOLDER_NAME, AppPaths};
pub use settings::{
    AppLogLevel, AppSettings, DEFAULT_LOG_MAX_DISK_MIB, DatabaseInfo, EngineSettings,
    LoggingSettings, MAX_LOG_MAX_DISK_MIB, MIN_LOG_MAX_DISK_MIB, SettingsError, SettingsStore,
    resolve_tools_directory,
};
pub use tools::{
    ArchiveAnalysis, ArchiveFormat, CancellationToken, DEFAULT_RECURSIVE_MAX_ARCHIVES,
    DEFAULT_RECURSIVE_MAX_DEPTH, ENGINE_BUNDLE_MANIFEST_VERSION, ENGINE_BUNDLE_TARGET,
    EngineBundleError, EngineComponentStatus, FullEngineBundleInstallResult,
    FullEngineBundleManager, FullEngineBundleStatus, HASHCAT_GITHUB_REPO, HASHCAT_MANIFEST_VERSION,
    HashcatInstallResult, HashcatStatus, HashcatToolDownloader, HashcatToolError, JOHN_VERSION,
    JohnPerlStatus, PERL_VERSION, RecoveredArchive, RecoveryDictionary, RecoveryError, RecoveryJob,
    RecoveryPhase, RecoveryResult, RecoveryToolPaths, RecoveryUpdate, RecursiveRecoveryOptions,
    RecursiveRecoveryResult, SEVEN_ZIP_VERSION, analyze_archive, fingerprint_file_sha256,
    path_for_display, probe_john_perl, recover_and_extract, recover_and_extract_lazy,
    recover_and_extract_recursive_lazy,
};

pub const SERVICE_NAME: &str = "arc-recall-core";

pub fn health_status() -> &'static str {
    "ok"
}
