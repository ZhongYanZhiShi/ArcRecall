import {
  DICTIONARY_PAGE_SIZE,
  MAX_DICTIONARY_CANDIDATE_BYTES,
  type DictionaryCandidateEntry,
  type DictionaryCandidateAddSummary,
  type DictionaryCandidateQuery,
  type DictionaryListResult,
} from "./dictionary-model.ts"

// —— In-memory fallback for browser `pnpm dev:web` (no Tauri) ——

type MemoryRow = DictionaryCandidateEntry

export const memoryStore = (() => {
  let nextId = 1
  const byText = new Map<string, MemoryRow>()
  const byId = new Map<number, MemoryRow>()
  const order: number[] = []

  const encoder = new TextEncoder()

  function add(candidates: string[]): DictionaryCandidateAddSummary {
    let submitted = 0
    let added = 0
    let invalid = 0
    for (const text of candidates) {
      submitted += 1
      const byteCount = encoder.encode(text).length
      if (text.length === 0 || byteCount > MAX_DICTIONARY_CANDIDATE_BYTES) {
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
