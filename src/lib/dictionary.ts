import { invoke } from "@tauri-apps/api/core"

/** Max candidates submitted per IPC batch when importing / pasting. */
export const DICTIONARY_BATCH_SIZE = 4096

/** UI list page size (matches Rust DEFAULT_PAGE_SIZE). */
export const DICTIONARY_PAGE_SIZE = 500

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

  const flush = async () => {
    if (batch.length === 0) {
      return
    }
    const part = await addDictionaryCandidates(batch)
    summary = mergeSummary(summary, part)
    batch = []
  }

  // Prefer streaming for large files; fall back to full text for tiny blobs.
  if (typeof file.stream === "function") {
    const reader = file
      .stream()
      .pipeThrough(new TextDecoderStream())
      .getReader()
    let pending = ""
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      pending += value
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ""
      for (const line of lines) {
        batch.push(line)
        if (batch.length >= DICTIONARY_BATCH_SIZE) {
          await flush()
        }
      }
    }
    // Final incomplete line (no trailing newline) is still a candidate.
    if (pending.length > 0 || file.size === 0) {
      // Only push residual when file ended mid-line; empty residual after
      // trailing newline is not a candidate.
      if (pending.length > 0) {
        batch.push(pending)
      }
    }
    await flush()
    return summary
  }

  const text = await file.text()
  const lines = text.split(/\r?\n/)
  // split keeps a trailing empty string when file ends with newline — treat
  // empty lines as invalid candidates (same as Rust store).
  return addDictionaryCandidates(lines)
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
