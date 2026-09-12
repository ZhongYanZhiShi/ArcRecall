mod bundle;
mod compression;
mod hashcat;
mod john;
mod recovery;
mod runner;

pub use bundle::{
    ENGINE_BUNDLE_MANIFEST_VERSION, ENGINE_BUNDLE_TARGET, EngineBundleError, EngineComponentStatus,
    FullEngineBundleInstallResult, FullEngineBundleManager, FullEngineBundleStatus, JOHN_VERSION,
    PERL_VERSION, SEVEN_ZIP_VERSION,
};
pub use compression::{
    CompressionError, CompressionFormat, CompressionJob, CompressionPhase, CompressionResult,
    CompressionUpdate, PreparedCompressionJob, compress_archive, prepare_compression,
    resolve_available_archive_path, sanitize_archive_base_name,
};
pub use hashcat::{
    HASHCAT_GITHUB_REPO, HASHCAT_MANIFEST_VERSION, HashcatInstallResult, HashcatStatus,
    HashcatToolDownloader, HashcatToolError,
};
pub use john::{JohnPerlStatus, probe_john_perl};
pub use recovery::{
    ArchiveAnalysis, ArchiveFormat, DEFAULT_RECURSIVE_MAX_ARCHIVES, DEFAULT_RECURSIVE_MAX_DEPTH,
    HashcatProgress, RecoveredArchive, RecoveryCapabilities, RecoveryComputeDevice,
    RecoveryComputeMode, RecoveryDictionary, RecoveryError, RecoveryJob, RecoveryMethodCapability,
    RecoveryPhase, RecoveryResult, RecoveryToolPaths, RecoveryUpdate, RecursiveRecoveryOptions,
    RecursiveRecoveryResult, analyze_archive, detect_archive_format, fingerprint_archive_sha256,
    fingerprint_archive_sha256_with_cancellation, fingerprint_file_sha256, path_for_display,
    probe_recovery_capabilities, recover_and_extract, recover_and_extract_lazy,
    recover_and_extract_recursive_lazy,
};
pub use runner::{
    CancellationToken, ProcessOutput, ProcessRequest, ProcessRunnerError, run_process,
    strawberry_perl_path_entries,
};
