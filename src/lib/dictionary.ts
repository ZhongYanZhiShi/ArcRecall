import { invoke } from "@tauri-apps/api/core"

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

const EMPTY_SUMMARY: DictionaryCandidateAddSummary = {
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

/** True when running inside a Tauri webview. */
export function isDesktopRuntime(): boolean {
  if (typeof window === "undefined") {
    return false
  }
  return (
    "__TAURI_INTERNALS__" in window ||
    "__TAURI__" in window ||
    navigator.userAgent.includes("Tauri")
  )
}

export async function listDictionary(
  query: DictionaryCandidateQuery = {}
): Promise<DictionaryListResult> {
  if (!isDesktopRuntime()) {
    return memoryStore.list(query)
  }
  return invoke<DictionaryListResult>("dictionary_list", {
    query: {
      searchText: query.searchText ?? "",
      skip: query.skip ?? 0,
      take: query.take ?? DICTIONARY_PAGE_SIZE,
    },
  })
}

export async function countDictionary(): Promise<number> {
  if (!isDesktopRuntime()) {
    return memoryStore.count()
  }
  return invoke<number>("dictionary_count")
}

export async function addDictionaryCandidates(
  candidates: string[]
): Promise<DictionaryCandidateAddSummary> {
  if (candidates.length === 0) {
    return EMPTY_SUMMARY
  }
  if (!isDesktopRuntime()) {
    return memoryStore.add(candidates)
  }

  let summary = EMPTY_SUMMARY
  for (let i = 0; i < candidates.length; i += DICTIONARY_BATCH_SIZE) {
    const batch = candidates.slice(i, i + DICTIONARY_BATCH_SIZE)
    const part = await invoke<DictionaryCandidateAddSummary>("dictionary_add", {
      candidates: batch,
    })
    summary = mergeSummary(summary, part)
  }
  return summary
}

export async function deleteDictionaryCandidates(
  ids: number[]
): Promise<number> {
  if (ids.length === 0) {
    return 0
  }
  if (!isDesktopRuntime()) {
    return memoryStore.delete(ids)
  }
  return invoke<number>("dictionary_delete", { ids })
}

/**
 * Import a text dictionary file via the browser/Tauri file picker.
 * Lines are streamed in batches; source path is never persisted.
 */
export async function importDictionaryFile(
  file: File
): Promise<DictionaryCandidateAddSummary> {
  let summary = EMPTY_SUMMARY
  let batch: string[] = []
  const encoder = new TextEncoder()

  const flush = async () => {
    if (batch.length === 0) {
      return
    }
    const part = await addDictionaryCandidates(batch)
    summary = mergeSummary(summary, part)
    batch = []
  }

  const encoding = await detectDictionaryEncoding(file)

  // Prefer streaming for large files; fall back to full text for runtimes
  // without Blob streams.
  if (typeof file.stream === "function") {
    const reader = file
      .stream()
      .pipeThrough(new TextDecoderStream(encoding))
      .getReader()
    let pendingParts: string[] = []
    let pendingBytes = 0
    let discardingOversizedLine = false

    const recordInvalidLine = () => {
      summary = mergeSummary(summary, {
        submittedCount: 1,
        addedCount: 0,
        duplicateCount: 0,
        invalidCount: 1,
      })
    }

    const pushCompletedLine = async (segment: string) => {
      pendingParts.push(segment)
      let line = pendingParts.join("")
      if (line.endsWith("\r")) {
        line = line.slice(0, -1)
      }
      pendingParts = []
      pendingBytes = 0

      if (encoder.encode(line).byteLength > MAX_DICTIONARY_CANDIDATE_BYTES) {
        recordInvalidLine()
        return
      }
      batch.push(line)
      if (batch.length >= DICTIONARY_BATCH_SIZE) {
        await flush()
      }
    }

    while (true) {
      const { done, value: decodedChunk } = await reader.read()
      if (done) {
        break
      }

      let value = decodedChunk
      if (discardingOversizedLine) {
        const newline = value.indexOf("\n")
        if (newline === -1) {
          continue
        }
        discardingOversizedLine = false
        value = value.slice(newline + 1)
      }

      let cursor = 0
      while (cursor < value.length) {
        const newline = value.indexOf("\n", cursor)
        const segment = value.slice(
          cursor,
          newline === -1 ? value.length : newline
        )

        if (newline !== -1) {
          await pushCompletedLine(segment)
          cursor = newline + 1
          continue
        }

        pendingParts.push(segment)
        pendingBytes += encoder.encode(segment).byteLength
        const mayBeTrailingCarriageReturn = segment.endsWith("\r") ? 1 : 0
        if (
          pendingBytes >
          MAX_DICTIONARY_CANDIDATE_BYTES + mayBeTrailingCarriageReturn
        ) {
          recordInvalidLine()
          pendingParts = []
          pendingBytes = 0
          discardingOversizedLine = true
        }
        break
      }
    }

    if (!discardingOversizedLine && pendingParts.length > 0) {
      if (pendingBytes > MAX_DICTIONARY_CANDIDATE_BYTES) {
        recordInvalidLine()
      } else {
        await pushCompletedLine("")
      }
    }
    await flush()
    return summary
  }

  const text = new TextDecoder(encoding).decode(await file.arrayBuffer())
  const lines = text.split(/\r?\n/)
  // split keeps a trailing empty string when file ends with newline — treat
  // empty lines as invalid candidates (same as Rust store).
  return addDictionaryCandidates(lines)
}

export type DictionaryTextEncoding =
  | "utf-8"
  | "utf-16le"
  | "utf-16be"
  | "gb18030"

export async function detectDictionaryEncoding(
  file: Blob
): Promise<DictionaryTextEncoding> {
  const sample = new Uint8Array(
    await file.slice(0, Math.min(file.size, 64 * 1024)).arrayBuffer()
  )
  if (sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf) {
    return "utf-8"
  }
  if (sample[0] === 0xff && sample[1] === 0xfe) {
    return "utf-16le"
  }
  if (sample[0] === 0xfe && sample[1] === 0xff) {
    return "utf-16be"
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample, {
      // The fixed-size probe may end in the middle of a valid multibyte
      // character. Streaming mode validates everything complete in the probe
      // while preserving that trailing prefix for a hypothetical next chunk.
      stream: sample.byteLength < file.size,
    })
    return "utf-8"
  } catch {
    // GB18030 is a superset of GBK and is implemented by Chromium/WebView2.
    // Invalid UTF-8 is therefore decoded using the common Windows Chinese
    // dictionary encoding instead of silently inserting replacement chars.
    return "gb18030"
  }
}

// —— In-memory fallback for browser `pnpm dev` (no Tauri) ——

type MemoryRow = DictionaryCandidateEntry

const memoryStore = (() => {
  let nextId = 1
  const byText = new Map<string, MemoryRow>()
  const byId = new Map<number, MemoryRow>()
  const order: number[] = []

  const maxBytes = 64 * 1024

  function add(candidates: string[]): DictionaryCandidateAddSummary {
    let submitted = 0
    let added = 0
    let invalid = 0
    for (const text of candidates) {
      submitted += 1
      const byteCount = new TextEncoder().encode(text).length
      if (text.length === 0 || byteCount > maxBytes) {
        invalid += 1
        continue
      }
      if (byText.has(text)) {
        continue
      }
      const row: MemoryRow = {
        id: nextId++,
        value: text,
        byteCount,
        successCount: 0,
      }
      byText.set(text, row)
      byId.set(row.id, row)
      order.push(row.id)
      added += 1
    }
    return {
      submittedCount: submitted,
      addedCount: added,
      duplicateCount: submitted - invalid - added,
      invalidCount: invalid,
    }
  }

  function list(query: DictionaryCandidateQuery): DictionaryListResult {
    const search = query.searchText ?? ""
    const skip = Math.max(0, query.skip ?? 0)
    const take = Math.max(0, query.take ?? DICTIONARY_PAGE_SIZE)
    const all = order
      .map((id) => byId.get(id))
      .filter((row): row is MemoryRow => row != null)
      .filter((row) => (search === "" ? true : row.value.includes(search)))
    return {
      entries: all.slice(skip, skip + take),
      totalCount: byText.size,
      matchedCount: all.length,
    }
  }

  function count(): number {
    return byText.size
  }

  function deleteIds(ids: number[]): number {
    const idSet = new Set(ids)
    let deleted = 0
    for (const id of ids) {
      const row = byId.get(id)
      if (!row) {
        continue
      }
      byId.delete(id)
      byText.delete(row.value)
      deleted += 1
    }
    for (let i = order.length - 1; i >= 0; i -= 1) {
      if (idSet.has(order[i]!)) {
        order.splice(i, 1)
      }
    }
    return deleted
  }

  return { add, list, count, delete: deleteIds }
})()
