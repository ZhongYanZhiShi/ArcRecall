import type {
  RecoveryCapabilities,
  RecoveryComputeMode,
  RecoveryPhase,
  RecoveryTaskStatus,
} from "@/lib/recovery"

export const RECOVERY_PHASE_LABELS: Record<RecoveryPhase, string> = {
  preparing: "准备",
  verifying: "复验",
  converting: "转换",
  hashcat: "Hashcat",
  john: "John CPU",
  internal: "7-Zip CPU",
  extracting: "解压",
  recursive: "递归解密",
  completed: "完成",
  exhausted: "未找到密码",
  cancelled: "已取消",
  failed: "失败",
}

const COUNT_FORMATTER = new Intl.NumberFormat("zh-CN")
const PRE_GPU_FAILURE_PHASES = new Set<RecoveryPhase>([
  "preparing",
  "verifying",
  "converting",
])

export function recoveryComputeSummary(
  task: RecoveryTaskStatus | null,
  mode: RecoveryComputeMode,
  capabilities: RecoveryCapabilities | null,
  saving: boolean
): string {
  if (saving) {
    return "正在保存默认解密方式…"
  }
  if (task?.running) {
    if (task.rootExtractionCompleted) {
      return `主归档已解压，正在递归检查：${task.engine || "7-Zip"}`
    }
    return `当前正在使用：${task.engine || "7-Zip CPU 基础校验"}`
  }
  if (task?.completed) {
    if (
      task.phase === "failed" &&
      task.computeMode === "gpuPreferred" &&
      !task.gpuStarted &&
      task.failurePhase !== null &&
      PRE_GPU_FAILURE_PHASES.has(task.failurePhase)
    ) {
      return isArchiveContainerFailure(task)
        ? "7-Zip 基础校验失败，尚未进入 GPU 密码恢复"
        : "任务在 GPU 启动前失败，尚未进入 GPU 密码恢复"
    }
    return `本次实际使用：${task.engine || "7-Zip CPU"}`
  }
  if (mode === "cpuOnly") {
    return "准备仅使用 CPU，不会调用 GPU"
  }
  if (capabilities && !capabilities.gpuAvailable) {
    return "未检测到可用 GPU，任务会自动使用 CPU"
  }
  return "准备优先使用 GPU，失败时自动回退 CPU"
}

export function isArchiveContainerFailure(task: RecoveryTaskStatus): boolean {
  return task.phase === "failed" && task.failureKind === "invalidArchive"
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`
}

export function resolveTaskProgress(task: RecoveryTaskStatus): number {
  if (task.completed) {
    return 100
  }
  if (task.recursiveDepth > 0) {
    if (
      task.phase === "internal" &&
      task.candidateCount > 0 &&
      task.attemptedCount > 0
    ) {
      const candidateRatio = Math.min(
        1,
        task.attemptedCount / task.candidateCount
      )
      return Math.round(94 + candidateRatio * 4)
    }
    return 94
  }
  if (
    task.phase === "internal" &&
    task.candidateCount > 0 &&
    task.attemptedCount > 0
  ) {
    const candidateRatio = Math.min(
      1,
      task.attemptedCount / task.candidateCount
    )
    return Math.round(68 + candidateRatio * 20)
  }
  const phaseProgress: Record<RecoveryPhase, number> = {
    preparing: 6,
    verifying: 16,
    converting: 30,
    hashcat: 48,
    john: 62,
    internal: 68,
    extracting: 92,
    recursive: 94,
    completed: 100,
    exhausted: 100,
    cancelled: 100,
    failed: 100,
  }
  return phaseProgress[task.phase]
}

export function formatCount(value: number): string {
  return COUNT_FORMATTER.format(value)
}

export function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return [hours, minutes, seconds]
    .map((value) => value.toString().padStart(2, "0"))
    .join(":")
}

export function formatCompactElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes.toString().padStart(2, "0")}:${seconds
    .toString()
    .padStart(2, "0")}`
}

export function archiveNameFromPath(path: string): string {
  const displayPath = pathForDisplay(path)
  return displayPath.split(/[\\/]/).filter(Boolean).at(-1) ?? displayPath
}

export function pathForDisplay(path: string): string {
  if (path.startsWith("\\\\?\\UNC\\")) {
    return `\\\\${path.slice(8)}`
  }
  return path.startsWith("\\\\?\\") ? path.slice(4) : path
}
