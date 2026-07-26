pub mod dictionary;
pub mod paths;
pub mod settings;
pub mod tools;

pub use dictionary::{
    DEFAULT_PAGE_SIZE, DictionaryCandidateAddSummary, DictionaryCandidateEntry,
    DictionaryCandidateQuery, DictionaryCandidateStore, DictionaryError, DictionaryListResult,
    MAX_CANDIDATE_BYTES,
};
pub use paths::{APP_DATA_FOLDER_NAME, AppPaths};
pub use settings::{
    AppSettings, DatabaseInfo, EngineSettings, SettingsError, SettingsStore,
    resolve_tools_directory,
};
pub use tools::{
    ArchiveAnalysis, ArchiveFormat, CancellationToken, ENGINE_BUNDLE_MANIFEST_VERSION,
    ENGINE_BUNDLE_TARGET, EngineBundleError, EngineComponentStatus, FullEngineBundleInstallResult,
    FullEngineBundleManager, FullEngineBundleStatus, HASHCAT_GITHUB_REPO, HASHCAT_MANIFEST_VERSION,
    HashcatInstallResult, HashcatStatus, HashcatToolDownloader, HashcatToolError, JOHN_VERSION,
    JohnPerlStatus, PERL_VERSION, RecoveryError, RecoveryJob, RecoveryPhase, RecoveryResult,
    RecoveryToolPaths, RecoveryUpdate, SEVEN_ZIP_VERSION, analyze_archive, probe_john_perl,
    recover_and_extract,
};

pub const SERVICE_NAME: &str = "arc-recall-core";

pub fn health_status() -> &'static str {
    "ok"
}
