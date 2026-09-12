"use client"

import {
  Check,
  ChevronRight,
  CircleAlert,
  Copy,
  Eye,
  EyeOff,
  ListTree,
  PackageOpen,
  Settings2,
} from "lucide-react"
import * as React from "react"

import {
  archiveNameFromPath,
  formatCompactElapsed,
  formatCount,
  formatElapsed,
  isArchiveContainerFailure,
  pathForDisplay,
  RECOVERY_PHASE_LABELS,
  resolveTaskProgress,
} from "@/components/home/recovery-view-utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import type { RecoveryTaskEvent, RecoveryTaskStatus } from "@/lib/recovery"
import { cn } from "@/lib/utils"

export function RecoveryTaskResult({
  rootRef,
  task,
  showPassword,
  passwordCopied,
  onTogglePassword,
  onCopyPassword,
  onOpenOutput,
  onOpenOptions,
  onOpenEngineSettings,
}: {
  rootRef?: React.Ref<HTMLDivElement>
  task: RecoveryTaskStatus
  showPassword: boolean
  passwordCopied: boolean
  onTogglePassword: () => void
  onCopyPassword: () => void
  onOpenOutput: () => void
  onOpenOptions: () => void
  onOpenEngineSettings: () => void
}) {
  const progress = resolveTaskProgress(task)
  const hasCandidateProgress =
    task.candidateCount > 0 && task.attemptedCount > 0
  const hasRecursiveProgress =
    task.recursiveEnabled &&
    (task.phase === "recursive" ||
      task.recursiveDepth > 0 ||
      task.nestedArchiveCount > 0 ||
      task.extractedNestedArchiveCount > 0 ||
      task.skippedNestedArchiveCount > 0)
  const elapsedLabel = formatElapsed(task.elapsedMs)
  const activePhaseLabel =
    task.running && task.rootExtractionCompleted
      ? "递归处理"
      : RECOVERY_PHASE_LABELS[task.phase]
  const recoveryHint = taskRecoveryHint(task)
  const archiveContainerFailure = isArchiveContainerFailure(task)

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      role={task.phase === "failed" ? "alert" : "status"}
      aria-live="polite"
      className={cn(
        "workbench-panel animate-task-card-enter motion-safe-only shrink-0 overflow-hidden rounded-2xl border bg-card outline-none",
        task.success
          ? "border-success/35"
          : task.phase === "failed"
            ? "border-destructive/35"
            : task.phase === "exhausted"
              ? "border-warning/40"
              : "border-border"
      )}
    >
      {task.running && !(task.phase === "hashcat" && task.hashcatProgress) ? (
        <Progress
          value={progress}
          aria-label="恢复进度"
          className="[&_[data-slot=progress-indicator]]:progress-live [&_[data-slot=progress-track]]:h-0.5 [&_[data-slot=progress-track]]:rounded-none"
        />
      ) : null}
      {task.running && task.phase === "hashcat" && task.hashcatProgress ? (
        <div className="px-3 pt-3 text-xs text-muted-foreground tabular-nums">
          <p>
            当前引擎进度{" "}
            {(
              (task.hashcatProgress.completed / task.hashcatProgress.total) *
              100
            ).toFixed(1)}
            % · {formatCount(task.hashcatProgress.hashesPerSecond)} H/s
            {task.hashcatProgress.remainingSeconds !== null
              ? ` · 预计剩余 ${formatElapsed(task.hashcatProgress.remainingSeconds * 1000)}`
              : " · 正在估算剩余时间"}
            {task.hashcatProgress.temperatureCelsius !== null
              ? ` · ${task.hashcatProgress.temperatureCelsius}°C`
              : ""}
          </p>
          <Progress
            className="mt-2"
            value={Math.min(
              100,
              (task.hashcatProgress.completed / task.hashcatProgress.total) *
                100
            )}
            aria-label="Hashcat 当前引擎进度"
          />
        </div>
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
                    : "text-warning-foreground"
                )}
              />
            )}
            <p className="text-xs font-semibold">
              {activePhaseLabel}
              {task.engine ? ` · ${task.engine}` : ""}
            </p>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {task.message}
          </p>
          {task.running && task.rootExtractionCompleted ? (
            <p className="mt-1 text-xs text-success-foreground">
              主归档已完成，当前仅处理递归发现的嵌套归档。
            </p>
          ) : null}
          {hasCandidateProgress || task.elapsedMs > 0 ? (
            <p className="mt-1 text-xs text-muted-foreground tabular-nums">
              {hasCandidateProgress
                ? `已尝试 ${formatCount(task.attemptedCount)} / ${formatCount(task.candidateCount)} 条候选 · `
                : ""}
              用时 {elapsedLabel}
            </p>
          ) : null}
          {hasRecursiveProgress ? (
            <div className="mt-1 flex flex-col gap-0.5 text-xs text-muted-foreground">
              <p className="tabular-nums">
                已扫描 {formatCount(task.scannedFileCount)} 个文件 ·
                嵌套归档：发现 {formatCount(task.nestedArchiveCount)} · 已解开{" "}
                {formatCount(task.extractedNestedArchiveCount)} · 跳过{" "}
                {formatCount(task.skippedNestedArchiveCount)}
                {task.running && task.recursiveDepth > 0
                  ? ` · 当前第 ${task.recursiveDepth} 层`
                  : ""}
              </p>
              {task.running &&
              task.recursiveDepth > 0 &&
              task.currentArchivePath ? (
                <p
                  className="truncate"
                  title={pathForDisplay(task.currentArchivePath)}
                >
                  {task.phase === "recursive" ? "正在扫描" : "正在处理"}：
                  {archiveNameFromPath(task.currentArchivePath)}
                </p>
              ) : null}
              {task.depthLimitReached ||
              task.countLimitReached ||
              task.budgetLimitReached ? (
                <p className="text-warning-foreground">
                  已达到递归安全限制，剩余嵌套归档未继续处理。
                </p>
              ) : null}
            </div>
          ) : null}
          {recoveryHint ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl bg-muted/40 px-3 py-2">
              <p className="min-w-52 flex-1 text-xs leading-relaxed text-muted-foreground">
                {recoveryHint}
              </p>
              {!archiveContainerFailure ? (
                <>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={onOpenOptions}
                  >
                    <Settings2 data-icon="inline-start" />
                    调整选项
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={onOpenEngineSettings}
                  >
                    检查引擎
                  </Button>
                </>
              ) : null}
            </div>
          ) : null}
          <RecoveryProcessDetails key={task.taskId} task={task} />
          {task.recoveredPassword != null ? (
            <div className="mt-2 flex items-center gap-2">
              <code className="max-w-full truncate rounded bg-muted px-2 py-1 text-xs">
                {showPassword ? task.recoveredPassword : "••••••••"}
              </code>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={onTogglePassword}
                aria-label={showPassword ? "隐藏恢复密码" : "显示恢复密码"}
              >
                {showPassword ? (
                  <EyeOff className="size-3.5" />
                ) : (
                  <Eye className="size-3.5" />
                )}
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={onCopyPassword}
                aria-label={passwordCopied ? "恢复密码已复制" : "复制恢复密码"}
              >
                {passwordCopied ? (
                  <Check className="size-3.5 text-success-foreground" />
                ) : (
                  <Copy className="size-3.5" />
                )}
              </Button>
            </div>
          ) : null}
        </div>
        {task.success || task.rootExtractionCompleted ? (
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={onOpenOutput}
          >
            <PackageOpen data-icon="inline-start" />
            打开输出
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function taskRecoveryHint(task: RecoveryTaskStatus): string | null {
  if (task.running || task.success) {
    return null
  }
  if (task.cancelled) {
    if (task.rootExtractionCompleted) {
      return "已完成的输出已保留。可在详细过程中查看完成、跳过和待处理清单，再选择未完成的归档继续处理。"
    }
    return "任务已取消，所选归档和当前设置仍然保留，可调整后重新开始。"
  }
  if (task.phase === "exhausted") {
    return "没有找到可用密码。可补充已知密码、导入候选字典或检查解密引擎后重试。"
  }
  if (task.phase === "failed") {
    if (isArchiveContainerFailure(task)) {
      return "7-Zip 无法读取有效归档结构。请确认文件完整，且确实包含可打开的 7z、ZIP 或 RAR 数据；GPU 尚未开始。"
    }
    return "请先查看详细过程定位原因，再调整输出选项或解密引擎后重试。"
  }
  return null
}

function RecoveryProcessDetails({ task }: { task: RecoveryTaskStatus }) {
  const [open, setOpen] = React.useState(false)
  const events = task.events ?? []

  if (
    events.length === 0 &&
    !task.completedArchivePaths?.length &&
    !task.pendingArchivePaths?.length &&
    !task.skippedArchivePaths?.length
  ) {
    return null
  }

  const latest = events[0]

  return (
    <>
      <div className="mt-2 flex min-w-0 items-center gap-2 rounded-lg border border-border/70 bg-muted/20 px-2.5 py-1.5">
        <ListTree className="size-3.5 shrink-0 text-muted-foreground" />
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {latest
            ? `最近：${RECOVERY_PHASE_LABELS[latest.phase]}${latest.engine ? ` · ${latest.engine}` : ""} · ${formatCompactElapsed(latest.elapsedMs)}`
            : "查看已完成和待处理归档"}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 shrink-0 rounded-md px-2 text-xs"
          onClick={() => setOpen(true)}
        >
          详细过程
          <Badge variant="secondary" className="font-normal tabular-nums">
            {events.length}
          </Badge>
          <ChevronRight data-icon="inline-end" />
        </Button>
      </div>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right">
          <SheetHeader className="shrink-0 border-b border-border/80 px-5 py-4 pr-14">
            <div className="flex flex-wrap items-center gap-2">
              <SheetTitle>解密详细过程</SheetTitle>
              <Badge
                variant={task.running ? "default" : "secondary"}
                className="font-normal"
              >
                {task.running ? "实时更新" : RECOVERY_PHASE_LABELS[task.phase]}
              </Badge>
            </div>
            <SheetDescription className="text-xs leading-relaxed">
              最新事件置顶，共 {events.length} 条；关闭抽屉不会中断恢复任务。
            </SheetDescription>
            <div className="flex flex-wrap gap-1.5 pt-1">
              <Badge variant="outline" className="font-normal">
                计划：{task.computeMode === "cpuOnly" ? "仅 CPU" : "GPU 优先"}
              </Badge>
              <Badge variant="outline" className="font-normal">
                当前：{task.engine || "7-Zip CPU 基础校验"}
              </Badge>
              <Badge variant="outline" className="font-normal tabular-nums">
                用时：{formatElapsed(task.elapsedMs)}
              </Badge>
            </div>
          </SheetHeader>

          <ScrollArea className="min-h-0 flex-1 px-5 py-2">
            {task.completed && (task.completedArchivePaths?.length ?? 0) > 0 ? (
              <div className="space-y-3 border-b border-border py-3">
                {[
                  { label: "已完成", paths: task.completedArchivePaths ?? [] },
                  {
                    label: "已跳过",
                    paths: task.skippedArchivePaths ?? [],
                  },
                  {
                    label: "待处理（已发现）",
                    paths: task.pendingArchivePaths ?? [],
                  },
                ].map(({ label, paths }) =>
                  paths.length > 0 ? (
                    <div key={label}>
                      <p className="text-xs font-medium">
                        {label} · {paths.length}
                      </p>
                      <ul
                        aria-label={`${label}归档`}
                        className="mt-1 space-y-1 text-xs text-muted-foreground"
                      >
                        {paths.map((path) => (
                          <li key={path} className="break-all">
                            {pathForDisplay(path)}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null
                )}
                {task.scanInterrupted ? (
                  <p className="text-xs text-warning-foreground">
                    扫描已中断，输出目录中可能还有尚未发现的嵌套归档。
                  </p>
                ) : null}
              </div>
            ) : null}
            <ol aria-label="解密事件时间线">
              {events.map((event, index) => {
                const current = task.running && index === 0
                const metadata = recoveryEventMetadata(event)
                return (
                  <li
                    key={event.sequence}
                    className="relative grid grid-cols-[50px_18px_minmax(0,1fr)] gap-2 py-3 before:absolute before:top-8 before:bottom-0 before:left-[60px] before:w-px before:bg-border last:before:hidden"
                  >
                    <time className="pt-0.5 text-xs text-muted-foreground tabular-nums">
                      {formatCompactElapsed(event.elapsedMs)}
                    </time>
                    <span className="relative z-10 flex justify-center pt-0.5">
                      {current ? (
                        <span className="flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
                          <Spinner className="size-2.5" />
                        </span>
                      ) : event.phase === "failed" ||
                        event.phase === "cancelled" ||
                        event.phase === "exhausted" ? (
                        <span className="flex size-4 items-center justify-center rounded-full bg-warning/15 text-warning-foreground">
                          <CircleAlert className="size-2.5" />
                        </span>
                      ) : (
                        <span className="mt-1 size-2 rounded-full border-2 border-background bg-muted-foreground/60 ring-1 ring-border" />
                      )}
                    </span>
                    <div
                      className={cn(
                        "min-w-0 pb-3",
                        index < events.length - 1 && "border-b border-border/50"
                      )}
                    >
                      <p
                        className="truncate text-xs font-medium"
                        title={
                          event.archivePath
                            ? pathForDisplay(event.archivePath)
                            : undefined
                        }
                      >
                        {RECOVERY_PHASE_LABELS[event.phase]}
                        {event.engine ? ` · ${event.engine}` : ""}
                        {event.archivePath
                          ? ` · ${archiveNameFromPath(event.archivePath)}`
                          : ""}
                      </p>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        {event.message}
                      </p>
                      {metadata ? (
                        <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                          {metadata}
                        </p>
                      ) : null}
                    </div>
                  </li>
                )
              })}
            </ol>
          </ScrollArea>

          <Separator />
          <p className="shrink-0 px-5 py-3 text-xs text-muted-foreground">
            为保护密码安全，仅展示候选进度，不展示或记录具体候选内容。
          </p>
        </SheetContent>
      </Sheet>
    </>
  )
}

function recoveryEventMetadata(event: RecoveryTaskEvent): string {
  const parts: string[] = []
  if (event.recursiveDepth > 0) {
    parts.push(`第 ${event.recursiveDepth} 层`)
  }
  if (
    event.attemptedCount != null &&
    event.totalCount != null &&
    event.totalCount > 0
  ) {
    parts.push(
      `候选 ${formatCount(event.attemptedCount)} / ${formatCount(event.totalCount)}`
    )
  }
  if (event.scannedFileCount != null) {
    parts.push(`累计扫描 ${formatCount(event.scannedFileCount)} 个文件`)
  }
  return parts.join(" · ")
}
