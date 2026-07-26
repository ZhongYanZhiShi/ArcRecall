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
