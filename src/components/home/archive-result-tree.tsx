"use client"
import type { ArchiveTreeNode } from "@/lib/recovery"
import { Button } from "@/components/ui/button"
import { archiveNameFromPath } from "./recovery-view-utils"
export function ArchiveResultTree({
  nodes,
  onOpen,
  onRetry,
  disabled,
}: {
  nodes: ArchiveTreeNode[]
  onOpen: (path: string) => void
  onRetry?: (paths: string[]) => void
  disabled: boolean
}) {
  if (!nodes.length) return null
  const children = new Map<string | null, ArchiveTreeNode[]>()
  for (const node of nodes)
    children.set(node.parent, [...(children.get(node.parent) ?? []), node])
  const render = (parent: string | null, depth: number): React.ReactNode =>
    depth > 64 ? null : (
      <ul className="space-y-2 border-l pl-3">
        {(children.get(parent) ?? []).map((node) => (
          <li key={node.path}>
            <div className="flex flex-wrap items-center gap-2">
              <span
                title={node.path}
                className="max-w-full truncate text-sm font-medium"
              >
                {archiveNameFromPath(node.path)}
              </span>
              <span className="text-xs text-muted-foreground">
                {
                  {
                    success: "已解压",
                    skipped: "已跳过",
                    failed: "未完成",
                    pending: "待处理",
                  }[node.state]
                }
              </span>
              {node.output && (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => onOpen(node.output!)}
                >
                  打开输出
                </Button>
              )}
              {node.state !== "success" && onRetry && (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => onRetry([node.path])}
                >
                  重试此归档
                </Button>
              )}
            </div>
            {node.message && node.state !== "success" && (
              <p className="text-xs break-words text-muted-foreground">
                {node.message}
              </p>
            )}
            {children.has(node.path) && render(node.path, depth + 1)}
          </li>
        ))}
      </ul>
    )
  return (
    <details className="rounded-xl border p-3" open>
      <summary className="mb-3 cursor-pointer text-sm font-medium">
        嵌套归档结果树（{nodes.length}）
      </summary>
      <div className="max-h-80 overflow-auto">{render(null, 0)}</div>
    </details>
  )
}
