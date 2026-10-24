import type { CompressionFormat } from "@/lib/compression"

type OutputMode = "sibling" | "custom"
type CompressionLevel = 0 | 1 | 3 | 5 | 7 | 9

export type CompressionDraft = {
  packagingMode?: "combined" | "separate"
  batchNameTemplate?: string
  verifyAfterCompression: boolean
  retryPasswordRequired?: boolean
  retryPrepared?: boolean
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
  useAiFileReference: boolean
  aiReferenceExtensions: string
  aiCustomReferenceExtensions: string[]
}

export function createCompressionDraft(): CompressionDraft {
  return {
    packagingMode: "combined",
    batchNameTemplate: "{name}",
    verifyAfterCompression: false,
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
    useAiFileReference: false,
    aiReferenceExtensions: "txt, md",
    aiCustomReferenceExtensions: [],
  }
}

export const AI_REFERENCE_EXTENSION_OPTIONS = [
  "txt",
  "md",
  "json",
  "yaml",
  "yml",
  "csv",
  "log",
  "xml",
]

export function parseAiReferenceExtensions(value: string): string[] {
  const extensions = value
    .split(/[\s,，;；]+/)
    .filter(Boolean)
    .map((token) => token.replace(/^(?:\*\.|\.+)/, "").toLowerCase())
  if (
    extensions.some(
      (extension) =>
        !/^[a-z0-9_.+-]{1,32}$/.test(extension) || extension.endsWith(".")
    )
  ) {
    throw new Error("请输入有效后缀，例如 txt、.md 或 *.json。")
  }
  return [...new Set(extensions)]
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
