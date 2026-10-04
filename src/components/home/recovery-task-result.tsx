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
  hasIncompleteRecursiveScan,
  recoveryStageLabel,
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
  onOpenDirectory,
  onRescan,
  onRetryArchives,
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
  onOpenDirectory: (path: string) => void
  onRescan?: () => void
  onRetryArchives?: (paths: string[]) => void
  onOpenOptions: () => void
  onOpenEngineSettings: () => void
}) {
  const incompleteScan = hasIncompleteRecursiveScan(task)
  const skippedDirectories = task.skippedScanDirectories ?? []
  const progress = resolveTaskProgress(task)
  const hasCandidateProgress =
    task.candidateCount > 0 && task.attemptedCount > 0
  const hasRecursiveProgress =
    task.recursiveEnabled &&
    (task.completed ||
      task.phase === "recursive" ||
      task.recursiveDepth > 0 ||
      task.nestedArchiveCount > 0 ||
      task.extractedNestedArchiveCount > 0 ||
      task.skippedNestedArchiveCount > 0)
  const elapsedLabel = formatElapsed(task.elapsedMs)
  const activePhaseLabel =
    task.running && task.rootExtractionCompleted
      ? "递归处理"
      : task.success && incompleteScan
        ? "解压完成 · 扫描未完成"
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
        task.success && incompleteScan
          ? "border-warning/40"
          : task.success
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
            ) : task.success && !incompleteScan ? (
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
              主归档已完成，正在处理嵌套归档。
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
                已检查 {formatCount(task.scannedFileCount)} 个文件（归档识别） ·
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
          {task.completed && skippedDirectories.length > 0 ? (
            <div className="mt-2 space-y-2 rounded-lg bg-warning/10 p-3 text-xs">
              <p className="text-warning-foreground">
                {skippedDirectories.length}{" "}
                个目录及其子目录尚未扫描。已解压的文件仍保留；扫描数不代表解压文件总数。
              </p>
              {onRescan ? (
                <Button size="sm" variant="outline" onClick={onRescan}>
                  补扫未扫描目录（不限文件数）
                </Button>
              ) : (
                <p className="text-muted-foreground">
                  补扫入口适用于当前会话中最近完成的任务，其他任务的目录可在详细过程中打开。
                </p>
              )}
            </div>
          ) : null}
          <RecoveryProcessDetails
            key={task.taskId}
            task={task}
            onOpenDirectory={onOpenDirectory}
            onRetryArchives={onRetryArchives}
          />
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
          <div className="flex shrink-0 flex-col gap-2">
            {!task.running &&
            task.contentDirectories?.length === 1 &&
            task.contentDirectories[0] !== task.outputDirectory ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => onOpenDirectory(task.contentDirectories![0])}
              >
                打开最终内容目录
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={onOpenOutput}
            >
              <PackageOpen data-icon="inline-start" />
              打开输出
            </Button>
          </div>
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
      return "已保留完成的输出。可在详细过程中查看并选择未完成归档重试。"
    }
    return "归档和设置已保留，可重新开始。"
  }
  if (task.phase === "exhausted") {
    return "可补充已知密码、导入字典或检查引擎后重试。"
  }
  if (task.phase === "failed") {
    if (isArchiveContainerFailure(task)) {
      return "无法读取归档。请确认文件完整且包含有效的 7z、ZIP 或 RAR 数据。"
    }
    return "查看详细过程，检查输出选项或引擎后重试。"
  }
  return null
}

function RecoveryProcessDetails({
  task,
  onOpenDirectory,
  onRetryArchives,
}: {
  task: RecoveryTaskStatus
  onOpenDirectory: (path: string) => void
  onRetryArchives?: (paths: string[]) => void
}) {
  const [open, setOpen] = React.useState(false)
  const [selection, setSelection] = React.useState<string[]>([])
  const retryPaths = [
    ...new Set([
      ...(task.skippedArchivePaths ?? []),
      ...(task.pendingArchivePaths ?? []),
    ]),
  ]
  const selectedPaths = selection.filter((path) => retryPaths.includes(path))
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
            ? `最近：${recoveryStageLabel(latest.phase, latest.engine)} · ${formatCompactElapsed(latest.elapsedMs)}`
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
              <SheetTitle>解压与扫描详细过程</SheetTitle>
              <Badge
                variant={task.running ? "default" : "secondary"}
                className="font-normal"
              >
                {task.running ? "实时更新" : RECOVERY_PHASE_LABELS[task.phase]}
              </Badge>
            </div>
            <SheetDescription className="text-xs leading-relaxed">
              最新事件置顶，保留最近 {events.length} 条；连续扫描进度合并显示。
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
            {task.timings?.length ? (
              <div className="space-y-1 border-b border-border py-3 text-xs">
                <p className="font-medium">各阶段累计耗时</p>
                {task.timings.map((timing) => (
                  <p
                    key={timing.operation}
                    className="text-muted-foreground tabular-nums"
                  >
                    {
                      {
                        fingerprint: "指纹与历史查询",
                        preflight: "归档预检",
                        verification: "密码与完整性检查",
                        extraction: "安全解压",
                        scan: "目录扫描",
                      }[timing.operation]
                    }
                    ：{(timing.durationMs / 1000).toFixed(2)} 秒
                  </p>
                ))}
                <p className="text-muted-foreground">
                  本次任务的各归档累计值；不含分卷准备、GPU/John
                  搜索和历史写入等开销。
                </p>
              </div>
            ) : null}
            {[
              { label: "未扫描目录", paths: task.skippedScanDirectories ?? [] },
              { label: "最终内容目录", paths: task.contentDirectories ?? [] },
            ].map(({ label, paths }) =>
              paths.length ? (
                <div key={label} className="border-b border-border py-3">
                  <p className="text-xs font-medium">
                    {label} · {paths.length}
                  </p>
                  <ul aria-label={label} className="mt-2 space-y-2">
                    {paths.map((path) => (
                      <li key={path} className="space-y-1">
                        <p className="text-xs break-all text-muted-foreground">
                          {pathForDisplay(path)}
                        </p>
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() => onOpenDirectory(path)}
                        >
                          打开目录
                        </Button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null
            )}
            {task.completed &&
            (retryPaths.length > 0 ||
              (task.completedArchivePaths?.length ?? 0) > 0) ? (
              <div className="space-y-3 border-b border-border py-3">
                {retryPaths.length > 0 ? (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">
                      勾选跳过或待处理归档，加入队列后重新运行。原任务的计算、递归选项和当前会话密码会沿用；输出使用新的独立目录。
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={!onRetryArchives}
                        onClick={() =>
                          setSelection(
                            selectedPaths.length === retryPaths.length
                              ? []
                              : retryPaths
                          )
                        }
                      >
                        {selectedPaths.length === retryPaths.length
                          ? "取消全选"
                          : "全选未完成归档"}
                      </Button>
                      <Button
                        size="xs"
                        disabled={
                          !onRetryArchives || selectedPaths.length === 0
                        }
                        onClick={() => {
                          onRetryArchives?.(selectedPaths)
                          setSelection([])
                          setOpen(false)
                        }}
                      >
                        加入重试队列（{selectedPaths.length}）
                      </Button>
                    </div>
                  </div>
                ) : null}
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
                            {label !== "已完成" ? (
                              <label className="flex items-start gap-2">
                                <input
                                  type="checkbox"
                                  aria-label={`重试 ${pathForDisplay(path)}`}
                                  disabled={!onRetryArchives}
                                  checked={selectedPaths.includes(path)}
                                  onChange={(event) =>
                                    setSelection((previous) =>
                                      event.target.checked
                                        ? [...new Set([...previous, path])]
                                        : previous.filter(
                                            (item) => item !== path
                                          )
                                    )
                                  }
                                />
                                <span>{pathForDisplay(path)}</span>
                              </label>
                            ) : (
                              pathForDisplay(path)
                            )}
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
                        {recoveryStageLabel(event.phase, event.engine)}
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
            候选密码不显示、不记录。
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
    parts.push(
      `累计检查 ${formatCount(event.scannedFileCount)} 个文件（归档识别）`
    )
  }
  return parts.join(" · ")
}
