import type { CompressionStartRequest } from "./compression"
import {
  compressionPasswordError,
  type CompressionDraft,
} from "./compression-draft.ts"
import { renderCompressionName } from "./compression-naming.ts"

/** Build and validate requests before either queueing or starting native work. */
export function buildCompressionPlan(
  draft: CompressionDraft,
  usePermanentPassword: boolean,
  date = new Date()
) {
  const passwordError = compressionPasswordError(
    draft.password,
    draft.passwordConfirmation
  )
  if (passwordError) throw new Error(passwordError)
  if (draft.retryPasswordRequired && !draft.password)
    throw new Error("原任务使用了密码，请重新输入密码并确认后再压缩。")
  if (draft.sources.length === 0)
    throw new Error("请先添加至少一个文件或文件夹。")
  const separate = draft.packagingMode === "separate"
  if (!separate && !draft.baseName.trim())
    throw new Error("请输入归档基础名称。")
  if (draft.outputMode === "custom" && !draft.outputDirectory)
    throw new Error("请选择自定义输出目录。")
  if (draft.encryptFileNames && !draft.password && !usePermanentPassword)
    throw new Error("开启文件名加密前需要设置密码。")
  const options = {
    outputDirectory:
      draft.outputMode === "custom" ? draft.outputDirectory : null,
    format: draft.format,
    level: draft.level,
    encryptFileNames: draft.encryptFileNames,
    verifyAfterCompression: draft.verifyAfterCompression,
  }
  const requests: Omit<
    CompressionStartRequest,
    "password" | "usePermanentPassword"
  >[] = separate
    ? draft.sources.map((source) => ({
        ...options,
        sources: [source],
        baseName: renderCompressionName(
          draft.batchNameTemplate ?? "{name}",
          source
            .replace(/[\\/]+$/, "")
            .split(/[\\/]/)
            .pop() || "归档",
          date
        ),
      }))
    : [
        {
          ...options,
          sources: [...draft.sources],
          baseName: draft.baseName.trim(),
        },
      ]
  return {
    separate,
    requests,
    passwordRequired: Boolean(draft.password || usePermanentPassword),
    credentials: {
      password: draft.password || undefined,
      usePermanentPassword,
    },
  }
}
