import { invoke } from "@tauri-apps/api/core"

import { isDesktopRuntime } from "@/lib/dictionary"

export type LogLevel = "error" | "warn" | "info" | "debug"

export type LogEntry = {
  id: string
  timestampMs: number
  level: LogLevel
  source: string
  event: string
  message: string
  context: Record<string, string>
}

export type LogQuery = {
  level?: LogLevel
  searchText?: string
  skip?: number
  take?: number
}

export type LogStats = {
  errorCount: number
  warnCount: number
  infoCount: number
  debugCount: number
  fileCount: number
  diskBytes: number
  unreadableLineCount: number
}

export type LogListResult = {
  entries: LogEntry[]
  totalCount: number
  matchedCount: number
  hasMore: boolean
  stats: LogStats
  directory: string
}

export type LogExportResult = {
  path: string
  entryCount: number
  byteCount: number
  createdAtMs: number
}

export type DatabaseBackupResult = {
  path: string
  byteCount: number
  createdAtMs: number
}

export type ClientLogRequest = {
  level: LogLevel
  event: string
  message: string
  context?: Record<string, string>
}

const previewStartedAt = Date.now()
let previewEntries: LogEntry[] = [
  {
    id: `${previewStartedAt}-1`,
    timestampMs: previewStartedAt,
    level: "info",
    source: "desktop",
    event: "app.started",
    message: "ArcRecall 浏览器预览已启动。",
    context: { platform: "browser", version: "0.1.0" },
  },
  {
    id: `${previewStartedAt + 1}-2`,
    timestampMs: previewStartedAt + 1,
    level: "info",
    source: "logs",
    event: "logs.ready",
    message: "日志中心已就绪。",
    context: { retention: "25 MiB（可配置）" },
  },
  {
    id: `${previewStartedAt + 2}-3`,
    timestampMs: previewStartedAt + 2,
    level: "info",
    source: "recovery",
    event: "recovery.started",
    message: "恢复任务已启动。",
    context: {
      task_id: "recovery-preview-1",
      archive_format: "7z",
      candidate_count: "0",
    },
  },
  ...["verifying", "extracting", "recursive"].map<LogEntry>((phase, index) => ({
    id: `${previewStartedAt + 3 + index}-${4 + index}`,
    timestampMs: previewStartedAt + 3 + index,
    level: "debug",
    source: "recovery",
    event: "recovery.phase_changed",
    message: "恢复任务阶段已切换。",
    context: {
      task_id: "recovery-preview-1",
      engine: "7-Zip",
      phase,
    },
  })),
  {
    id: `${previewStartedAt + 6}-7`,
    timestampMs: previewStartedAt + 6,
    level: "info",
    source: "recovery",
    event: "recovery.completed",
    message: "恢复任务已完成。",
    context: {
      task_id: "recovery-preview-1",
      engine: "7-Zip",
      nested_extracted: "4",
      nested_skipped: "0",
    },
  },
]
let previewSequence = 8

export async function listLogs(query: LogQuery = {}): Promise<LogListResult> {
  if (!isDesktopRuntime()) {
    return listPreviewLogs(query)
  }
  return invoke<LogListResult>("log_list", {
    query: {
      level: query.level ?? null,
      searchText: query.searchText ?? "",
      skip: query.skip ?? 0,
      take: query.take ?? 200,
    },
  })
}

export async function writeClientLog(request: ClientLogRequest): Promise<void> {
  if (!isDesktopRuntime()) {
    previewEntries.push({
      id: `${Date.now()}-${previewSequence++}`,
      timestampMs: Date.now(),
      level: request.level,
      source: "frontend",
      event: request.event,
      message: request.message,
      context: request.context ?? {},
    })
    return
  }
  await invoke("log_write", {
    request: {
      ...request,
      context: request.context ?? {},
    },
  })
}

export async function exportLogs(): Promise<LogExportResult> {
  if (!isDesktopRuntime()) {
    return {
      path: "（浏览器预览：未写入磁盘）",
      entryCount: previewEntries.length,
      byteCount: 0,
      createdAtMs: Date.now(),
    }
  }
  return invoke<LogExportResult>("log_export")
}

export async function clearLogs(): Promise<number> {
  if (!isDesktopRuntime()) {
    const removed = previewEntries.length > 0 ? 1 : 0
    previewEntries = []
    return removed
  }
  return invoke<number>("log_clear")
}

export async function openLogDirectory(): Promise<void> {
  if (!isDesktopRuntime()) {
    return
  }
  await invoke("log_open_directory")
}

export async function backupDatabase(): Promise<DatabaseBackupResult> {
  if (!isDesktopRuntime()) {
    return {
      path: "（浏览器预览：未写入磁盘）",
      byteCount: 0,
      createdAtMs: Date.now(),
    }
  }
  return invoke<DatabaseBackupResult>("database_backup")
}

function listPreviewLogs(query: LogQuery): LogListResult {
  const search = (query.searchText ?? "").trim().toLowerCase()
  const filtered = previewEntries.filter((entry) => {
    if (query.level && entry.level !== query.level) {
      return false
    }
    if (!search) {
      return true
    }
    return [
      entry.source,
      entry.event,
      entry.message,
      ...Object.entries(entry.context).flatMap(([key, value]) => [key, value]),
    ].some((value) => value.toLowerCase().includes(search))
  })
  const skip = Math.max(0, query.skip ?? 0)
  const take = Math.max(1, query.take ?? 200)
  const stats = previewEntries.reduce<LogStats>(
    (result, entry) => {
      const key = `${entry.level}Count` as const
      result[key] += 1
      return result
    },
    {
      errorCount: 0,
      warnCount: 0,
      infoCount: 0,
      debugCount: 0,
      fileCount: previewEntries.length > 0 ? 1 : 0,
      diskBytes: 0,
      unreadableLineCount: 0,
    }
  )

  return {
    entries: filtered.toReversed().slice(skip, skip + take),
    totalCount: previewEntries.length,
    matchedCount: filtered.length,
    hasMore: skip + take < filtered.length,
    stats,
    directory: "（浏览器预览：内存日志）",
  }
}
