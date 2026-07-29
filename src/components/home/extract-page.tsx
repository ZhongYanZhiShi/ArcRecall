"use client"

import { getCurrentWebview } from "@tauri-apps/api/webview"
import {
  Check,
  ChevronRight,
  CircleAlert,
  Copy,
  Cpu,
  Eye,
  EyeOff,
  FolderPlus,
  KeyRound,
  ListTree,
  LoaderCircle,
  PackageOpen,
  ShieldCheck,
  Square,
  Upload,
  Zap,
} from "lucide-react"
import * as React from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { countDictionary, isDesktopRuntime } from "@/lib/dictionary"
import {
  analyzeArchive,
  cancelRecovery,
  getRecoveryCapabilities,
  getRecoveryStatus,
  openOutputDirectory,
  pickArchivePath,
  pickOutputDirectory,
  startRecovery,
  type ArchiveAnalysis,
  type RecoveryCapabilities,
  type RecoveryComputeMode,
  type RecoveryPhase,
  type RecoveryTaskEvent,
  type RecoveryTaskStatus,
} from "@/lib/recovery"
import { getSettings, setSettings } from "@/lib/settings"
import { cn } from "@/lib/utils"

type OutputMode = "sibling" | "custom"

const PHASE_LABELS: Record<RecoveryPhase, string> = {
  preparing: "准备",
  verifying: "复验",
  converting: "转换",
  hashcat: "Hashcat",
  john: "John CPU",
  internal: "7-Zip CPU",
  extracting: "解压",
  recursive: "递归解密",
  completed: "完成",
  exhausted: "未找到密码",
  cancelled: "已取消",
  failed: "失败",
}

const COUNT_FORMATTER = new Intl.NumberFormat("zh-CN")

export function ExtractPage() {
  const [outputMode, setOutputMode] = React.useState<OutputMode>("sibling")
  const [outputDir, setOutputDir] = React.useState<string | null>(null)
  const [openWhenDone, setOpenWhenDone] = React.useState(true)
  const [recursive, setRecursive] = React.useState(true)
  const [computeMode, setComputeMode] =
    React.useState<RecoveryComputeMode>("gpuPreferred")
  const [computeModeBusy, setComputeModeBusy] = React.useState(false)
  const [capabilities, setCapabilities] =
    React.useState<RecoveryCapabilities | null>(null)
  const [capabilityError, setCapabilityError] = React.useState<string | null>(
    null
  )
  const [dragOver, setDragOver] = React.useState(false)
  const [analysis, setAnalysis] = React.useState<ArchiveAnalysis | null>(null)
  const [knownPassword, setKnownPassword] = React.useState("")
  const [showKnownPassword, setShowKnownPassword] = React.useState(false)
  const [showRecoveredPassword, setShowRecoveredPassword] =
    React.useState(false)
  const [passwordCopied, setPasswordCopied] = React.useState(false)
  const [task, setTask] = React.useState<RecoveryTaskStatus | null>(null)
  const [dictionaryCount, setDictionaryCount] = React.useState<number | null>(
    null
  )
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const openedTasks = React.useRef(new Set<string>())
  const autoOpenTasks = React.useRef(new Set<string>())
  const analysisRequestId = React.useRef(0)
  const running = Boolean(task?.running)
  const runningRef = React.useRef(running)

  React.useEffect(() => {
    runningRef.current = running
  }, [running])

  const refreshDictionaryCount = React.useCallback(() => {
    void countDictionary()
      .then(setDictionaryCount)
      .catch(() => setDictionaryCount(isDesktopRuntime() ? null : 0))
  }, [])

  React.useEffect(refreshDictionaryCount, [refreshDictionaryCount])

  React.useEffect(() => {
    let disposed = false
    void getSettings()
      .then((settings) => {
        if (!disposed) {
          setComputeMode(settings.recovery?.computeMode ?? "gpuPreferred")
        }
      })
      .catch(() => undefined)
    void getRecoveryCapabilities()
      .then((next) => {
        if (!disposed) {
          setCapabilities(next)
          setCapabilityError(null)
        }
      })
      .catch((reason) => {
        if (!disposed) {
          setCapabilityError(toErrorMessage(reason))
        }
      })
    return () => {
      disposed = true
    }
  }, [])

  React.useEffect(() => {
    if (!isDesktopRuntime()) {
      return
    }
    let disposed = false
    void getRecoveryStatus()
      .then((latest) => {
        if (!disposed && latest) {
          setTask((current) => current ?? latest)
          setComputeMode(latest.computeMode ?? "gpuPreferred")
        }
      })
      .catch((reason) => {
        if (!disposed) {
          setError(toErrorMessage(reason))
        }
      })
    return () => {
      disposed = true
    }
  }, [])

  const selectArchivePath = React.useCallback(async (path: string) => {
    const normalizedPath = normalizeArchivePath(path)
    if (!normalizedPath) {
      return
    }
    if (runningRef.current) {
      setError("当前恢复任务仍在运行，请先取消或等待任务完成。")
      return
    }
    const requestId = ++analysisRequestId.current
    setBusy(true)
    setError(null)
    setTask(null)
    setKnownPassword("")
    setShowKnownPassword(false)
    setShowRecoveredPassword(false)
    setPasswordCopied(false)
    try {
      const next = await analyzeArchive(normalizedPath)
      if (requestId !== analysisRequestId.current) {
        return
      }
      setAnalysis(next)
    } catch (reason) {
      if (requestId !== analysisRequestId.current) {
        return
      }
      setAnalysis(null)
      setError(toErrorMessage(reason))
    } finally {
      if (requestId === analysisRequestId.current) {
        setBusy(false)
      }
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
        if (runningRef.current) {
          setDragOver(false)
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
      if (isEditablePasteTarget(event.target)) {
        return
      }
      const path = normalizeArchivePath(
        event.clipboardData?.getData("text/plain") ?? ""
      )
      if (path && looksLikeAbsolutePath(path) && isDesktopRuntime()) {
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
      !autoOpenTasks.current.has(task.taskId) ||
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
        fingerprintSha256: analysis.fingerprintSha256,
        outputDirectory:
          outputMode === "custom"
            ? outputDir
            : analysis.suggestedOutputDirectory,
        knownPassword: knownPassword || null,
        avoidOutputCollision: outputMode === "sibling",
        recursive,
        computeMode,
      })
      autoOpenTasks.current.add(started.taskId)
      setShowRecoveredPassword(false)
      setPasswordCopied(false)
      setTask(started)
    } catch (reason) {
      setError(toErrorMessage(reason))
    } finally {
      setBusy(false)
    }
  }, [analysis, computeMode, knownPassword, outputDir, outputMode, recursive])

  const handleComputeModeChange = React.useCallback(
    async (nextMode: RecoveryComputeMode) => {
      if (running || computeModeBusy || nextMode === computeMode) {
        return
      }
      const previousMode = computeMode
      setComputeMode(nextMode)
      setComputeModeBusy(true)
      setError(null)
      try {
        const current = await getSettings()
        const saved = await setSettings({
          ...current,
          recovery: { computeMode: nextMode },
        })
        setComputeMode(saved.recovery?.computeMode ?? nextMode)
      } catch (reason) {
        setComputeMode(previousMode)
        setError(`无法保存解密方式：${toErrorMessage(reason)}`)
      } finally {
        setComputeModeBusy(false)
      }
    },
    [computeMode, computeModeBusy, running]
  )

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
      setPasswordCopied(true)
    } catch (reason) {
      setError(toErrorMessage(reason))
    }
  }, [task])

  React.useEffect(() => {
    if (!passwordCopied) {
      return
    }
    const timeout = setTimeout(() => setPasswordCopied(false), 1600)
    return () => clearTimeout(timeout)
  }, [passwordCopied])

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
            "flex shrink-0 flex-col items-center justify-center rounded-2xl border border-dashed px-5 text-center transition-all",
            analysis ? "min-h-32 py-4" : "min-h-56 flex-1 py-6",
            dragOver ? "dropzone-drag" : "workbench-dropzone border-border"
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
              : "按内容识别 7z / ZIP / RAR3 / RAR5，支持乱后缀、无后缀与复合载体"}
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

        <section className="workbench-panel mt-3 shrink-0 rounded-2xl border border-border/80 bg-card px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <div
              role="group"
              aria-label="输出位置"
              className="relative grid h-8 shrink-0 grid-cols-2 items-stretch rounded-md border border-border bg-background p-0.5"
            >
              <span
                aria-hidden
                className={cn(
                  "absolute top-0.5 bottom-0.5 left-0.5 w-[calc(50%-2px)] rounded bg-primary transition-transform duration-200",
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
                  title={
                    analysis
                      ? pathForDisplay(analysis.suggestedOutputDirectory)
                      : undefined
                  }
                >
                  {analysis
                    ? pathForDisplay(analysis.suggestedOutputDirectory)
                    : "解压到源文件同级同名文件夹"}
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
                    ? "border-primary bg-primary"
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
          <div className="mt-2 flex items-center justify-between gap-3 border-t border-border/70 pt-2">
            <label
              className={cn(
                "flex min-w-0 items-center gap-2 text-xs",
                running
                  ? "cursor-not-allowed text-muted-foreground"
                  : "cursor-pointer"
              )}
            >
              <span
                className={cn(
                  "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border transition-colors",
                  recursive
                    ? "border-primary bg-primary"
                    : "border-border bg-muted"
                )}
              >
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={recursive}
                  disabled={running}
                  onChange={(event) => setRecursive(event.target.checked)}
                />
                <span
                  className={cn(
                    "absolute size-2.5 rounded-full transition-all duration-200",
                    recursive
                      ? "right-0.5 bg-background"
                      : "left-0.5 bg-muted-foreground/50"
                  )}
                />
              </span>
              <span className="truncate">递归解密嵌套压缩包</span>
            </label>
            <span className="shrink-0 text-[10px] text-muted-foreground">
              最多 5 层 · 100 个
            </span>
          </div>
          <div className="mt-2 border-t border-border/70 pt-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="shrink-0 text-xs font-medium">解密方式</span>
              <div
                role="group"
                aria-label="解密算力"
                className="relative grid h-8 shrink-0 grid-cols-2 items-stretch rounded-md border border-border bg-background p-0.5"
              >
                <span
                  aria-hidden
                  className={cn(
                    "absolute top-0.5 bottom-0.5 left-0.5 w-[calc(50%-2px)] rounded bg-primary transition-transform duration-200",
                    computeMode === "cpuOnly" && "translate-x-full"
                  )}
                />
                <SegmentButton
                  active={computeMode === "gpuPreferred"}
                  onClick={() => void handleComputeModeChange("gpuPreferred")}
                  disabled={running || computeModeBusy}
                >
                  <Zap className="size-3" />
                  GPU 优先
                </SegmentButton>
                <SegmentButton
                  active={computeMode === "cpuOnly"}
                  onClick={() => void handleComputeModeChange("cpuOnly")}
                  disabled={running || computeModeBusy}
                >
                  <Cpu className="size-3" />
                  仅 CPU
                </SegmentButton>
              </div>
              <span className="min-w-48 flex-1 text-[11px] text-muted-foreground">
                {recoveryComputeSummary(
                  task,
                  computeMode,
                  capabilities,
                  computeModeBusy
                )}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="mr-0.5 text-[10px] text-muted-foreground">
                当前支持
              </span>
              {capabilities?.methods.map((method, index) => (
                <span
                  key={method.id}
                  title={method.message}
                  style={{ animationDelay: `${Math.min(index, 4) * 45}ms` }}
                  className={cn(
                    "animate-status-chip-enter motion-safe-only inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px]",
                    method.available
                      ? "border-foreground/15 bg-foreground/5 text-foreground"
                      : "border-border text-muted-foreground"
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "size-1.5 rounded-full",
                      method.available ? "bg-success" : "bg-muted-foreground/35"
                    )}
                  />
                  {method.label}
                </span>
              )) ?? (
                <span className="text-[10px] text-muted-foreground">
                  {capabilityError
                    ? "能力探测失败，可在设置中重新检测"
                    : "正在探测计算设备与引擎…"}
                </span>
              )}
            </div>
          </div>
        </section>

        {analysis ? (
          <section className="mt-3 shrink-0 space-y-2">
            <div className="grid gap-2 sm:grid-cols-2">
              <StatusCard
                title="归档分析"
                body={`${analysis.formatLabel} · ${analysis.fileName}`}
                hint={
                  analysis.hasSavedPassword
                    ? "历史密码可复用"
                    : analysis.historyMatched
                      ? "历史记录已命中"
                      : "签名已识别"
                }
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

            <div className="workbench-panel rounded-2xl border border-border/80 bg-card p-3">
              <div className="mb-1 flex items-center justify-between gap-2">
                <label
                  htmlFor="known-password"
                  className="block text-xs font-medium"
                >
                  已知密码（可选）
                </label>
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                  自动回退
                </span>
              </div>
              <p
                id="recovery-route"
                className="mb-2 text-[11px] leading-relaxed text-muted-foreground"
              >
                免密检查 → 手动 / 历史密码 → Hashcat / John → 7-Zip CPU 兼容兜底
                → 安全解压{recursive ? " → 递归扫描" : ""}
              </p>
              {analysis.hasSavedPassword ? (
                <p className="mb-2 rounded-lg bg-muted/60 px-2.5 py-1.5 text-[11px] text-foreground">
                  已命中本机历史密码；留空时会优先自动复验，不会在任务开始前显示明文。
                </p>
              ) : analysis.historyMatched ? (
                <p className="mb-2 rounded-lg bg-muted/60 px-2.5 py-1.5 text-[11px] text-muted-foreground">
                  已找到相同内容的成功记录，但该记录没有保存密码。
                </p>
              ) : null}
              <div className="flex gap-2">
                <div className="relative min-w-0 flex-1">
                  <Input
                    id="known-password"
                    type={showKnownPassword ? "text" : "password"}
                    value={knownPassword}
                    onChange={(event) => setKnownPassword(event.target.value)}
                    placeholder="输入后优先复验；留空则尝试历史密码"
                    disabled={running}
                    className="pr-9"
                    autoComplete="off"
                    aria-describedby="recovery-route"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKnownPassword((value) => !value)}
                    className="absolute inset-y-0 right-0 inline-flex w-9 items-center justify-center text-muted-foreground hover:text-foreground"
                    aria-label={showKnownPassword ? "隐藏密码" : "显示密码"}
                  >
                    {showKnownPassword ? (
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
                    开始智能恢复
                  </Button>
                )}
              </div>
            </div>

            {task ? (
              <TaskResult
                task={task}
                showPassword={showRecoveredPassword}
                passwordCopied={passwordCopied}
                onTogglePassword={() =>
                  setShowRecoveredPassword((value) => !value)
                }
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
  passwordCopied,
  onTogglePassword,
  onCopyPassword,
  onOpenOutput,
}: {
  task: RecoveryTaskStatus
  showPassword: boolean
  passwordCopied: boolean
  onTogglePassword: () => void
  onCopyPassword: () => void
  onOpenOutput: () => void
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
      : PHASE_LABELS[task.phase]

  return (
    <div
      className={cn(
        "workbench-panel animate-task-card-enter motion-safe-only overflow-hidden rounded-2xl border bg-card",
        task.success
          ? "border-success/35"
          : task.phase === "failed"
            ? "border-destructive/35"
            : task.phase === "exhausted"
              ? "border-warning/40"
              : "border-border"
      )}
    >
      {task.running ? (
        <div
          className="h-0.5 w-full overflow-hidden bg-muted"
          role="progressbar"
          aria-label="恢复进度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
        >
          <div
            className="progress-live motion-safe-only h-full transition-[width] duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
      ) : null}
      <div className="flex items-start justify-between gap-3 p-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {task.running ? (
              <LoaderCircle className="size-4 shrink-0 animate-spin" />
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
            <p className="mt-1 text-[11px] text-success-foreground">
              主归档已完成，当前仅处理递归发现的嵌套归档。
            </p>
          ) : null}
          {hasCandidateProgress || task.elapsedMs > 0 ? (
            <p className="mt-1 text-[11px] text-muted-foreground tabular-nums">
              {hasCandidateProgress
                ? `已尝试 ${formatCount(task.attemptedCount)} / ${formatCount(task.candidateCount)} 条候选 · `
                : ""}
              用时 {elapsedLabel}
            </p>
          ) : null}
          {hasRecursiveProgress ? (
            <div className="mt-1 space-y-0.5 text-[11px] text-muted-foreground">
              <p className="tabular-nums">
                已扫描 {formatCount(task.scannedFileCount)} 个文件 · 嵌套归档：
                发现 {formatCount(task.nestedArchiveCount)} · 已解开{" "}
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
              {task.depthLimitReached || task.countLimitReached ? (
                <p className="text-warning-foreground">
                  已达到递归安全限制，剩余嵌套归档未继续处理。
                </p>
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
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          disabled={!task.success && !task.rootExtractionCompleted}
          onClick={onOpenOutput}
        >
          <PackageOpen data-icon="inline-start" />
          打开输出
        </Button>
      </div>
    </div>
  )
}

function RecoveryProcessDetails({ task }: { task: RecoveryTaskStatus }) {
  const [open, setOpen] = React.useState(false)
  const events = task.events ?? []

  if (events.length === 0) {
    return null
  }

  const latest = events[0]!

  return (
    <>
      <div className="mt-2 flex min-w-0 items-center gap-2 rounded-lg border border-border/70 bg-muted/20 px-2.5 py-1.5">
        <ListTree className="size-3.5 shrink-0 text-muted-foreground" />
        <p className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
          最近：{PHASE_LABELS[latest.phase]}
          {latest.engine ? ` · ${latest.engine}` : ""} ·{" "}
          {formatCompactElapsed(latest.elapsedMs)}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 rounded-md px-2 text-[11px]"
          onClick={() => setOpen(true)}
        >
          详细过程
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] tabular-nums">
            {events.length}
          </span>
          <ChevronRight className="size-3.5" />
        </Button>
      </div>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          className="data-[side=right]:w-full data-[side=right]:max-w-none data-[side=right]:sm:max-w-[520px]"
        >
          <SheetHeader className="shrink-0 border-b border-border/80 px-5 py-4 pr-14">
            <div className="flex flex-wrap items-center gap-2">
              <SheetTitle>解密详细过程</SheetTitle>
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-[10px] font-medium",
                  task.running
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground"
                )}
              >
                {task.running ? "实时更新" : PHASE_LABELS[task.phase]}
              </span>
            </div>
            <SheetDescription className="text-xs leading-relaxed">
              最新事件置顶，共 {events.length} 条；关闭抽屉不会中断恢复任务。
            </SheetDescription>
            <div className="flex flex-wrap gap-1.5 pt-1">
              <span className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">
                计划：
                {task.computeMode === "cpuOnly" ? "仅 CPU" : "GPU 优先"}
              </span>
              <span className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">
                当前：{task.engine || "7-Zip CPU 基础校验"}
              </span>
              <span className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground tabular-nums">
                用时：{formatElapsed(task.elapsedMs)}
              </span>
            </div>
          </SheetHeader>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-2">
            <ol aria-label="解密事件时间线">
              {events.map((event, index) => {
                const current = task.running && index === 0
                const metadata = recoveryEventMetadata(event)
                return (
                  <li
                    key={event.sequence}
                    className="relative grid grid-cols-[50px_18px_minmax(0,1fr)] gap-2 py-3 before:absolute before:top-8 before:bottom-0 before:left-[60px] before:w-px before:bg-border last:before:hidden"
                  >
                    <time className="pt-0.5 text-[10px] text-muted-foreground tabular-nums">
                      {formatCompactElapsed(event.elapsedMs)}
                    </time>
                    <span className="relative z-10 flex justify-center pt-0.5">
                      {current ? (
                        <span className="flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
                          <LoaderCircle className="size-2.5 animate-spin" />
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
                        {PHASE_LABELS[event.phase]}
                        {event.engine ? ` · ${event.engine}` : ""}
                        {event.archivePath
                          ? ` · ${archiveNameFromPath(event.archivePath)}`
                          : ""}
                      </p>
                      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                        {event.message}
                      </p>
                      {metadata ? (
                        <p className="mt-1 text-[10px] text-muted-foreground tabular-nums">
                          {metadata}
                        </p>
                      ) : null}
                    </div>
                  </li>
                )
              })}
            </ol>
          </div>

          <p className="shrink-0 border-t border-border/80 px-5 py-3 text-[10px] text-muted-foreground">
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

function recoveryComputeSummary(
  task: RecoveryTaskStatus | null,
  mode: RecoveryComputeMode,
  capabilities: RecoveryCapabilities | null,
  saving: boolean
): string {
  if (saving) {
    return "正在保存默认解密方式…"
  }
  if (task?.running) {
    if (task.rootExtractionCompleted) {
      return `主归档已解压，正在递归检查：${task.engine || "7-Zip"}`
    }
    return `当前正在使用：${task.engine || "7-Zip CPU 基础校验"}`
  }
  if (task?.completed) {
    return `本次实际使用：${task.engine || "7-Zip CPU"}`
  }
  if (mode === "cpuOnly") {
    return "准备仅使用 CPU，不会调用 GPU"
  }
  if (capabilities && !capabilities.gpuAvailable) {
    return "未检测到可用 GPU，任务会自动使用 CPU"
  }
  return "准备优先使用 GPU，失败时自动回退 CPU"
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
        "relative z-10 inline-flex h-full min-h-0 items-center justify-center gap-1 rounded px-2.5 text-xs leading-none font-semibold transition-colors duration-200 outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-60",
        active
          ? "text-primary-foreground"
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
  const displayPath = path ? pathForDisplay(path) : null
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={disabled}
      aria-label={
        displayPath ? `输出目录：${displayPath}，点击重新选择` : "选择输出目录"
      }
      title={displayPath ?? "选择输出目录"}
      className="group flex h-8 min-w-0 flex-1 items-stretch overflow-hidden rounded-md border border-border bg-background text-left transition-colors outline-none hover:bg-muted/35 focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span
        className={cn(
          "flex min-w-0 flex-1 items-center px-2.5 text-xs leading-none",
          displayPath ? "text-foreground" : "text-muted-foreground"
        )}
      >
        <span className="truncate">{displayPath ?? "尚未选择输出目录"}</span>
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
    <div className="workbench-panel rounded-2xl border border-border/80 bg-card px-3 py-2 transition-colors">
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

function resolveTaskProgress(task: RecoveryTaskStatus): number {
  if (task.completed) {
    return 100
  }
  if (task.recursiveDepth > 0) {
    if (
      task.phase === "internal" &&
      task.candidateCount > 0 &&
      task.attemptedCount > 0
    ) {
      const candidateRatio = Math.min(
        1,
        task.attemptedCount / task.candidateCount
      )
      return Math.round(94 + candidateRatio * 4)
    }
    return 94
  }
  if (
    task.phase === "internal" &&
    task.candidateCount > 0 &&
    task.attemptedCount > 0
  ) {
    const candidateRatio = Math.min(
      1,
      task.attemptedCount / task.candidateCount
    )
    return Math.round(68 + candidateRatio * 20)
  }
  const phaseProgress: Record<RecoveryPhase, number> = {
    preparing: 6,
    verifying: 16,
    converting: 30,
    hashcat: 48,
    john: 62,
    internal: 68,
    extracting: 92,
    recursive: 94,
    completed: 100,
    exhausted: 100,
    cancelled: 100,
    failed: 100,
  }
  return phaseProgress[task.phase]
}

function formatCount(value: number): string {
  return COUNT_FORMATTER.format(value)
}

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return [hours, minutes, seconds]
    .map((value) => value.toString().padStart(2, "0"))
    .join(":")
}

function formatCompactElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes.toString().padStart(2, "0")}:${seconds
    .toString()
    .padStart(2, "0")}`
}

function normalizeArchivePath(value: string): string {
  return value.trim().replace(/^"(.*)"$/, "$1")
}

function looksLikeAbsolutePath(value: string): boolean {
  return /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(value)
}

function isEditablePasteTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false
  }
  return Boolean(
    target.closest(
      'input, textarea, [role="textbox"], [contenteditable=""], [contenteditable="true"]'
    )
  )
}

function archiveNameFromPath(path: string): string {
  const displayPath = pathForDisplay(path)
  return displayPath.split(/[\\/]/).filter(Boolean).at(-1) ?? displayPath
}

function pathForDisplay(path: string): string {
  if (path.startsWith("\\\\?\\UNC\\")) {
    return `\\\\${path.slice(8)}`
  }
  return path.startsWith("\\\\?\\") ? path.slice(4) : path
}

function toErrorMessage(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.message
  }
  return String(reason)
}
