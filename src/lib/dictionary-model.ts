/** Max candidates submitted per IPC batch when importing / pasting. */
export const DICTIONARY_BATCH_SIZE = 4096

/** UI list page size (matches Rust DEFAULT_PAGE_SIZE). */
export const DICTIONARY_PAGE_SIZE = 500

/** Matches the Rust store limit and bounds streaming importer memory per line. */
export const MAX_DICTIONARY_CANDIDATE_BYTES = 64 * 1024

export type DictionaryCandidateEntry = {
  id: number
  value: string
  byteCount: number
  successCount: number
}

export type DictionaryCandidateAddSummary = {
  submittedCount: number
  addedCount: number
  duplicateCount: number
  invalidCount: number
}

export type DictionaryCandidateQuery = {
  searchText?: string
  skip?: number
  take?: number
}

export type DictionaryListResult = {
  entries: DictionaryCandidateEntry[]
  totalCount: number
  matchedCount: number
}

export type DictionaryImportProgress = {
  phase: "validating" | "importing"
  processedBytes: number
  totalBytes: number
  encoding: DictionaryTextEncoding
  summary: DictionaryCandidateAddSummary
}

export type DictionaryImportOptions = {
  group?: string | null
  signal?: AbortSignal
  onProgress?: (progress: DictionaryImportProgress) => void
}

export class DictionaryImportError extends Error {
  readonly summary: DictionaryCandidateAddSummary
  readonly cancelled: boolean

  constructor(
    reason: unknown,
    summary: DictionaryCandidateAddSummary,
    cancelled: boolean
  ) {
    super(
      cancelled
        ? "字典导入已取消。"
        : reason instanceof Error
          ? reason.message
          : String(reason),
      { cause: reason }
    )
    this.name = "DictionaryImportError"
    this.summary = summary
    this.cancelled = cancelled
  }
}

export const EMPTY_SUMMARY: DictionaryCandidateAddSummary = {
  submittedCount: 0,
  addedCount: 0,
  duplicateCount: 0,
  invalidCount: 0,
}

export function mergeSummary(
  left: DictionaryCandidateAddSummary,
  right: DictionaryCandidateAddSummary
): DictionaryCandidateAddSummary {
  return {
    submittedCount: left.submittedCount + right.submittedCount,
    addedCount: left.addedCount + right.addedCount,
    duplicateCount: left.duplicateCount + right.duplicateCount,
    invalidCount: left.invalidCount + right.invalidCount,
  }
}

export function formatAddStatus(
  prefix: string,
  summary: DictionaryCandidateAddSummary
): string {
  return `${prefix}：新增 ${summary.addedCount} 条，重复 ${summary.duplicateCount} 条，无效 ${summary.invalidCount} 条。`
}

export type DictionaryTextEncoding =
  | "utf-8"
  | "utf-16le"
  | "utf-16be"
  | "gb18030"
