export type DroppedArchiveResolution = {
  path: string | null
  error: string | null
}

export function resolveDroppedArchivePath(
  paths: readonly string[]
): DroppedArchiveResolution {
  const usablePaths = paths.filter((path) => path.trim().length > 0)
  if (usablePaths.length === 0) {
    return { path: null, error: null }
  }
  if (usablePaths.length > 1) {
    return {
      path: null,
      error: `当前一次只能分析一个文件。本次拖入了 ${usablePaths.length} 项，未处理任何文件；请只拖入一个压缩包。`,
    }
  }
  return { path: usablePaths[0]!, error: null }
}
