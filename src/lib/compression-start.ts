export class CompressionRenameError extends Error {
  constructor(reason: unknown) {
    super(
      reason instanceof Error ? reason.message : String(reason ?? "未知错误"),
      { cause: reason }
    )
    this.name = "CompressionRenameError"
  }
}

/** Keep naming failures distinct from failures after the name was accepted. */
export async function startCompressionWithRename<Task>(
  baseName: string,
  operations: {
    rename?: (baseName: string) => Promise<string>
    onRenamed: (name: string) => void
    start: (name: string) => Promise<Task>
  }
): Promise<Task> {
  let resolvedName = baseName
  if (operations.rename) {
    try {
      resolvedName = await operations.rename(baseName)
    } catch (reason) {
      throw new CompressionRenameError(reason)
    }
    operations.onRenamed(resolvedName)
  }
  return operations.start(resolvedName)
}
