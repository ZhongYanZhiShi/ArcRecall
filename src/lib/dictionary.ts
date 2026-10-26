import { invoke } from "@tauri-apps/api/core"
import { isDesktopRuntime } from "./runtime.ts"
import { memoryStore } from "./dictionary-memory.ts"
import { detectDictionaryEncoding } from "./dictionary-encoding.ts"
import {
  DICTIONARY_PAGE_SIZE,
  DICTIONARY_BATCH_SIZE,
  MAX_DICTIONARY_CANDIDATE_BYTES,
  EMPTY_SUMMARY,
  DictionaryImportError,
  mergeSummary,
  type DictionaryCandidateQuery,
  type DictionaryListResult,
  type DictionaryCandidateAddSummary,
  type DictionaryImportOptions,
} from "./dictionary-model.ts"
export * from "./dictionary-model.ts"
export { detectDictionaryEncoding } from "./dictionary-encoding.ts"

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
  candidates: string[],
  group?: string | null,
  importId?: string
): Promise<DictionaryCandidateAddSummary> {
  if (candidates.length === 0) {
    return EMPTY_SUMMARY
  }
  if (!isDesktopRuntime()) {
    return memoryStore.add(candidates)
  }

  const ownsSession = importId === undefined
  const session = importId ?? (await invoke<string>("dictionary_import_begin"))
  let summary = EMPTY_SUMMARY
  if (ownsSession) activeDictionaryImports += 1
  try {
    for (let i = 0; i < candidates.length; i += DICTIONARY_BATCH_SIZE) {
      const batch = candidates.slice(i, i + DICTIONARY_BATCH_SIZE)
      const part = await invoke<DictionaryCandidateAddSummary>(
        "dictionary_add",
        {
          candidates: batch,
          group: group ?? null,
          importId: session,
        }
      )
      summary = mergeSummary(summary, part)
    }
    return summary
  } finally {
    if (ownsSession) {
      try {
        await invoke("dictionary_import_finish", { id: session })
      } finally {
        activeDictionaryImports -= 1
      }
    }
  }
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
  file: File,
  options: DictionaryImportOptions = {}
): Promise<DictionaryCandidateAddSummary> {
  let summary = EMPTY_SUMMARY
  let batch: string[] = []
  const encoder = new TextEncoder()
  let processedBytes = 0
  let batchBytes = 0
  let importId: string | undefined
  activeDictionaryImports += 1

  try {
    if (isDesktopRuntime())
      importId = await invoke<string>("dictionary_import_begin")
    const encoding = await detectDictionaryEncoding(file, options)
    const report = () =>
      options.onProgress?.({
        phase: "importing",
        processedBytes,
        totalBytes: file.size,
        encoding,
        summary,
      })
    const flush = async () => {
      options.signal?.throwIfAborted()
      if (batch.length === 0) return
      const part = await addDictionaryCandidates(batch, options.group, importId)
      summary = mergeSummary(summary, part)
      batch = []
      batchBytes = 0
      report()
      // An in-flight IPC batch is allowed to commit; report it before stopping.
      options.signal?.throwIfAborted()
    }

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

      const byteCount = encoder.encode(line).byteLength
      if (byteCount > MAX_DICTIONARY_CANDIDATE_BYTES) {
        recordInvalidLine()
        return
      }
      batch.push(line)
      batchBytes += byteCount
      if (batch.length >= DICTIONARY_BATCH_SIZE || batchBytes >= 1024 * 1024) {
        await flush()
      }
    }

    const consume = async (decodedChunk: string) => {
      let value = decodedChunk
      if (discardingOversizedLine) {
        const newline = value.indexOf("\n")
        if (newline === -1) {
          return
        }
        discardingOversizedLine = false
        value = value.slice(newline + 1)
      }

      let cursor = 0
      while (cursor < value.length) {
        options.signal?.throwIfAborted()
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

    report()
    const decoder = new TextDecoder(encoding, { fatal: true })
    const chunkBytes = 64 * 1024
    for (let offset = 0; offset < file.size; offset += chunkBytes) {
      options.signal?.throwIfAborted()
      const bytes = await file.slice(offset, offset + chunkBytes).arrayBuffer()
      options.signal?.throwIfAborted()
      processedBytes = Math.min(offset + chunkBytes, file.size)
      await consume(decoder.decode(bytes, { stream: true }))
      report()
      if ((offset / chunkBytes + 1) % 16 === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
      }
    }
    await consume(decoder.decode())
    options.signal?.throwIfAborted()
    if (!discardingOversizedLine && pendingParts.length > 0) {
      // Apply the same CR trimming and byte limit as newline-terminated rows.
      await pushCompletedLine("")
    }
    await flush()
    report()
    return summary
  } catch (reason) {
    throw new DictionaryImportError(
      reason,
      summary,
      options.signal?.aborted === true
    )
  } finally {
    try {
      if (importId) await invoke("dictionary_import_finish", { id: importId })
    } catch (reason) {
      throw new DictionaryImportError(
        reason,
        summary,
        options.signal?.aborted ?? false
      )
    } finally {
      activeDictionaryImports -= 1
    }
  }
}

let activeDictionaryImports = 0
export function isDictionaryImportRunning(): boolean {
  return activeDictionaryImports > 0
}
