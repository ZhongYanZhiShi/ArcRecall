"use client"

import { getCurrentWebview } from "@tauri-apps/api/webview"
import {
  ChevronRight,
  CircleAlert,
  Cpu,
  Eye,
  EyeOff,
  KeyRound,
  PackageOpen,
  Settings2,
  ShieldCheck,
  Square,
  Upload,
  Zap,
} from "lucide-react"
import * as React from "react"

import { OutputLocationField } from "@/components/home/output-location-field"
import {
  RecoveryCapabilityBadge,
  RecoveryCapabilityNotice,
} from "@/components/home/recovery-capability"
import { RecoveryTaskResult } from "@/components/home/recovery-task-result"
import {
  archiveNameFromPath,
  formatFileSize,
  pathForDisplay,
  recoveryComputeSummary,
} from "@/components/home/recovery-view-utils"
import {
  WorkbenchPage,
  WorkbenchPageContent,
  WorkbenchPageHeader,
} from "@/components/layout/workbench-page"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Kbd } from "@/components/ui/kbd"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
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
  type RecoveryTaskStatus,
} from "@/lib/recovery"
import { resolveDroppedArchivePath } from "@/lib/recovery-input"
import { recoveryTaskAttachmentId } from "@/lib/recovery-task-attachment"
import { copySensitiveText } from "@/lib/sensitive-clipboard"
import { getSettings, setSettings } from "@/lib/settings"
import { cn } from "@/lib/utils"

type OutputMode = "sibling" | "custom"

const EMPTY_RECOVERY_STEPS = [
  "内容识别",
  "密码复验",
  "候选尝试",
  "安全解包",
  "递归扫描",
]

export function ExtractPage({
  onOpenEngineSettings,
}: {
  onOpenEngineSettings: () => void
}) {
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
  const [optionsOpen, setOptionsOpen] = React.useState(false)
  const [analysis, setAnalysis] = React.useState<ArchiveAnalysis | null>(null)
  const [knownPassword, setKnownPassword] = React.useState("")
  const [showKnownPassword, setShowKnownPassword] = React.useState(false)
  const [showRecoveredPassword, setShowRecoveredPassword] =
    React.useState(false)
  const [passwordCopied, setPasswordCopied] = React.useState(false)
  const [task, setTask] = React.useState<RecoveryTaskStatus | null>(null)
  const [reattachedTaskId, setReattachedTaskId] = React.useState<string | null>(
    null
  )
  const [dictionaryCount, setDictionaryCount] = React.useState<number | null>(
    null
  )
  const [analyzingPath, setAnalyzingPath] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const openedTasks = React.useRef(new Set<string>())
  const autoOpenTasks = React.useRef(new Set<string>())
  const analysisRequestId = React.useRef(0)
  const taskResultRef = React.useRef<HTMLDivElement>(null)
  const revealedTaskId = React.useRef<string | null>(null)
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
          setReattachedTaskId(recoveryTaskAttachmentId(latest))
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
    setAnalyzingPath(normalizedPath)
    setBusy(true)
    setError(null)
    setTask(null)
    setReattachedTaskId(null)
    setAnalysis(null)
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
        setAnalyzingPath(null)
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
          const selection = resolveDroppedArchivePath(event.payload.paths)
          if (selection.error) {
            setError(selection.error)
          } else if (selection.path) {
            void selectArchivePath(selection.path)
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
    if (!task?.completed || revealedTaskId.current === task.taskId) {
      return
    }
    revealedTaskId.current = task.taskId
    const frame = requestAnimationFrame(() => {
      const result = taskResultRef.current
      if (!result) {
        return
      }
      result.focus({ preventScroll: true })
      const reduceMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)"
      ).matches
      result.scrollIntoView({
        block: "nearest",
        behavior: reduceMotion ? "auto" : "smooth",
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [task?.completed, task?.taskId])

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
      setOptionsOpen(true)
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
        avoidOutputCollision: outputMode === "sibling",
        recursive,
        computeMode,
      })
      autoOpenTasks.current.add(started.taskId)
      setShowRecoveredPassword(false)
      setPasswordCopied(false)
      setReattachedTaskId(null)
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
      await copySensitiveText(task.recoveredPassword)
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

  const computeModeLabel = computeMode === "cpuOnly" ? "仅 CPU" : "GPU 优先"
  const outputSummaryLabel =
    outputMode === "custom"
      ? outputDir
        ? pathForDisplay(outputDir)
        : "自定义 · 未选择目录"
      : analysis
        ? pathForDisplay(analysis.suggestedOutputDirectory)
        : "目标同级"
  const outputChipLabel =
    outputMode === "custom"
      ? outputDir
        ? "自定义目录"
        : "自定义 · 未选"
      : "目标同级"
  const computeSummary = recoveryComputeSummary(
    task,
    computeMode,
    capabilities,
    computeModeBusy
  )
  const analyzingName = analyzingPath
    ? archiveNameFromPath(analyzingPath)
    : null

  return (
    <WorkbenchPage>
      <WorkbenchPageContent className="pb-4">
        <WorkbenchPageHeader
          title="恢复并解压"
          description="按文件内容识别格式，尝试已知或本机候选密码，并安全解包。"
          size="large"
          className="mb-3"
        />

        <Card
          size="sm"
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
            "relative min-h-0 border-dashed shadow-none transition-[background-color,border-color] duration-200",
            analysis || analyzingPath
              ? "flex shrink-0 flex-row items-center gap-3 px-4 py-3"
              : "flex min-h-52 flex-1 flex-col justify-center gap-0 py-0",
            dragOver
              ? "border-primary/70 bg-primary/10"
              : "border-border bg-card dark:border-foreground/20"
          )}
        >
          {analysis || analyzingPath ? (
            <>
              <div
                aria-hidden
                className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-muted/40"
              >
                {analyzingPath ? (
                  <Spinner className="size-5" />
                ) : (
                  <PackageOpen className="size-5" strokeWidth={1.75} />
                )}
              </div>
              <div
                aria-live="polite"
                aria-busy={Boolean(analyzingPath)}
                className="min-w-0 flex-1"
              >
                <CardTitle className="truncate text-sm font-semibold tracking-tight">
                  {analyzingName ?? analysis?.fileName}
                </CardTitle>
                <CardDescription className="mt-0.5 truncate text-xs leading-relaxed">
                  {analyzingName
                    ? "正在读取文件签名并识别归档格式…"
                    : analysis
                      ? `${analysis.formatLabel} · ${formatFileSize(analysis.fileSize)} · 不依赖扩展名`
                      : null}
                </CardDescription>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="shrink-0"
                onClick={handlePickArchive}
                disabled={busy || running}
              >
                {analyzingPath ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <Upload data-icon="inline-start" />
                )}
                {analyzingPath ? "正在识别" : "更换压缩包"}
              </Button>
            </>
          ) : (
            <>
              <CardHeader
                aria-live="polite"
                className="justify-items-center px-5 pt-8 text-center"
              >
                <div
                  aria-hidden
                  className="flex size-12 items-center justify-center rounded-xl border border-border bg-muted/40"
                >
                  <PackageOpen className="size-6" strokeWidth={1.75} />
                </div>
                <CardTitle className="mt-1 max-w-full truncate text-base font-semibold tracking-tight">
                  {dragOver ? "松开以分析归档" : "将压缩包拖到这里"}
                </CardTitle>
                <CardDescription className="max-w-lg text-xs leading-relaxed text-pretty">
                  按内容识别 7z / ZIP / RAR，支持乱后缀、无后缀与文件内嵌归档
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col items-center gap-3 px-5 pb-8">
                <Button onClick={handlePickArchive} disabled={busy || running}>
                  <Upload data-icon="inline-start" />
                  选择压缩包
                </Button>
                <div className="flex flex-col items-center gap-2 text-xs text-muted-foreground">
                  <p className="inline-flex items-center gap-1.5 text-center leading-relaxed">
                    <ShieldCheck aria-hidden className="size-3.5 shrink-0" />
                    文件与密码仅在本机处理，源文件保持不变
                  </p>
                  <p>
                    也可粘贴绝对路径
                    <Kbd className="ml-1">Ctrl + V</Kbd>
                  </p>
                  <ol
                    aria-label={`恢复流程：${EMPTY_RECOVERY_STEPS.join("、")}`}
                    className="mt-1 flex max-w-2xl flex-wrap items-center justify-center gap-x-1.5 gap-y-1 text-xs"
                  >
                    {EMPTY_RECOVERY_STEPS.map((step, index) => (
                      <li key={step} className="flex items-center gap-1.5">
                        {index > 0 ? (
                          <ChevronRight
                            aria-hidden
                            className="size-3 text-muted-foreground/55"
                          />
                        ) : null}
                        <span
                          className={cn(
                            "whitespace-nowrap",
                            "text-muted-foreground"
                          )}
                        >
                          {step}
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
              </CardContent>
            </>
          )}
        </Card>

        <button
          type="button"
          onClick={() => setOptionsOpen(true)}
          aria-label="打开解压选项"
          aria-describedby="extract-options-summary"
          className="workbench-panel mt-3 flex min-w-0 shrink-0 items-center gap-2 rounded-2xl border border-border/80 bg-card px-3 py-2.5 text-left transition-colors hover:bg-muted/30 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none"
        >
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <Badge variant="secondary" className="font-normal">
                {computeMode === "cpuOnly" ? (
                  <Cpu className="size-3" />
                ) : (
                  <Zap className="size-3" />
                )}
                {computeModeLabel}
              </Badge>
              <Badge
                variant={
                  outputMode === "custom" && !outputDir
                    ? "outline"
                    : "secondary"
                }
                className="max-w-full font-normal"
                title={outputSummaryLabel}
              >
                <span className="truncate">{outputChipLabel}</span>
              </Badge>
              <Badge variant="secondary" className="font-normal">
                {recursive ? "递归扫描" : "仅主归档"}
              </Badge>
              {openWhenDone ? (
                <Badge variant="outline" className="font-normal">
                  完成后打开
                </Badge>
              ) : null}
            </div>
            <p
              id="extract-options-summary"
              className="truncate text-xs text-muted-foreground"
              title={computeSummary}
            >
              {computeSummary}
            </p>
          </div>
          <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground">
            选项
            <ChevronRight className="size-3.5" />
          </span>
        </button>

        <Sheet open={optionsOpen} onOpenChange={setOptionsOpen}>
          <SheetContent side="right" className="gap-0 p-0">
            <SheetHeader className="shrink-0 border-b border-border/80 px-5 py-4 pr-14">
              <SheetTitle>解压选项</SheetTitle>
              <SheetDescription className="text-xs leading-relaxed">
                输出位置、完成行为与解密方式。关闭后设置仍然保留。
              </SheetDescription>
            </SheetHeader>

            <div className="flex min-h-0 flex-1 scroll-fade flex-col gap-4 overflow-y-auto px-5 py-4">
              <OutputLocationField
                mode={outputMode}
                onModeChange={setOutputMode}
                siblingLabel="目标同级"
                path={
                  outputMode === "custom"
                    ? outputDir
                      ? pathForDisplay(outputDir)
                      : null
                    : analysis
                      ? pathForDisplay(analysis.suggestedOutputDirectory)
                      : null
                }
                pathTitle={
                  outputMode === "custom"
                    ? outputDir
                    : analysis?.suggestedOutputDirectory
                }
                emptyLabel={
                  outputMode === "custom"
                    ? "尚未选择输出目录"
                    : "解压到源文件同级同名文件夹"
                }
                onPick={handlePickOutputDir}
                onClear={() => setOutputDir(null)}
                disabled={running}
              />

              <div className="grid gap-3">
                <Field
                  orientation="horizontal"
                  className="min-w-0 rounded-xl border border-border/70 bg-muted/20 p-3"
                >
                  <FieldContent className="min-w-0">
                    <FieldLabel
                      htmlFor="extract-open-when-done"
                      className="text-xs"
                    >
                      完成后打开
                    </FieldLabel>
                    <FieldDescription className="text-xs">
                      自动打开输出文件夹
                    </FieldDescription>
                  </FieldContent>
                  <Switch
                    id="extract-open-when-done"
                    size="sm"
                    checked={openWhenDone}
                    onCheckedChange={setOpenWhenDone}
                  />
                </Field>
                <Field
                  orientation="horizontal"
                  data-disabled={running || undefined}
                  className="min-w-0 rounded-xl border border-border/70 bg-muted/20 p-3"
                >
                  <FieldContent className="min-w-0">
                    <FieldLabel htmlFor="extract-recursive" className="text-xs">
                      递归解密
                    </FieldLabel>
                    <FieldDescription className="text-xs">
                      最多 5 层、100 个归档
                    </FieldDescription>
                  </FieldContent>
                  <Switch
                    id="extract-recursive"
                    size="sm"
                    checked={recursive}
                    disabled={running}
                    onCheckedChange={setRecursive}
                  />
                </Field>
              </div>

              <FieldSet className="gap-2">
                <FieldLegend variant="label" className="mb-0 text-xs">
                  解密方式
                </FieldLegend>
                <ToggleGroup
                  aria-label="解密算力"
                  variant="outline"
                  size="sm"
                  spacing={0}
                  value={[computeMode]}
                  disabled={running || computeModeBusy}
                  onValueChange={(values) => {
                    const next = values[0] as RecoveryComputeMode | undefined
                    if (next) {
                      void handleComputeModeChange(next)
                    }
                  }}
                  className="w-full"
                >
                  <ToggleGroupItem
                    value="gpuPreferred"
                    className="flex-1 text-xs"
                  >
                    <Zap data-icon="inline-start" />
                    GPU 优先
                  </ToggleGroupItem>
                  <ToggleGroupItem value="cpuOnly" className="flex-1 text-xs">
                    <Cpu data-icon="inline-start" />
                    仅 CPU
                  </ToggleGroupItem>
                </ToggleGroup>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {computeSummary}
                </p>
                <div className="flex flex-wrap items-center gap-1.5">
                  {capabilities ? (
                    capabilities.methods
                      .filter((method) => method.available || !method.optional)
                      .map((method) => (
                        <RecoveryCapabilityBadge
                          key={method.id}
                          method={method}
                        />
                      ))
                  ) : capabilityError ? null : (
                    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Spinner className="size-3" />
                      正在探测计算设备与引擎…
                    </span>
                  )}
                </div>
                <RecoveryCapabilityNotice
                  capabilities={capabilities}
                  computeMode={computeMode}
                  error={capabilityError}
                  onOpenEngineSettings={onOpenEngineSettings}
                />
              </FieldSet>
            </div>
          </SheetContent>
        </Sheet>

        {analysis ? (
          <section className="mt-3 flex min-h-0 flex-1 scroll-fade flex-col gap-2 overflow-y-auto pr-1 pb-1">
            <div className="workbench-panel rounded-2xl border border-border/80 bg-card p-3">
              <div className="mb-1 flex items-center justify-between gap-2">
                <FieldLabel htmlFor="known-password" className="text-xs">
                  已知密码（可选）
                </FieldLabel>
                <Badge variant="secondary" className="font-normal">
                  {dictionaryCount == null
                    ? "自动回退"
                    : `${dictionaryCount} 条候选`}
                </Badge>
              </div>
              <RecoveryRoute recursive={recursive} />
              <TaskPreflight
                outputPath={outputSummaryLabel}
                outputMode={outputMode}
                computeMode={computeMode}
                recursive={recursive}
              />
              <div className="flex gap-2">
                <InputGroup className="min-w-0 flex-1">
                  <InputGroupInput
                    id="known-password"
                    type={showKnownPassword ? "text" : "password"}
                    value={knownPassword}
                    onChange={(event) => setKnownPassword(event.target.value)}
                    placeholder="输入后优先复验；留空则后台查找历史密码"
                    disabled={running}
                    autoComplete="off"
                    aria-describedby="recovery-route"
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton
                      size="icon-xs"
                      onClick={() => setShowKnownPassword((value) => !value)}
                      aria-label={showKnownPassword ? "隐藏密码" : "显示密码"}
                    >
                      {showKnownPassword ? <EyeOff /> : <Eye />}
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
                {running ? (
                  <Button variant="outline" onClick={handleCancel}>
                    <Square data-icon="inline-start" />
                    取消
                  </Button>
                ) : (
                  <Button
                    onClick={handleStart}
                    disabled={busy}
                    aria-describedby="recovery-start-summary"
                  >
                    {busy ? (
                      <Spinner data-icon="inline-start" />
                    ) : (
                      <KeyRound data-icon="inline-start" />
                    )}
                    开始恢复尝试
                  </Button>
                )}
              </div>
            </div>

            {task ? (
              <RecoveryTaskResult
                rootRef={taskResultRef}
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
                onOpenOptions={() => setOptionsOpen(true)}
                onOpenEngineSettings={onOpenEngineSettings}
              />
            ) : null}
          </section>
        ) : null}

        {task && task.taskId === reattachedTaskId && !analysis ? (
          <section className="mt-3 flex min-h-0 flex-1 scroll-fade flex-col gap-2 overflow-y-auto pr-1 pb-1">
            <Alert variant="warning" className="shrink-0">
              <CircleAlert />
              <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  已重新连接到“{archiveNameFromPath(task.archivePath)}
                  ”的恢复任务。
                </span>
                {task.running ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={handleCancel}
                  >
                    <Square data-icon="inline-start" />
                    取消任务
                  </Button>
                ) : null}
              </AlertDescription>
            </Alert>
            <RecoveryTaskResult
              rootRef={taskResultRef}
              task={task}
              showPassword={showRecoveredPassword}
              passwordCopied={passwordCopied}
              onTogglePassword={() =>
                setShowRecoveredPassword((value) => !value)
              }
              onCopyPassword={handleCopyPassword}
              onOpenOutput={() =>
                void openOutputDirectory(task.outputDirectory).catch((reason) =>
                  setError(toErrorMessage(reason))
                )
              }
              onOpenOptions={() => setOptionsOpen(true)}
              onOpenEngineSettings={onOpenEngineSettings}
            />
          </section>
        ) : null}

        {error ? (
          <Alert variant="destructive" className="mt-2 shrink-0">
            <CircleAlert />
            <AlertDescription>
              <p>{error}</p>
              {analysis ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() => setOptionsOpen(true)}
                  >
                    <Settings2 data-icon="inline-start" />
                    检查解压选项
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={onOpenEngineSettings}
                  >
                    检查解密引擎
                  </Button>
                </div>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}
      </WorkbenchPageContent>
    </WorkbenchPage>
  )
}

function RecoveryRoute({ recursive }: { recursive: boolean }) {
  const steps = [
    "识别内容",
    "校验已知密码",
    "尝试本机候选",
    "安全解包",
    ...(recursive ? ["扫描嵌套归档"] : []),
  ]

  return (
    <div id="recovery-route" className="mb-2">
      <p className="mb-1.5 text-xs font-medium text-muted-foreground">
        本次处理路径
      </p>
      <ol
        aria-label={`本次处理路径：${steps.join("、")}`}
        className="flex flex-wrap items-center gap-x-1 gap-y-1.5"
      >
        {steps.map((step, index) => (
          <li key={step} className="flex items-center gap-1">
            <span className="inline-flex items-center gap-1 rounded-lg bg-muted/60 px-2 py-1 text-xs text-foreground">
              <span className="flex size-5 items-center justify-center rounded-full bg-background text-xs font-semibold tabular-nums">
                {index + 1}
              </span>
              {step}
            </span>
            {index < steps.length - 1 ? (
              <ChevronRight
                aria-hidden
                className="size-3 text-muted-foreground/70"
              />
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  )
}

function TaskPreflight({
  outputPath,
  outputMode,
  computeMode,
  recursive,
}: {
  outputPath: string
  outputMode: OutputMode
  computeMode: RecoveryComputeMode
  recursive: boolean
}) {
  const collisionPolicy =
    outputMode === "sibling"
      ? "已有目录时自动使用新的序号目录"
      : "同名文件自动改名，不覆盖已有文件"
  const computePolicy =
    computeMode === "cpuOnly"
      ? "仅使用 CPU"
      : "可用时使用 GPU，否则自动回退 CPU"

  return (
    <div
      id="recovery-start-summary"
      aria-label="任务启动摘要"
      className="mb-2 grid gap-px overflow-hidden rounded-xl border border-border/70 bg-border sm:grid-cols-2 lg:grid-cols-4"
    >
      <PreflightItem label="输出位置" value={outputPath} />
      <PreflightItem label="同名处理" value={collisionPolicy} />
      <PreflightItem label="计算方式" value={computePolicy} />
      <PreflightItem
        label="任务控制"
        value={`${recursive ? "最多扫描 5 层嵌套归档" : "不扫描嵌套归档"} · 可随时取消 · 运行期间请保持应用开启`}
      />
    </div>
  )
}

function PreflightItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 bg-card px-3 py-2">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-0.5 truncate text-xs text-foreground" title={value}>
        {value}
      </p>
    </div>
  )
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

function toErrorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message.trim()) {
    return reason.message
  }
  if (typeof reason === "string" && reason.trim()) {
    return reason
  }
  return "操作未完成。请检查所选文件和应用设置后重试。"
}
