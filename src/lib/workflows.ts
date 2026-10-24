import { invoke } from "@tauri-apps/api/core"
import {
  isDesktopRuntime,
  type DictionaryCandidateQuery,
  type DictionaryListResult,
} from "./dictionary"

export type TaskOperation =
  | "recovery"
  | "compression"
  | "selectiveExtraction"
  | "integrityCheck"
  | "batchIntegrityCheck"
export type TaskRecord = {
  compression?: import("./compression-presets").CompressionRecordOptions | null
  operation?: TaskOperation
  sourcePaths?: string[]
  selectedPaths?: string[]
  outputPath?: string | null
  checkItems?: {
    path: string
    state: string
    elapsedMs: number
    checkedAtMs: number | null
  }[]
  taskId: string
  archivePath: string
  outputDirectory: string
  startedAtMs: number
  elapsedMs: number
  state: string
  failureKind: string | null
  recursive: boolean
  computeMode: "cpuOnly" | "gpuPreferred"
  dictionaryGroup: string | null
  pendingArchivePaths: string[]
  skippedScanDirectories: string[]
}
export type ArchivePreview = {
  entries: {
    path: string
    size: number
    directory: boolean
    encrypted: boolean
    link?: boolean
  }[]
  totalEntries: number
  totalBytes: number
  truncated: boolean
}
export function listGroups(): Promise<string[]> {
  return isDesktopRuntime() ? invoke("dictionary_groups") : Promise.resolve([])
}
export function assignGroup(name: string, ids: number[]): Promise<void> {
  return invoke("dictionary_group_assign", { name, ids })
}
export function deleteGroup(name: string): Promise<void> {
  return invoke("dictionary_group_delete", { name })
}
export function listGroup(
  name: string,
  query: DictionaryCandidateQuery
): Promise<DictionaryListResult> {
  return invoke("dictionary_group_list", { name, query })
}
export type TaskRecordQuery = {
  text?: string
  state?: string | null
  fromMs?: number | null
  beforeMs?: number | null
  operation?: TaskOperation | null
  failedOnly?: boolean
}
export function listTaskRecords(
  skip: number,
  failedOnly: boolean,
  operation: TaskOperation | null = null,
  query?: TaskRecordQuery
): Promise<TaskRecord[]> {
  return isDesktopRuntime()
    ? query
      ? invoke("task_records_search", {
          skip,
          query: { ...query, failedOnly, operation },
        })
      : invoke("task_records_list", { skip, failedOnly, operation })
    : Promise.resolve([])
}
export function deleteTaskRecord(id: string): Promise<void> {
  return invoke("task_record_delete", { id })
}
export function previewArchive(
  path: string,
  password: string
): Promise<ArchivePreview> {
  return invoke("archive_preview", { path, password: password || null })
}

export function removeGroupMembers(name: string, ids: number[]): Promise<void> {
  return invoke("dictionary_group_assign", { name, ids, remove: true })
}

export type ArchiveActionResult = {
  outputDirectory: string | null
  entryCount: number
  message: string
}
export function runArchiveAction(
  id: string,
  path: string,
  password: string,
  selectedPaths: string[] | null,
  outputParent: string | null
): Promise<ArchiveActionResult> {
  return invoke("archive_action_run", {
    id,
    request: { path, password: password || null, selectedPaths, outputParent },
  })
}
export function cancelArchiveAction(id: string): Promise<void> {
  return invoke("archive_action_cancel", { id })
}
