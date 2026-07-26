"use client"

import { getCurrentWebview } from "@tauri-apps/api/webview"
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  FolderPlus,
  KeyRound,
  LoaderCircle,
  PackageOpen,
  ShieldCheck,
  Square,
  Upload,
} from "lucide-react"
import * as React from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { countDictionary, isDesktopRuntime } from "@/lib/dictionary"
import {
  analyzeArchive,
  cancelRecovery,
  getRecoveryStatus,
  openOutputDirectory,
  pickArchivePath,
  pickOutputDirectory,
  startRecovery,
  type ArchiveAnalysis,
  type RecoveryPhase,
  type RecoveryTaskStatus,
} from "@/lib/recovery"
import { cn } from "@/lib/utils"

type OutputMode = "sibling" | "custom"

const PHASE_LABELS: Record<RecoveryPhase, string> = {
  preparing: "准备",
  verifying: "复验",
  converting: "转换",
  hashcat: "Hashcat",
  john: "John CPU",
  extracting: "解压",
  completed: "完成",
  cancelled: "已取消",
  failed: "失败",
}

export function ExtractPage() {
  const [outputMode, setOutputMode] = React.useState<OutputMode>("sibling")
  const [outputDir, setOutputDir] = React.useState<string | null>(null)
  const [openWhenDone, setOpenWhenDone] = React.useState(true)
  const [dragOver, setDragOver] = React.useState(false)
  const [analysis, setAnalysis] = React.useState<ArchiveAnalysis | null>(null)
  const [knownPassword, setKnownPassword] = React.useState("")
  const [showPassword, setShowPassword] = React.useState(false)
  const [task, setTask] = React.useState<RecoveryTaskStatus | null>(null)
  const [dictionaryCount, setDictionaryCount] = React.useState<number | null>(
    null
  )
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const openedTasks = React.useRef(new Set<string>())

  const refreshDictionaryCount = React.useCallback(() => {
    void countDictionary()
      .then(setDictionaryCount)
      .catch(() => setDictionaryCount(isDesktopRuntime() ? null : 0))
  }, [])

  React.useEffect(refreshDictionaryCount, [refreshDictionaryCount])

  const selectArchivePath = React.useCallback(async (path: string) => {
    if (!path.trim()) {
      return
    }
    setBusy(true)
    setError(null)
    setTask(null)
    try {
      const next = await analyzeArchive(path.trim().replace(/^"(.*)"$/, "$1"))
      setAnalysis(next)
    } catch (reason) {
      setAnalysis(null)
      setError(toErrorMessage(reason))
    } finally {
      setBusy(false)
    }
  }, [])

  React.useEffect(() => {
    if (!isDesktopRuntime()) {
      return
    }
    let disposed = false
    let unlisten: (() => void) | undefined
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (disposed) {
          return
        }
        if (event.payload.type === "over") {
          setDragOver(true)
        } else if (event.payload.type === "drop") {
          setDragOver(false)
          const [path] = event.payload.paths
          if (path) {
            void selectArchivePath(path)
          }
        } else {
          setDragOver(false)
        }
      })
      .then((stop) => {
        if (disposed) {
          stop()
        } else {
          unlisten = stop
        }
      })
      .catch((reason) => setError(toErrorMessage(reason)))
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [selectArchivePath])

  React.useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      const path = event.clipboardData?.getData("text/plain").trim()
      if (path && isDesktopRuntime()) {
        event.preventDefault()
        void selectArchivePath(path)
      }
    }
    window.addEventListener("paste", handlePaste)
    return () => window.removeEventListener("paste", handlePaste)
  }, [selectArchivePath])

  React.useEffect(() => {
    if (!task?.running) {
      return
    }
    let disposed = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const latest = await getRecoveryStatus(task.taskId)
        if (disposed || !latest) {
          return
        }
        setTask(latest)
        if (latest.running) {
          timeout = setTimeout(poll, 700)
        } else {
          refreshDictionaryCount()
        }
      } catch (reason) {
        if (!disposed) {
          setError(toErrorMessage(reason))
          timeout = setTimeout(poll, 1500)
        }
      }
    }
    timeout = setTimeout(poll, 350)
    return () => {
      disposed = true
      if (timeout) {
        clearTimeout(timeout)
      }
    }
  }, [refreshDictionaryCount, task?.running, task?.taskId])

  React.useEffect(() => {
    if (
      !openWhenDone ||
      !task?.completed ||
      !task.success ||
      openedTasks.current.has(task.taskId)
    ) {
      return
    }
    openedTasks.current.add(task.taskId)
    void openOutputDirectory(task.outputDirectory).catch((reason) =>
      setError(toErrorMessage(reason))
    )
  }, [openWhenDone, task])

  const handlePickArchive = React.useCallback(async () => {
    setError(null)
    try {
      const path = await pickArchivePath()
      if (path) {
        await selectArchivePath(path)
      }
    } catch (reason) {
      setError(toErrorMessage(reason))
    }
  }, [selectArchivePath])

  const handlePickOutputDir = React.useCallback(async () => {
    setError(null)
    try {
      const path = await pickOutputDirectory()
      if (path) {
        setOutputDir(path)
        setOutputMode("custom")
      }
    } catch (reason) {
      setError(toErrorMessage(reason))
    }
  }, [])

  const handleStart = React.useCallback(async () => {
    if (!analysis) {
      return
    }
    if (outputMode === "custom" && !outputDir) {
      setError("请先选择自定义输出目录。")
      return
    }
    setBusy(true)
    setError(null)
    try {
      const started = await startRecovery({
        archivePath: analysis.archivePath,
        outputDirectory:
          outputMode === "custom"
            ? outputDir
            : analysis.suggestedOutputDirectory,
        knownPassword: knownPassword || null,
      })
      setTask(started)
    } catch (reason) {
      setError(toErrorMessage(reason))
    } finally {
      setBusy(false)
    }
  }, [analysis, knownPassword, outputDir, outputMode])

  const handleCancel = React.useCallback(async () => {
    if (!task?.running) {
      return
    }
    try {
      await cancelRecovery(task.taskId)
      setTask((current) =>
        current ? { ...current, message: "正在停止外部引擎…" } : current
      )
    } catch (reason) {
      setError(toErrorMessage(reason))
    }
  }, [task])

  const handleCopyPassword = React.useCallback(async () => {
    if (!task?.recoveredPassword) {
      return
    }
    try {
      await navigator.clipboard.writeText(task.recoveredPassword)
    } catch (reason) {
      setError(toErrorMessage(reason))
    }
  }, [task])

  const running = Boolean(task?.running)

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="mx-auto flex h-full min-h-0 w-full max-w-[760px] flex-col overflow-y-auto px-5 pt-6 pb-4">
        <header className="mb-3 shrink-0 text-center">
          <p className="text-[11px] font-medium tracking-[0.16em] text-muted-foreground uppercase">
            ArcRecall
          </p>
          <h1 className="mt-1 text-lg font-semibold tracking-tight">
            恢复并解压
          </h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            *2john 转换 · Hashcat / John 恢复 · 7-Zip 复验
          </p>
        </header>

        <section
          onDragEnter={(event) => {
            event.preventDefault()
            setDragOver(true)
          }}
          onDragOver={(event) => {
            event.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={(event) => {
            event.preventDefault()
            if (event.currentTarget === event.target) {
              setDragOver(false)
            }
          }}
          onDrop={(event) => {
            event.preventDefault()
            setDragOver(false)
          }}
          className={cn(
            "flex shrink-0 flex-col items-center justify-center rounded-xl border border-dashed px-5 text-center transition-all",
            analysis ? "min-h-32 py-4" : "min-h-56 flex-1 py-6",
            dragOver ? "dropzone-drag" : "border-border bg-muted/35"
          )}
        >
          <div
            aria-hidden
            className={cn(
              "flex items-center justify-center rounded-xl border border-border bg-background transition-all",
              analysis ? "mb-2 size-9" : "mb-3 size-11",
              dragOver &&
                "dropzone-icon-float motion-safe-only border-foreground/25 shadow-sm"
            )}
          >
            {busy ? (
              <LoaderCircle
                className="size-5 animate-spin"
                strokeWidth={1.75}
              />
            ) : (
              <PackageOpen className="size-5" strokeWidth={1.75} />
            )}
          </div>

          <h2 className="max-w-full truncate text-base font-semibold tracking-tight">
            {dragOver
              ? "松开以分析归档"
              : analysis
                ? analysis.fileName
                : "将压缩包拖到这里"}
          </h2>
          <p className="mt-1.5 max-w-lg truncate text-xs text-muted-foreground">
            {analysis
              ? `${analysis.formatLabel} · ${formatFileSize(analysis.fileSize)} · 不依赖扩展名`
              : "支持 7z / ZIP / RAR3 / RAR5，含自解压归档签名识别"}
          </p>

          <Button
            className="mt-4 rounded-lg transition-transform duration-150 active:scale-[0.98]"
            onClick={handlePickArchive}
            disabled={busy || running}
          >
            <Upload data-icon="inline-start" />
            {analysis ? "更换压缩包" : "选择压缩包"}
          </Button>

          {!analysis ? (
            <p className="mt-3 text-[11px] text-muted-foreground">
              也可粘贴绝对路径
              <span className="ml-1 rounded border border-border bg-background px-1 py-0.5 font-mono text-[10px]">
                Ctrl + V
              </span>
            </p>
          ) : null}
        </section>

        <section className="mt-3 shrink-0 rounded-xl border border-border bg-card px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <div
              role="group"
              aria-label="输出位置"
              className="relative grid h-8 shrink-0 grid-cols-2 items-stretch rounded-md border border-border bg-background p-0.5"
            >
              <span
                aria-hidden
                className={cn(
                  "absolute top-0.5 bottom-0.5 left-0.5 w-[calc(50%-2px)] rounded bg-foreground transition-transform duration-200",
                  outputMode === "custom" && "translate-x-full"
                )}
              />
              <SegmentButton
                active={outputMode === "sibling"}
                onClick={() => setOutputMode("sibling")}
                disabled={running}
              >
                目标同级
              </SegmentButton>
              <SegmentButton
                active={outputMode === "custom"}
                onClick={() => setOutputMode("custom")}
                disabled={running}
              >
                自定义目录
              </SegmentButton>
            </div>

            <div className="relative min-h-8 min-w-0 flex-1 overflow-hidden">
              <div
                className={cn(
                  "flex h-8 items-center transition-all duration-200",
                  outputMode === "sibling"
                    ? "translate-x-0 opacity-100"
                    : "pointer-events-none absolute inset-0 -translate-x-2 opacity-0"
                )}
              >
                <p
                  className="truncate text-xs text-muted-foreground"
                  title={analysis?.suggestedOutputDirectory}
                >
                  {analysis?.suggestedOutputDirectory ??
                    "解压到源文件同级同名文件夹"}
                </p>
              </div>
              <div
                className={cn(
                  "flex h-8 items-center transition-all duration-200",
                  outputMode === "custom"
                    ? "translate-x-0 opacity-100"
                    : "pointer-events-none absolute inset-0 translate-x-2 opacity-0"
                )}
              >
                <OutputDirPicker
                  path={outputDir}
                  onPick={handlePickOutputDir}
                  disabled={running}
                />
              </div>
            </div>

            <label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs">
              <span
                className={cn(
                  "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border transition-colors",
                  openWhenDone
                    ? "border-foreground bg-foreground"
                    : "border-border bg-muted"
                )}
              >
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={openWhenDone}
                  onChange={(event) => setOpenWhenDone(event.target.checked)}
                />
                <span
                  className={cn(
                    "absolute size-2.5 rounded-full transition-all duration-200",
                    openWhenDone
                      ? "right-0.5 bg-background"
                      : "left-0.5 bg-muted-foreground/50"
                  )}
                />
              </span>
              <span className="whitespace-nowrap">完成后打开</span>
            </label>
          </div>
        </section>

        {analysis ? (
          <section className="mt-3 shrink-0 space-y-2">
            <div className="grid gap-2 sm:grid-cols-2">
              <StatusCard
                title="归档分析"
                body={`${analysis.formatLabel} · ${analysis.fileName}`}
                hint="签名已识别"
                icon={<ShieldCheck className="size-3.5" />}
              />
              <StatusCard
                title="全局字典"
                body={
                  dictionaryCount == null
                    ? "候选数量未知"
                    : `${dictionaryCount} 条候选密码`
                }
                hint="成功项优先"
                icon={<KeyRound className="size-3.5" />}
              />
            </div>

            <div className="rounded-xl border border-border bg-card p-3">
              <label
                htmlFor="known-password"
                className="mb-1.5 block text-xs font-medium"
              >
                已知密码（可选）
              </label>
              <div className="flex gap-2">
                <div className="relative min-w-0 flex-1">
                  <Input
                    id="known-password"
                    type={showPassword ? "text" : "password"}
                    value={knownPassword}
                    onChange={(event) => setKnownPassword(event.target.value)}
                    placeholder="先复验此密码；错误时自动进入字典恢复"
                    disabled={running}
                    className="pr-9"
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((value) => !value)}
                    className="absolute inset-y-0 right-0 inline-flex w-9 items-center justify-center text-muted-foreground hover:text-foreground"
                    aria-label={showPassword ? "隐藏密码" : "显示密码"}
                  >
                    {showPassword ? (
                      <EyeOff className="size-4" />
                    ) : (
                      <Eye className="size-4" />
                    )}
                  </button>
                </div>
                {running ? (
                  <Button variant="outline" onClick={handleCancel}>
                    <Square data-icon="inline-start" />
                    取消
                  </Button>
                ) : (
                  <Button onClick={handleStart} disabled={busy}>
                    {busy ? (
                      <LoaderCircle
                        className="animate-spin"
                        data-icon="inline-start"
                      />
                    ) : (
                      <KeyRound data-icon="inline-start" />
                    )}
                    恢复并解压
                  </Button>
                )}
              </div>
            </div>

            {task ? (
              <TaskResult
                task={task}
                showPassword={showPassword}
                onTogglePassword={() => setShowPassword((value) => !value)}
                onCopyPassword={handleCopyPassword}
                onOpenOutput={() =>
                  void openOutputDirectory(task.outputDirectory).catch(
                    (reason) => setError(toErrorMessage(reason))
                  )
                }
              />
            ) : null}
          </section>
        ) : null}

        {error ? (
          <p
            role="alert"
            className="mt-2 shrink-0 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
          >
            {error}
          </p>
        ) : null}
      </div>
    </div>
  )
}

function TaskResult({
  task,
  showPassword,
  onTogglePassword,
  onCopyPassword,
  onOpenOutput,
}: {
  task: RecoveryTaskStatus
  showPassword: boolean
  onTogglePassword: () => void
  onCopyPassword: () => void
  onOpenOutput: () => void
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border bg-card",
        task.success
          ? "border-emerald-500/35"
          : task.phase === "failed"
            ? "border-destructive/35"
            : "border-border"
      )}
    >
      {task.running ? (
        <div className="h-0.5 w-full overflow-hidden bg-muted">
          <div className="h-full w-1/3 animate-pulse bg-foreground" />
        </div>
      ) : null}
      <div className="flex items-start justify-between gap-3 p-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {task.running ? (
              <LoaderCircle className="size-4 shrink-0 animate-spin" />
            ) : task.success ? (
              <Check className="size-4 shrink-0 text-emerald-600" />
            ) : null}
            <p className="text-xs font-semibold">
              {PHASE_LABELS[task.phase]}
              {task.engine ? ` · ${task.engine}` : ""}
            </p>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {task.message}
          </p>
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
                aria-label="复制恢复密码"
              >
                <Copy className="size-3.5" />
              </Button>
            </div>
          ) : null}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          disabled={!task.success}
          onClick={onOpenOutput}
        >
          <PackageOpen data-icon="inline-start" />
          打开输出
        </Button>
      </div>
    </div>
  )
}

function SegmentButton({
  active,
  onClick,
  disabled,
  children,
}: {
  active: boolean
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "relative z-10 inline-flex h-full min-h-0 items-center justify-center rounded px-2.5 text-xs leading-none font-semibold transition-colors duration-200 outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-60",
        active
          ? "text-background"
          : "text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </button>
  )
}

function OutputDirPicker({
  path,
  onPick,
  disabled,
}: {
  path: string | null
  onPick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={disabled}
      aria-label={path ? `输出目录：${path}，点击重新选择` : "选择输出目录"}
      title={path ?? "选择输出目录"}
      className="group flex h-8 min-w-0 flex-1 items-stretch overflow-hidden rounded-md border border-border bg-background text-left transition-colors outline-none hover:bg-muted/35 focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span
        className={cn(
          "flex min-w-0 flex-1 items-center px-2.5 text-xs leading-none",
          path ? "text-foreground" : "text-muted-foreground"
        )}
      >
        <span className="truncate">{path ?? "尚未选择输出目录"}</span>
      </span>
      <span className="inline-flex shrink-0 items-center gap-1 border-l border-border bg-muted/40 px-2 text-xs font-medium transition-colors group-hover:bg-muted/70">
        <FolderPlus className="size-3.5 shrink-0" strokeWidth={1.9} />
        <span className="max-[420px]:sr-only">选择</span>
      </span>
    </button>
  )
}

function StatusCard({
  title,
  body,
  hint,
  icon,
}: {
  title: string
  body: string
  hint: string
  icon: React.ReactNode
}) {
  return (
    <div className="rounded-xl border border-border bg-card px-3 py-2 transition-colors">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          {icon}
          {title}
        </p>
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          {hint}
        </span>
      </div>
      <p className="mt-1 truncate text-xs text-foreground" title={body}>
        {body}
      </p>
    </div>
  )
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[index]}`
}

function toErrorMessage(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.message
  }
  return String(reason)
}
