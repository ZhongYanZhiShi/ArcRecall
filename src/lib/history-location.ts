import { openPath } from "@/lib/settings"

export function historyLocationDirectory(
  path: string,
  kind: "archive" | "output"
): string {
  if (kind === "output") return path
  const index = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"))
  if (index < 0) throw new Error("这条记录没有可打开的所在文件夹。")
  const parent = path.slice(0, index)
  if (index === 0 || /(?:^|\\)[a-z]:$/i.test(parent))
    return path.slice(0, index + 1)
  return parent
}

export async function openHistoryLocation(
  path: string,
  kind: "archive" | "output"
): Promise<void> {
  await openPath(historyLocationDirectory(path, kind))
}
