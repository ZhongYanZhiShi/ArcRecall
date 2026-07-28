import { invoke } from "@tauri-apps/api/core"

export interface HealthResponse {
  service: string
  status: string
}

export function getDesktopHealth(): Promise<HealthResponse> {
  return invoke<HealthResponse>("health")
}

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
  type DatabaseInfo,
  type EngineComponentStatus,
  type FullEngineBundleInstallResult,
  type FullEngineBundleStatus,
  type HashcatInstallResult,
  type HashcatStatus,
  type JohnPerlStatus,
} from "@/lib/settings"

export {
  analyzeArchive,
  cancelRecovery,
  getRecoveryStatus,
  openOutputDirectory,
  pickArchivePath,
  pickOutputDirectory,
  startRecovery,
  type ArchiveAnalysis,
  type ArchiveFormat,
  type RecoveryPhase,
  type RecoveryStartRequest,
  type RecoveryTaskStatus,
} from "@/lib/recovery"
