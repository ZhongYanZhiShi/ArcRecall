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
  KeyRound,
  ListTree,
  PackageOpen,
  Settings2,
  ShieldCheck,
  Square,
  Upload,
  Zap,
} from "lucide-react"
import * as React from "react"

import { OutputLocationField } from "@/components/home/output-location-field"
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
  const [optionsOpen, setOptionsOpen] = React.useState(false)
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
      setOptionsOpen(true)
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

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="workbench-page flex h-full min-h-0 scroll-fade flex-col overflow-y-auto px-5 pt-6 pb-4">
        <header className="mb-5 shrink-0">
          <p className="text-[11px] font-medium tracking-[0.18em] text-muted-foreground uppercase">
            ArcRecall
          </p>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">
            恢复并解压
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            选择压缩包后自动识别格式、恢复密码并安全解压。
          </p>
        </header>

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
            "relative flex min-h-0 flex-col justify-center gap-0 border-dashed py-0 shadow-none",
            analysis ? "min-h-36 shrink-0" : "min-h-52 flex-1",
            dragOver ? "border-foreground/40 bg-muted/50" : "bg-card"
          )}
        >
          <div className="absolute top-2.5 right-2.5 z-10">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="解压选项"
              title="解压选项"
              onClick={() => setOptionsOpen(true)}
            >
              <Settings2 />
            </Button>
          </div>
          <CardHeader
            className={cn(
              "justify-items-center px-5 text-center",
              analysis ? "pt-5" : "pt-8"
            )}
          >
            <div
              aria-hidden
              className={cn(
                "flex items-center justify-center rounded-xl border border-border bg-muted/40",
                analysis ? "size-9" : "size-12"
              )}
            >
              {busy ? (
                <Spinner className="size-5" />
              ) : (
                <PackageOpen
                  className={analysis ? "size-5" : "size-6"}
                  strokeWidth={1.75}
                />
              )}
            </div>
            <CardTitle className="mt-1 max-w-full truncate text-base font-semibold tracking-tight">
              {dragOver
                ? "松开以分析归档"
                : analysis
                  ? analysis.fileName
                  : "将压缩包拖到这里"}
            </CardTitle>
            <CardDescription className="max-w-lg truncate text-xs">
              {analysis
                ? `${analysis.formatLabel} · ${formatFileSize(analysis.fileSize)} · 不依赖扩展名`
                : "按内容识别 7z / ZIP / RAR，支持乱后缀、无后缀与复合载体"}
            </CardDescription>
          </CardHeader>
          <CardContent
            className={cn(
              "flex flex-col items-center gap-3 px-5",
              analysis ? "pb-5" : "pb-8"
            )}
          >
            <Button onClick={handlePickArchive} disabled={busy || running}>
              <Upload data-icon="inline-start" />
              {analysis ? "更换压缩包" : "选择压缩包"}
            </Button>
            {!analysis ? (
              <p className="text-[11px] text-muted-foreground">
                也可粘贴绝对路径
                <Kbd className="ml-1">Ctrl + V</Kbd>
              </p>
            ) : null}
          </CardContent>
        </Card>

        <button
          type="button"
          onClick={() => setOptionsOpen(true)}
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
                {recursive ? "递归开" : "递归关"}
              </Badge>
              {openWhenDone ? (
                <Badge variant="outline" className="font-normal">
                  完成后打开
                </Badge>
              ) : null}
            </div>
            <p
              className="truncate text-[11px] text-muted-foreground"
              title={computeSummary}
            >
              {computeSummary}
            </p>
          </div>
          <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-muted-foreground">
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
                    <FieldDescription className="text-[10px]">
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
                    <FieldDescription className="text-[10px]">
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
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {computeSummary}
                </p>
                <div className="flex flex-wrap items-center gap-1.5">
                  {capabilities?.methods.map((method) => (
                    <Badge
                      key={method.id}
                      title={method.message}
                      variant={method.available ? "secondary" : "outline"}
                      className="font-normal"
                    >
                      <span
                        aria-hidden
                        className={cn(
                          "size-1.5 rounded-full",
                          method.available
                            ? "bg-success"
                            : "bg-muted-foreground/35"
                        )}
                      />
                      {method.label}
                    </Badge>
                  )) ?? (
                    <span className="text-[10px] text-muted-foreground">
                      {capabilityError
                        ? "能力探测失败，可在应用设置中重新检测"
                        : "正在探测计算设备与引擎…"}
                    </span>
                  )}
                </div>
              </FieldSet>
            </div>
          </SheetContent>
        </Sheet>

        {analysis ? (
          <section className="mt-3 flex shrink-0 flex-col gap-2">
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
                <FieldLabel htmlFor="known-password" className="text-xs">
                  已知密码（可选）
                </FieldLabel>
                <Badge variant="secondary" className="font-normal">
                  自动回退
                </Badge>
              </div>
              <p
                id="recovery-route"
                className="mb-2 text-[11px] leading-relaxed text-muted-foreground"
              >
                免密检查 → 手动 / 历史密码 → Hashcat / John → 7-Zip CPU 兼容兜底
                → 安全解压{recursive ? " → 递归扫描" : ""}
              </p>
              {analysis.hasSavedPassword ? (
                <Alert className="mb-2 py-2 text-[11px]">
                  <ShieldCheck />
                  <AlertDescription className="text-[11px]">
                    已命中本机历史密码；留空时会优先自动复验，不会在任务开始前显示明文。
                  </AlertDescription>
                </Alert>
              ) : analysis.historyMatched ? (
                <Alert className="mb-2 py-2 text-[11px]">
                  <CircleAlert />
                  <AlertDescription className="text-[11px]">
                    已找到相同内容的成功记录，但该记录没有保存密码。
                  </AlertDescription>
                </Alert>
              ) : null}
              <div className="flex gap-2">
                <InputGroup className="min-w-0 flex-1">
                  <InputGroupInput
                    id="known-password"
                    type={showKnownPassword ? "text" : "password"}
                    value={knownPassword}
                    onChange={(event) => setKnownPassword(event.target.value)}
                    placeholder="输入后优先复验；留空则尝试历史密码"
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
                  <Button onClick={handleStart} disabled={busy}>
                    {busy ? (
                      <Spinner data-icon="inline-start" />
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
          <Alert variant="destructive" className="mt-2 shrink-0">
            <CircleAlert />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
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
        <Progress
          value={progress}
          aria-label="恢复进度"
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
            <div className="mt-1 flex flex-col gap-0.5 text-[11px] text-muted-foreground">
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
                {task.running ? "实时更新" : PHASE_LABELS[task.phase]}
              </Badge>
            </div>
            <SheetDescription className="text-xs leading-relaxed">
              最新事件置顶，共 {events.length} 条；关闭抽屉不会中断恢复任务。
            </SheetDescription>
            <div className="flex flex-wrap gap-1.5 pt-1">
              <Badge variant="outline" className="font-normal">
                计划：
                {task.computeMode === "cpuOnly" ? "仅 CPU" : "GPU 优先"}
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
          </ScrollArea>

          <Separator />
          <p className="shrink-0 px-5 py-3 text-[10px] text-muted-foreground">
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
    <Card size="sm" className="gap-0 py-0">
      <CardHeader className="flex-row items-center justify-between gap-2 px-3 pt-2 pb-0">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          {icon}
          {title}
        </p>
        <Badge variant="secondary" className="font-normal">
          {hint}
        </Badge>
      </CardHeader>
      <CardContent className="px-3 pt-1 pb-2">
        <p className="truncate text-xs text-foreground" title={body}>
          {body}
        </p>
      </CardContent>
    </Card>
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
