import { invoke } from "@tauri-apps/api/core"
import { open } from "@tauri-apps/plugin-dialog"

import { createAsyncRefreshCache } from "@/lib/async-refresh-cache"
import { isDesktopRuntime } from "@/lib/dictionary"

export type ArchiveFormat = "sevenZip" | "zip" | "rar3" | "rar5"
export type RecoveryComputeMode = "gpuPreferred" | "cpuOnly"
export type RecoveryComputeDevice = "gpu" | "cpu"

export type RecoveryMethodCapability = {
  id: string
  label: string
  device: RecoveryComputeDevice
  supported: boolean
  available: boolean
  optional: boolean
  message: string
}

export type RecoveryCapabilities = {
  gpuAvailable: boolean
  cpuAvailable: boolean
  methods: RecoveryMethodCapability[]
}

export type RecoveryPhase =
  | "preparing"
  | "verifying"
  | "converting"
  | "hashcat"
  | "john"
  | "internal"
  | "extracting"
  | "recursive"
  | "completed"
  | "exhausted"
  | "cancelled"
  | "failed"

export type ArchiveAnalysis = {
  archivePath: string
  fileName: string
  format: ArchiveFormat
  formatLabel: string
  fileSize: number
  suggestedOutputDirectory: string
  fingerprintSha256: string
  historyMatched: boolean
  hasSavedPassword: boolean
}

export type RecoveryTaskEvent = {
  sequence: number
  elapsedMs: number
  phase: RecoveryPhase
  engine: string | null
  message: string
  archivePath: string | null
  recursiveDepth: number
  attemptedCount: number | null
  totalCount: number | null
  scannedFileCount: number | null
}

export type RecoveryTaskStatus = {
  taskId: string
  phase: RecoveryPhase
  running: boolean
  completed: boolean
  success: boolean
  cancelled: boolean
  archivePath: string
  archiveFormat: ArchiveFormat
  archiveFormatLabel: string
  engine: string | null
  message: string
  candidateCount: number
  attemptedCount: number
  startedAtMs: number
  elapsedMs: number
  recoveredPassword: string | null
  outputDirectory: string
  computeMode: RecoveryComputeMode
  recursiveEnabled: boolean
  recursiveDepth: number
  currentArchivePath: string | null
  nestedArchiveCount: number
  extractedNestedArchiveCount: number
  skippedNestedArchiveCount: number
  scannedFileCount: number
  rootExtractionCompleted: boolean
  depthLimitReached: boolean
  countLimitReached: boolean
  events: RecoveryTaskEvent[]
}

export type RecoveryStartRequest = {
  archivePath: string
  fingerprintSha256?: string | null
  outputDirectory?: string | null
  knownPassword?: string | null
  avoidOutputCollision?: boolean
  recursive?: boolean
  computeMode?: RecoveryComputeMode
}

function requireDesktopRuntime(): void {
  if (!isDesktopRuntime()) {
    throw new Error("归档恢复需要在 ArcRecall 桌面版中运行。")
  }
}

export async function pickArchivePath(): Promise<string | null> {
  requireDesktopRuntime()
  const selected = await open({
    multiple: false,
    directory: false,
    title: "选择待分析文件",
    filters: [
      {
        name: "所有文件（按内容识别）",
        extensions: ["*"],
      },
    ],
  })
  return typeof selected === "string" ? selected : null
}

export async function pickOutputDirectory(): Promise<string | null> {
  requireDesktopRuntime()
  const selected = await open({
    multiple: false,
    directory: true,
    title: "选择输出目录",
  })
  return typeof selected === "string" ? selected : null
}

export async function analyzeArchive(path: string): Promise<ArchiveAnalysis> {
  requireDesktopRuntime()
  return invoke<ArchiveAnalysis>("archive_analyze", { path })
}

async function probeRecoveryCapabilities(): Promise<RecoveryCapabilities> {
  if (!isDesktopRuntime()) {
    return {
      gpuAvailable: false,
      cpuAvailable: false,
      methods: [
        {
          id: "hashcatGpu",
          label: "Hashcat GPU",
          device: "gpu",
          supported: true,
          available: false,
          optional: false,
          message: "浏览器预览不包含桌面计算设备。",
        },
        {
          id: "hashcatCpu",
          label: "Hashcat CPU",
          device: "cpu",
          supported: true,
          available: false,
          optional: true,
          message: "浏览器预览不包含桌面计算设备。",
        },
        {
          id: "johnCpu",
          label: "John CPU",
          device: "cpu",
          supported: true,
          available: false,
          optional: false,
          message: "浏览器预览不包含桌面引擎。",
        },
        {
          id: "sevenZipCpu",
          label: "7-Zip CPU",
          device: "cpu",
          supported: true,
          available: false,
          optional: false,
          message: "浏览器预览不包含桌面引擎。",
        },
      ],
    }
  }
  return invoke<RecoveryCapabilities>("recovery_capabilities")
}

const recoveryCapabilities = createAsyncRefreshCache(probeRecoveryCapabilities)

export function getRecoveryCapabilities(): Promise<RecoveryCapabilities> {
  return recoveryCapabilities.get()
}

export function refreshRecoveryCapabilities(): Promise<RecoveryCapabilities> {
  return recoveryCapabilities.refresh()
}

export async function startRecovery(
  request: RecoveryStartRequest
): Promise<RecoveryTaskStatus> {
  requireDesktopRuntime()
  return invoke<RecoveryTaskStatus>("recovery_start", { request })
}

export async function getRecoveryStatus(
  taskId?: string
): Promise<RecoveryTaskStatus | null> {
  requireDesktopRuntime()
  return invoke<RecoveryTaskStatus | null>("recovery_status", {
    taskId: taskId ?? null,
  })
}

export async function cancelRecovery(taskId: string): Promise<boolean> {
  requireDesktopRuntime()
  return invoke<boolean>("recovery_cancel", { taskId })
}

export async function openOutputDirectory(path: string): Promise<void> {
  requireDesktopRuntime()
  await invoke("open_output_directory", { path })
}
