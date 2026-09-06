export function normalizeCompressionSourcePath(value: string) {
  return value.trim().replace(/^"(.*)"$/, "$1")
}

export function compressionSourceIdentity(path: string) {
  return path.replaceAll("/", "\\").toLowerCase()
}

export function compressionSourceFileName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

export function compressionSourceParent(path: string) {
  const normalized = path.replaceAll("/", "\\").replace(/[\\]+$/, "")
  const separator = normalized.lastIndexOf("\\")
  if (separator <= 2) {
    return normalized.slice(0, Math.max(separator + 1, 3))
  }
  return normalized.slice(0, separator)
}
