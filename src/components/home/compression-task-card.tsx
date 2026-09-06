import { Check, CircleAlert, FolderOpen } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import type { CompressionTaskStatus } from "@/lib/compression"
import { cn } from "@/lib/utils"

export function CompressionTaskCard({
  task,
  onOpen,
}: {
  task: CompressionTaskStatus
  onOpen: () => void
}) {
  const progress =
    task.totalSourceCount > 0
      ? Math.min(
          100,
          Math.round((task.processedSourceCount / task.totalSourceCount) * 100)
        )
      : 0
  return (
    <section
      className={cn(
        "workbench-panel animate-task-card-enter motion-safe-only shrink-0 overflow-hidden rounded-2xl border bg-card",
        task.success
          ? "border-success/35"
          : task.phase === "failed"
            ? "border-destructive/35"
            : "border-border"
      )}
    >
      {task.running ? (
        <Progress
          value={progress}
          aria-label="压缩进度"
          className="[&_[data-slot=progress-indicator]]:progress-live [&_[data-slot=progress-track]]:h-0.5 [&_[data-slot=progress-track]]:rounded-none"
        />
      ) : null}
      <div className="flex items-start justify-between gap-3 p-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {task.running ? (
              <Spinner />
            ) : task.success ? (
              <Check className="animate-success-pop motion-safe-only size-4 shrink-0 text-success-foreground" />
            ) : (
              <CircleAlert
                className={cn(
                  "size-4 shrink-0",
                  task.phase === "failed"
                    ? "text-destructive"
                    : "text-muted-foreground"
                )}
              />
            )}
            <p className="text-xs font-semibold">
              {task.running
                ? "正在压缩"
                : task.success
                  ? "压缩完成"
                  : task.cancelled
                    ? "已取消"
                    : "压缩失败"}
            </p>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {task.message}
          </p>
          <p className="mt-1 text-xs text-muted-foreground tabular-nums">
            {task.processedSourceCount} / {task.totalSourceCount} 个来源 · 用时{" "}
            {formatElapsed(task.elapsedMs)}
          </p>
          <p
            className="mt-1 truncate font-mono text-xs text-muted-foreground"
            title={task.outputPath}
          >
            {task.outputPath}
          </p>
        </div>
        {task.success ? (
          <Button type="button" variant="outline" size="sm" onClick={onOpen}>
            <FolderOpen data-icon="inline-start" />
            定位归档
          </Button>
        ) : null}
      </div>
    </section>
  )
}

function formatElapsed(elapsedMs: number) {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`
}
