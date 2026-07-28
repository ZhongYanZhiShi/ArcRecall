import { invoke } from "@tauri-apps/api/core"

import { isDesktopRuntime } from "@/lib/dictionary"

export const HISTORY_PAGE_SIZE = 100

export type RecoveryHistoryEntry = {
  id: number
  fingerprintPrefix: string
  archiveFormat: string
  fileSize: number
  volumeCount: number
  firstSuccessAtMs: number
  lastVerifiedAtMs: number
  verificationCount: number
  hasPassword: boolean
}

export type RecoveryHistoryQuery = {
  searchText?: string
  skip?: number
  take?: number
}

export type RecoveryHistoryListResult = {
  entries: RecoveryHistoryEntry[]
  totalCount: number
  matchedCount: number
  passwordCount: number
}

export async function listRecoveryHistory(
  query: RecoveryHistoryQuery = {}
): Promise<RecoveryHistoryListResult> {
  if (!isDesktopRuntime()) {
    return previewStore.list(query)
  }
  return invoke<RecoveryHistoryListResult>("history_list", {
    query: {
      searchText: query.searchText ?? "",
      skip: query.skip ?? 0,
      take: query.take ?? HISTORY_PAGE_SIZE,
    },
  })
}

export async function revealHistoryPassword(
  id: number
): Promise<string | null> {
  if (!isDesktopRuntime()) {
    return previewStore.password(id)
  }
  return invoke<string | null>("history_reveal_password", { id })
}

export async function deleteRecoveryHistory(id: number): Promise<boolean> {
  if (!isDesktopRuntime()) {
    return previewStore.delete(id)
  }
  return invoke<boolean>("history_delete", { id })
}

export async function clearRecoveryHistory(): Promise<number> {
  if (!isDesktopRuntime()) {
    return previewStore.clear()
  }
  return invoke<number>("history_clear")
}

type PreviewRow = RecoveryHistoryEntry & {
  password: string | null
}

const previewNow = Date.now()

const previewStore = (() => {
  let rows: PreviewRow[] = [
    {
      id: 1,
      fingerprintPrefix: "8bd14e77ca93",
      archiveFormat: "7z",
      fileSize: 1_284_673_024,
      volumeCount: 1,
      firstSuccessAtMs: previewNow - 1000 * 60 * 60 * 24 * 18,
      lastVerifiedAtMs: previewNow - 1000 * 60 * 12,
      verificationCount: 3,
      hasPassword: true,
      password: "www.example.com",
    },
    {
      id: 2,
      fingerprintPrefix: "41c7b1f06d52",
      archiveFormat: "RAR5",
      fileSize: 386_146_304,
      volumeCount: 1,
      firstSuccessAtMs: previewNow - 1000 * 60 * 60 * 24 * 4,
      lastVerifiedAtMs: previewNow - 1000 * 60 * 60 * 5,
      verificationCount: 1,
      hasPassword: true,
      password: "123456",
    },
    {
      id: 3,
      fingerprintPrefix: "d062ab19e405",
      archiveFormat: "ZIP",
      fileSize: 92_438_528,
      volumeCount: 1,
      firstSuccessAtMs: previewNow - 1000 * 60 * 60 * 24,
      lastVerifiedAtMs: previewNow - 1000 * 60 * 60 * 24,
      verificationCount: 1,
      hasPassword: false,
      password: null,
    },
  ]

  function list(query: RecoveryHistoryQuery): RecoveryHistoryListResult {
    const search = (query.searchText ?? "").trim().toLowerCase()
    const skip = Math.max(0, query.skip ?? 0)
    const take = Math.max(1, query.take ?? HISTORY_PAGE_SIZE)
    const filtered = rows.filter(
      (row) => search === "" || row.fingerprintPrefix.startsWith(search)
    )
    return {
      entries: filtered.slice(skip, skip + take).map(stripPassword),
      totalCount: rows.length,
      matchedCount: filtered.length,
      passwordCount: rows.filter((row) => row.password != null).length,
    }
  }

  function password(id: number): string | null {
    return rows.find((row) => row.id === id)?.password ?? null
  }

  function deleteEntry(id: number): boolean {
    const before = rows.length
    rows = rows.filter((row) => row.id !== id)
    return rows.length !== before
  }

  function clear(): number {
    const removed = rows.length
    rows = []
    return removed
  }

  return { list, password, delete: deleteEntry, clear }
})()

function stripPassword(row: PreviewRow): RecoveryHistoryEntry {
  return {
    id: row.id,
    fingerprintPrefix: row.fingerprintPrefix,
    archiveFormat: row.archiveFormat,
    fileSize: row.fileSize,
    volumeCount: row.volumeCount,
    firstSuccessAtMs: row.firstSuccessAtMs,
    lastVerifiedAtMs: row.lastVerifiedAtMs,
    verificationCount: row.verificationCount,
    hasPassword: row.hasPassword,
  }
}
