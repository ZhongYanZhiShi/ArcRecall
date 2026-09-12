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
import type {
  ArchiveAnalysis,
  RecoveryCapabilities,
  RecoveryComputeMode,
  RecoveryTaskStatus,
} from "@/lib/recovery"
import { cn } from "@/lib/utils"

export type OutputMode = "sibling" | "custom"

const EMPTY_RECOVERY_STEPS = [
  "内容识别",
  "密码复验",
  "候选尝试",
  "安全解包",
  "递归扫描",
]

type ExtractPageViewProps = {
  handlePickBatch?: () => void
  handleRepairCopy?: () => void
  repairMessage?: string | null
  queueContent?: React.ReactNode
  outputMode: OutputMode
  setOutputMode: React.Dispatch<React.SetStateAction<OutputMode>>
  outputDir: string | null
  setOutputDir: React.Dispatch<React.SetStateAction<string | null>>
  openWhenDone: boolean
  setOpenWhenDone: React.Dispatch<React.SetStateAction<boolean>>
  recursive: boolean
  setRecursive: React.Dispatch<React.SetStateAction<boolean>>
  computeMode: RecoveryComputeMode
  computeModeBusy: boolean
  capabilities: RecoveryCapabilities | null
  capabilityError: string | null
  dragOver: boolean
  setDragOver: React.Dispatch<React.SetStateAction<boolean>>
  optionsOpen: boolean
  setOptionsOpen: React.Dispatch<React.SetStateAction<boolean>>
  analysis: ArchiveAnalysis | null
  knownPassword: string
  setKnownPassword: React.Dispatch<React.SetStateAction<string>>
  showKnownPassword: boolean
  setShowKnownPassword: React.Dispatch<React.SetStateAction<boolean>>
  showRecoveredPassword: boolean
  setShowRecoveredPassword: React.Dispatch<React.SetStateAction<boolean>>
  passwordCopied: boolean
  task: RecoveryTaskStatus | null
  reattachedTaskId: string | null
  dictionaryCount: number | null
  analyzingPath: string | null
  busy: boolean
  error: string | null
  running: boolean
  taskResultRef: React.RefObject<HTMLDivElement | null>
  handlePickArchive: () => Promise<void>
  handlePickOutputDir: () => Promise<void>
  handleComputeModeChange: (mode: RecoveryComputeMode) => Promise<void>
  handleStart: () => Promise<void>
  handleCancel: () => Promise<void>
  handleCopyPassword: () => Promise<void>
  onOpenOutput: () => void
  onOpenEngineSettings: () => void
}

export function ExtractPageView({
  handlePickBatch,
  handleRepairCopy,
  repairMessage,
  queueContent,
  outputMode,
  setOutputMode,
  outputDir,
  setOutputDir,
  openWhenDone,
  setOpenWhenDone,
  recursive,
  setRecursive,
  computeMode,
  computeModeBusy,
  capabilities,
  capabilityError,
  dragOver,
  setDragOver,
  optionsOpen,
  setOptionsOpen,
  analysis,
  knownPassword,
  setKnownPassword,
  showKnownPassword,
  setShowKnownPassword,
  showRecoveredPassword,
  setShowRecoveredPassword,
  passwordCopied,
  task,
  reattachedTaskId,
  dictionaryCount,
  analyzingPath,
  busy,
  error,
  running,
  taskResultRef,
  handlePickArchive,
  handlePickOutputDir,
  handleComputeModeChange,
  handleStart,
  handleCancel,
  handleCopyPassword,
  onOpenOutput,
  onOpenEngineSettings,
}: ExtractPageViewProps) {
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
      <WorkbenchPageContent className="overflow-y-auto pb-4">
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
            analysis || analyzingPath || task
              ? "flex shrink-0 flex-row items-center gap-3 px-4 py-3"
              : "flex min-h-52 flex-1 flex-col justify-center gap-0 py-0",
            dragOver
              ? "border-primary/70 bg-primary/10"
              : "border-border bg-card dark:border-foreground/20"
          )}
        >
          {analysis || analyzingPath || task ? (
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
                  {analyzingName ??
                    analysis?.fileName ??
                    (task ? archiveNameFromPath(task.archivePath) : "")}
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

        <div className="mt-2 flex shrink-0 flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy || running}
            onClick={handlePickBatch}
          >
            添加批次归档
          </Button>
          {analysis ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy || running}
              onClick={handleRepairCopy}
            >
              生成正确后缀副本
            </Button>
          ) : null}
          <span className="text-xs text-muted-foreground">
            支持多文件拖入或多行路径粘贴
          </span>
        </div>
        {repairMessage ? (
          <p
            role="status"
            className="mt-2 text-xs break-all text-muted-foreground"
          >
            {repairMessage}
          </p>
        ) : null}
        {queueContent}
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
                disabled={busy || running}
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
                  data-disabled={busy || running || undefined}
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
                    disabled={busy || running}
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
                  disabled={busy || running || computeModeBusy}
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
          <section className="mt-3 flex shrink-0 flex-col gap-2 pr-1 pb-1">
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
                    disabled={busy || running}
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
                onOpenOutput={onOpenOutput}
                onOpenOptions={() => setOptionsOpen(true)}
                onOpenEngineSettings={onOpenEngineSettings}
              />
            ) : null}
          </section>
        ) : null}

        {task && !analysis ? (
          <section className="mt-3 flex shrink-0 flex-col gap-2 pr-1 pb-1">
            <Alert variant="warning" className="shrink-0">
              <CircleAlert />
              <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {task.taskId === reattachedTaskId
                    ? "已连接到："
                    : "当前任务："}
                  {archiveNameFromPath(task.archivePath)}
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
              onOpenOutput={onOpenOutput}
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
