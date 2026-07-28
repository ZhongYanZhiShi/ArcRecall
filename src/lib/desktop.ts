import { invoke } from "@tauri-apps/api/core"

export interface HealthResponse {
  service: string
  status: string
}

export function getDesktopHealth(): Promise<HealthResponse> {
  return invoke<HealthResponse>("health")
}

export {
  AI_PROVIDER_DEFAULTS,
  DEFAULT_AI_RENAME_PROMPT,
  deleteAiProfile,
  generateAiArchiveName,
  listAiModels,
  listAiProfiles,
  testAiConnection,
  updateAiSettings,
  upsertAiProfile,
  type AiConnectionTestResult,
  type AiModelInfo,
  type AiProfile,
  type AiProfileUpsertRequest,
  type AiProviderKind,
  type AiSettings,
  type AiSettingsUpdateRequest,
} from "@/lib/ai"

export {
  addDictionaryCandidates,
  countDictionary,
  deleteDictionaryCandidates,
  importDictionaryFile,
  isDesktopRuntime,
  listDictionary,
  type DictionaryCandidateAddSummary,
  type DictionaryCandidateEntry,
  type DictionaryListResult,
} from "@/lib/dictionary"

export {
  downloadHashcat,
  getDatabaseInfo,
  getFullEngineBundleStatus,
  getHashcatStatus,
  getJohnPerlStatus,
  getSettings,
  installFullEngineBundle,
  openPath,
  setJohnPerl,
  setSettings,
  setToolsDirectory,
  type AppSettings,
  type AppLogLevel,
  type DatabaseInfo,
  type EngineComponentStatus,
  type FullEngineBundleInstallResult,
  type FullEngineBundleStatus,
  type HashcatInstallResult,
  type HashcatStatus,
  type JohnPerlStatus,
  type LoggingSettings,
} from "@/lib/settings"

export {
  cancelCompression,
  getCompressionStatus,
  pickCompressionFiles,
  pickCompressionFolder,
  pickCompressionOutputDirectory,
  startCompression,
  type CompressionFormat,
  type CompressionPhase,
  type CompressionStartRequest,
  type CompressionTaskStatus,
} from "@/lib/compression"

export {
  backupDatabase,
  clearLogs,
  exportLogs,
  listLogs,
  openLogDirectory,
  writeClientLog,
  type ClientLogRequest,
  type DatabaseBackupResult,
  type LogEntry,
  type LogExportResult,
  type LogLevel,
  type LogListResult,
  type LogQuery,
  type LogStats,
} from "@/lib/logging"

export {
  analyzeArchive,
  cancelRecovery,
  getRecoveryCapabilities,
  getRecoveryStatus,
  openOutputDirectory,
  pickArchivePath,
  pickOutputDirectory,
  startRecovery,
  type ArchiveAnalysis,
  type ArchiveFormat,
  type RecoveryCapabilities,
  type RecoveryComputeDevice,
  type RecoveryComputeMode,
  type RecoveryMethodCapability,
  type RecoveryPhase,
  type RecoveryStartRequest,
  type RecoveryTaskStatus,
} from "@/lib/recovery"
