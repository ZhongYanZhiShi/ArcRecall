import type { CompressionFormat } from "@/lib/compression"

type OutputMode = "sibling" | "custom"
type CompressionLevel = 0 | 1 | 3 | 5 | 7 | 9

export type CompressionDraft = {
  sources: string[]
  outputMode: OutputMode
  outputDirectory: string | null
  baseName: string
  format: CompressionFormat
  level: CompressionLevel
  password: string
  passwordConfirmation: string
  encryptFileNames: boolean
  openWhenDone: boolean
  useAiRename: boolean
}

export function createCompressionDraft(): CompressionDraft {
  return {
    sources: [],
    outputMode: "sibling",
    outputDirectory: null,
    baseName: "",
    format: "sevenZip",
    level: 5,
    password: "",
    passwordConfirmation: "",
    encryptFileNames: false,
    openWhenDone: true,
    useAiRename: false,
  }
}

export function compressionPasswordError(
  password: string,
  confirmation: string
): string | null {
  return password && password !== confirmation
    ? "两次输入的密码不一致，请重新确认。"
    : null
}

export function forgetCompletedArchiveBaseName<
  Draft extends { baseName: string },
>(draft: Draft): Draft {
  return { ...draft, baseName: "" }
}

export function shouldForgetArchiveBaseName(
  task: {
    taskId: string
    running: boolean
    completed: boolean
    success: boolean
  },
  awaitingCompletion: Set<string>
): boolean {
  if (task.running) {
    awaitingCompletion.add(task.taskId)
    return false
  }
  if (!task.completed) {
    return false
  }
  return awaitingCompletion.delete(task.taskId) && task.success
}

export function shouldAutoOpenCompletedTask(
  task: {
    taskId: string
    completed: boolean
    success: boolean
  } | null,
  openWhenDone: boolean,
  observedCompletions: Set<string>
): boolean {
  if (!task?.completed || observedCompletions.has(task.taskId)) {
    return false
  }
  observedCompletions.add(task.taskId)
  return openWhenDone && task.success
}
