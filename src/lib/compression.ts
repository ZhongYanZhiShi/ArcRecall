import { invoke } from "@tauri-apps/api/core"
import { open } from "@tauri-apps/plugin-dialog"

import { isDesktopRuntime } from "@/lib/dictionary"

export type CompressionFormat = "sevenZip" | "zip"

export type CompressionPhase =
  | "preparing"
  | "compressing"
  | "completed"
  | "cancelled"
  | "failed"

export type CompressionStartRequest = {
  sources: string[]
  outputDirectory?: string | null
  baseName: string
  format: CompressionFormat
  level: 0 | 1 | 3 | 5 | 7 | 9
  password?: string | null
  usePermanentPassword?: boolean
  encryptFileNames?: boolean
}

export type CompressionPasswordStatus = {
  hasPassword: boolean
}

export type CompressionTaskStatus = {
  taskId: string
  phase: CompressionPhase
  running: boolean
  completed: boolean
  success: boolean
  cancelled: boolean
  message: string
  processedSourceCount: number
  totalSourceCount: number
  startedAtMs: number
  elapsedMs: number
  outputPath: string
}

function requireDesktopRuntime(): void {
  if (!isDesktopRuntime()) {
    throw new Error("创建归档需要在 ArcRecall 桌面版中运行。")
  }
}

export async function pickCompressionFiles(): Promise<string[]> {
  requireDesktopRuntime()
  const selected = await open({
    multiple: true,
    directory: false,
    title: "选择要压缩的文件",
  })
  if (Array.isArray(selected)) {
    return selected
  }
  return typeof selected === "string" ? [selected] : []
}

export async function pickCompressionFolder(): Promise<string | null> {
  requireDesktopRuntime()
  const selected = await open({
    multiple: false,
    directory: true,
    title: "选择要压缩的文件夹",
  })
  return typeof selected === "string" ? selected : null
}

export async function pickCompressionOutputDirectory(): Promise<string | null> {
  requireDesktopRuntime()
  const selected = await open({
    multiple: false,
    directory: true,
    title: "选择归档输出目录",
  })
  return typeof selected === "string" ? selected : null
}

export async function startCompression(
  request: CompressionStartRequest
): Promise<CompressionTaskStatus> {
  requireDesktopRuntime()
  return invoke<CompressionTaskStatus>("compression_start", { request })
}

export async function getPermanentCompressionPasswordStatus(): Promise<CompressionPasswordStatus> {
  if (!isDesktopRuntime()) {
    return { hasPassword: false }
  }
  return invoke<CompressionPasswordStatus>("compression_password_status")
}

export async function savePermanentCompressionPassword(
  password: string
): Promise<CompressionPasswordStatus> {
  requireDesktopRuntime()
  return invoke<CompressionPasswordStatus>("compression_password_save", {
    password,
  })
}

export async function deletePermanentCompressionPassword(): Promise<CompressionPasswordStatus> {
  requireDesktopRuntime()
  return invoke<CompressionPasswordStatus>("compression_password_delete")
}

export async function getCompressionStatus(
  taskId?: string
): Promise<CompressionTaskStatus | null> {
  requireDesktopRuntime()
  return invoke<CompressionTaskStatus | null>("compression_status", {
    taskId: taskId ?? null,
  })
}

export async function cancelCompression(taskId: string): Promise<boolean> {
  requireDesktopRuntime()
  return invoke<boolean>("compression_cancel", { taskId })
}
