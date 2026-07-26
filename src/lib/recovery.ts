import { invoke } from "@tauri-apps/api/core"
import { open } from "@tauri-apps/plugin-dialog"

import { isDesktopRuntime } from "@/lib/dictionary"

export type ArchiveFormat = "sevenZip" | "zip" | "rar3" | "rar5"

export type RecoveryPhase =
  | "preparing"
  | "verifying"
  | "converting"
  | "hashcat"
  | "john"
  | "extracting"
  | "completed"
  | "cancelled"
  | "failed"

export type ArchiveAnalysis = {
  archivePath: string
  fileName: string
  format: ArchiveFormat
  formatLabel: string
  fileSize: number
  suggestedOutputDirectory: string
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
  recoveredPassword: string | null
  outputDirectory: string
}

export type RecoveryStartRequest = {
  archivePath: string
  outputDirectory?: string | null
  knownPassword?: string | null
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
    title: "选择压缩包",
    filters: [
      {
        name: "支持的压缩包",
        extensions: ["7z", "zip", "rar", "001", "exe"],
      },
      { name: "所有文件", extensions: ["*"] },
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
