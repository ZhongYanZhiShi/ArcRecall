import { ArchivePreviewButton } from "./archive-preview"
import { FullText } from "@/components/home/full-text"
import {
  ChevronRight,
  CircleAlert,
  Cpu,
  Eye,
  EyeOff,
  KeyRound,
  ListPlus,
  PackageOpen,
  Settings2,
  Square,
  Upload,
  Zap,
} from "lucide-react"
import * as React from "react"

import { ArchiveStage } from "@/components/redesign/archive-stage"

import { OutputLocationField } from "@/components/home/output-location-field"
import {
  RecoveryCapabilityBadge,
  RecoveryCapabilityNotice,
  resolveRecoveryCapabilityNotice,
} from "@/components/home/recovery-capability"
import { RecoveryTaskResult } from "@/components/home/recovery-task-result"
import {
  archiveNameFromPath,
  formatFileSize,
  pathForDisplay,
  recoveryComputeSummary,
  hasIncompleteRecursiveScan,
} from "@/components/home/recovery-view-utils"
import {
  WorkbenchPage,
  WorkbenchPageContent,
} from "@/components/layout/workbench-page"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
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

type ExtractPageViewProps = {
  diagnostics?: React.ReactNode
  handlePickBatch?: () => void
  handleRepairCopy?: () => void
  repairedCopyPath?: string | null
  queueContent?: React.ReactNode
  workflowTools?: React.ReactNode
  queueMemorySettings?: React.ReactNode
  dictionarySettings?: React.ReactNode
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
  cancelling: boolean
  handleCopyPassword: () => Promise<void>
  onOpenDirectory: (path: string) => void
  onRescan?: () => void
  onRetryArchives?: (paths: string[]) => void
  onOpenOutput: () => void
  onOpenEngineSettings: () => void
}

export function ExtractPageView({
  handlePickBatch,
  handleRepairCopy,
  repairedCopyPath,
  queueContent,
  workflowTools,
  queueMemorySettings,
  diagnostics,
  dictionarySettings,
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
  cancelling,
  handleCopyPassword,
  onOpenOutput,
  onOpenDirectory,
  onRescan,
  onRetryArchives,
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

  const PreflightContainer = task ? "details" : "div"
  const collapseRestart = Boolean(
    task?.completed && task.phase !== "exhausted" && task.phase !== "failed"
  )
  const PasswordContainer = collapseRestart ? "details" : "div"

  return (
    <WorkbenchPage
      data-workbench="extract"
      data-task-active={Boolean(task)}
      data-task-completed={Boolean(task?.completed)}
    >
      <WorkbenchPageContent className="overflow-y-auto pb-4">
        <div
          className="byte-extract-stage"
          data-has-archive={Boolean(analysis || analyzingPath || task)}
        >
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
                ? "flex shrink-0 flex-row flex-wrap items-center gap-3 px-4 py-3"
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
                  className="byte-archive-heading min-w-0 flex-1"
                >
                  <FullText
                    className="byte-archive-origin"
                    text={
                      task?.archivePath ??
                      analysis?.archivePath ??
                      analyzingPath ??
                      ""
                    }
                  />
                  <h1 className="byte-lead" data-phase={task?.phase}>
                    {task?.phase === "exhausted"
                      ? "需要密码"
                      : task?.success && !task.running
                        ? hasIncompleteRecursiveScan(task)
                          ? "解压完成，仍有待处理项"
                          : "解压完成"
                        : task?.running && task.currentArchivePath
                          ? `第 ${task.recursiveDepth + 1} 层 · ${archiveNameFromPath(task.currentArchivePath)}`
                          : (analyzingName ??
                            analysis?.fileName ??
                            (task
                              ? archiveNameFromPath(task.archivePath)
                              : ""))}
                  </h1>
                  <CardDescription className="mt-0.5 truncate text-xs leading-relaxed">
                    {analyzingName
                      ? "正在识别格式…"
                      : analysis
                        ? `${analysis.formatLabel} · ${formatFileSize(analysis.fileSize)}`
                        : null}
                  </CardDescription>
                </div>
                <div
                  hidden={running}
                  className="byte-archive-actions flex basis-full flex-wrap items-center gap-2 sm:basis-auto"
                >
                  <Button
                    size="sm"
                    variant="outline"
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
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handlePickBatch}
                    disabled={busy || running}
                  >
                    <ListPlus data-icon="inline-start" />
                    批量添加
                  </Button>
                </div>
                <div
                  hidden={running}
                  className="byte-archive-help flex basis-full flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2"
                >
                  <p className="text-xs text-muted-foreground">
                    支持多文件拖入或多行路径粘贴
                    <Kbd className="ml-1">Ctrl + V</Kbd>
                  </p>
                  {analysis && (
                    <ArchivePreviewButton
                      key={analysis.archivePath}
                      path={analysis.archivePath}
                      password={knownPassword}
                      disabled={busy || running}
                    />
                  )}
                  {analysis ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy || running}
                      onClick={handleRepairCopy}
                    >
                      生成正确后缀副本
                    </Button>
                  ) : null}
                </div>
              </>
            ) : (
              <>
                <CardHeader
                  aria-live="polite"
                  className="justify-items-start px-0 pt-0 text-left"
                >
                  <div
                    aria-hidden
                    className="flex size-12 items-center justify-center rounded-xl border border-border bg-muted/40"
                  >
                    <PackageOpen className="size-6" strokeWidth={1.75} />
                  </div>
                  <h1 className="byte-lead">
                    {dragOver ? "松开，看看里面有什么。" : "打开压缩包。"}
                  </h1>
                  <CardDescription className="max-w-lg text-xs leading-relaxed text-pretty">
                    支持 7z / ZIP / RAR，可识别错误后缀、无后缀及内嵌归档
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col items-start gap-3 px-0 pt-6 pb-8">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      onClick={handlePickArchive}
                      disabled={busy || running}
                    >
                      <Upload data-icon="inline-start" />
                      选择压缩包
                    </Button>
                    <Button
                      variant="outline"
                      onClick={handlePickBatch}
                      disabled={busy || running}
                    >
                      <ListPlus data-icon="inline-start" />
                      批量添加
                    </Button>
                  </div>
                  <p className="text-center text-xs leading-relaxed text-muted-foreground">
                    支持多文件拖入或多行路径粘贴
                    <Kbd className="ml-1">Ctrl + V</Kbd>
                  </p>
                </CardContent>
              </>
            )}
          </Card>
          {workflowTools && (
            <div className="flex shrink-0 flex-wrap gap-2">{workflowTools}</div>
          )}
          {task?.completed ? (
            <details className="byte-disclosure" key={`layers:${task.taskId}`}>
              <summary>归档层级与处理状态</summary>
              <ArchiveStage analysis={analysis} task={task} />
            </details>
          ) : (
            <ArchiveStage analysis={analysis} task={task} />
          )}
        </div>

        {repairedCopyPath ? (
          <p
            role="status"
            className="mt-2 text-xs break-all text-muted-foreground"
          >
            副本位置：{repairedCopyPath}
          </p>
        ) : null}

        <Sheet open={optionsOpen} onOpenChange={setOptionsOpen}>
          <SheetContent
            side="right"
            className="workbench-details-panel byte-extract-options gap-0 overflow-hidden p-0"
          >
            <SheetHeader className="shrink-0 border-b border-border/80 px-5 py-4 pr-14">
              <SheetTitle>解压选项</SheetTitle>
              <SheetDescription>
                设置输出、扫描方式与任务记忆。
              </SheetDescription>
            </SheetHeader>

            <div
              className="byte-options-scroll min-h-0 flex-1 overflow-y-auto"
              role="region"
              aria-label="解压选项设置"
              tabIndex={0}
            >
              <section
                className="byte-options-group"
                aria-labelledby="extract-output-heading"
              >
                <h3 id="extract-output-heading">输出与完成</h3>
                <OutputLocationField
                  className="byte-options-output"
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

                <Field
                  orientation="horizontal"
                  className="min-w-0 rounded-xl border border-border/70 bg-muted/20 p-3"
                >
                  <FieldContent className="min-w-0">
                    <FieldLabel
                      htmlFor="extract-open-when-done"
                      className="text-xs"
                    >
                      完成后打开输出文件夹
                    </FieldLabel>
                  </FieldContent>
                  <Switch
                    id="extract-open-when-done"
                    size="sm"
                    checked={openWhenDone}
                    onCheckedChange={setOpenWhenDone}
                  />
                </Field>
              </section>
              <section
                className="byte-options-group"
                aria-labelledby="extract-scan-heading"
              >
                <h3 id="extract-scan-heading">嵌套归档</h3>
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
              </section>

              <section className="byte-options-group" aria-label="解密方式">
                <FieldSet className="gap-3">
                  <FieldLegend variant="label" className="mb-0">
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
                        .filter(
                          (method) => method.available || !method.optional
                        )
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
                    showAction={false}
                    capabilities={capabilities}
                    computeMode={computeMode}
                    error={capabilityError}
                    onOpenEngineSettings={onOpenEngineSettings}
                  />
                </FieldSet>
              </section>
              <section className="byte-options-group">
                <h3>候选字典范围</h3>
                {dictionarySettings}
              </section>
              {queueMemorySettings ? (
                <section
                  className="byte-options-group"
                  aria-labelledby="extract-memory-heading"
                >
                  <h3 id="extract-memory-heading">任务记忆</h3>
                  {queueMemorySettings}
                </section>
              ) : null}
            </div>
            {resolveRecoveryCapabilityNotice(
              capabilities,
              computeMode,
              capabilityError
            ) ? (
              <div
                className="shrink-0 border-t bg-background p-4"
                data-slot="extract-options-footer"
              >
                <div className="flex justify-end">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={onOpenEngineSettings}
                  >
                    <Settings2 data-icon="inline-start" />
                    前往解密引擎设置
                  </Button>
                </div>
              </div>
            ) : null}
          </SheetContent>
        </Sheet>

        {analysis ? (
          <section className="byte-recovery-flow mt-3 flex shrink-0 flex-col gap-2 pr-1 pb-1">
            <PasswordContainer
              key={`password:${task?.taskId ?? "new"}:${collapseRestart}`}
              className="byte-password-panel byte-disclosure workbench-panel overflow-hidden rounded-2xl border border-border/80 bg-card"
              data-waiting={task?.phase === "exhausted"}
            >
              {collapseRestart ? (
                <summary>重新解压 / 修改密码与策略</summary>
              ) : null}
              <PreflightContainer className="byte-preflight">
                {task ? <summary>输出与恢复策略</summary> : null}
                <TaskPreflight
                  outputPath={outputSummaryLabel}
                  outputMode={outputMode}
                  computeMode={computeMode}
                  recursive={recursive}
                />
              </PreflightContainer>
              <div className="space-y-3 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <FieldLabel htmlFor="known-password" className="text-xs">
                    已知密码（可选）
                  </FieldLabel>
                  <Badge variant="secondary" className="font-normal">
                    {dictionaryCount == null
                      ? "自动回退"
                      : `${dictionaryCount} 条候选`}
                  </Badge>
                </div>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <InputGroup className="min-w-0 flex-1">
                    <InputGroupInput
                      id="known-password"
                      type={showKnownPassword ? "text" : "password"}
                      value={knownPassword}
                      onChange={(event) => setKnownPassword(event.target.value)}
                      placeholder="输入已知密码"
                      disabled={busy || running}
                      autoComplete="off"
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
                    <Button
                      variant="outline"
                      onClick={handleCancel}
                      disabled={cancelling}
                      aria-busy={cancelling}
                    >
                      <Square data-icon="inline-start" />
                      {cancelling ? "正在停止…" : "取消"}
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
                      开始恢复并解压
                    </Button>
                  )}
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  优先尝试此密码；留空使用历史密码和字典。
                </p>
              </div>
            </PasswordContainer>

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
                onOpenDirectory={onOpenDirectory}
                onRescan={onRescan}
                onRetryArchives={onRetryArchives}
                onOpenOptions={() => setOptionsOpen(true)}
                onOpenEngineSettings={onOpenEngineSettings}
              />
            ) : null}
          </section>
        ) : null}

        {task && !analysis ? (
          <section className="byte-recovery-flow mt-3 flex shrink-0 flex-col gap-2 pr-1 pb-1">
            <Alert className="shrink-0" hidden={task.completed}>
              <PackageOpen />
              <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {task.taskId === reattachedTaskId
                    ? "已恢复任务："
                    : "当前文件："}
                  {archiveNameFromPath(task.archivePath)}
                </span>
                {task.running ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={handleCancel}
                    disabled={cancelling}
                    aria-busy={cancelling}
                  >
                    <Square data-icon="inline-start" />
                    {cancelling ? "正在停止…" : "取消任务"}
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
              onOpenDirectory={onOpenDirectory}
              onRescan={onRescan}
              onRetryArchives={onRetryArchives}
              onOpenOptions={() => setOptionsOpen(true)}
              onOpenEngineSettings={onOpenEngineSettings}
            />
          </section>
        ) : null}

        <button
          type="button"
          onClick={() => setOptionsOpen(true)}
          aria-label="打开解压选项"
          aria-describedby="extract-options-summary"
          className="workbench-panel mt-3 flex min-w-0 shrink-0 items-center gap-2 rounded-2xl border border-border/80 bg-card px-3 py-2.5 text-left transition-colors hover:bg-muted/30 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none"
        >
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="byte-option-item">
                {computeMode === "cpuOnly" ? (
                  <Cpu className="size-3" />
                ) : (
                  <Zap className="size-3" />
                )}
                {computeModeLabel}
              </span>
              <span
                className={cn(
                  "byte-option-item",
                  outputMode === "custom" && !outputDir && "text-warning"
                )}
                title={outputSummaryLabel}
              >
                <span className="truncate">{outputChipLabel}</span>
              </span>
              <span className="byte-option-item">
                {recursive ? "递归扫描" : "仅主归档"}
              </span>
              {openWhenDone ? (
                <span className="byte-option-item">完成后打开</span>
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

        {queueContent}

        {diagnostics && <div className="mt-3">{diagnostics}</div>}
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
    outputMode === "sibling" ? "新建序号目录，不覆盖" : "自动改名，不覆盖"
  const computePolicy =
    computeMode === "cpuOnly" ? "仅使用 CPU" : "GPU 优先，不可用时使用 CPU"

  return (
    <div
      id="recovery-start-summary"
      aria-label="任务启动摘要"
      className="divide-y divide-border/60 border-b border-border/70 bg-muted/20"
    >
      <div className="min-w-0 px-4 py-3">
        <p className="text-xs font-medium text-muted-foreground">输出位置</p>
        <FullText text={outputPath} className="mt-1 text-sm text-foreground" />
      </div>
      <div className="grid divide-y divide-border/60 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <PreflightItem label="同名处理" value={collisionPolicy} />
        <PreflightItem label="计算方式" value={computePolicy} />
        <PreflightItem
          label="任务控制"
          value={`${recursive ? "最多扫描 5 层" : "仅主归档"} · 可取消，请保持应用开启`}
        />
      </div>
    </div>
  )
}

function PreflightItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 px-4 py-3">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-xs break-words text-foreground" title={value}>
        {value}
      </p>
    </div>
  )
}
