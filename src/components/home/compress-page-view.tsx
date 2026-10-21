import { FullText } from "@/components/home/full-text"
import { WorkbenchDetails, WorkbenchDetailsActions } from "./workbench-details"
import {
  Archive,
  ArrowDown,
  ArrowUp,
  CircleAlert,
  Check,
  Eye,
  EyeOff,
  FileArchive,
  FilePlus2,
  FolderPlus,
  KeyRound,
  PackagePlus,
  Plus,
  Settings2,
  Square,
  Trash2,
  WandSparkles,
  X,
} from "lucide-react"
import * as React from "react"

import { CompressionTaskCard } from "@/components/home/compression-task-card"
import { CompressionReferencePreview } from "@/components/home/compression-reference-preview"
import { OutputLocationField } from "@/components/home/output-location-field"
import {
  WorkbenchPage,
  WorkbenchPageContent,
  WorkbenchPageHeader,
} from "@/components/layout/workbench-page"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { AiProfile } from "@/lib/ai"
import type {
  CompressionFormat,
  CompressionTaskStatus,
} from "@/lib/compression"
import {
  AI_REFERENCE_EXTENSION_OPTIONS,
  parseAiReferenceExtensions,
  type CompressionDraft,
} from "@/lib/compression-draft"
import {
  compressionSourceFileName,
  compressionSourceIdentity,
  compressionSourceParent,
} from "@/lib/compression-path"
import { cn } from "@/lib/utils"
import type { CompressionNamingPreferencesController } from "@/hooks/use-compression-naming-preferences"
import type { AiReferencePreviewController } from "@/hooks/use-ai-reference-preview"

type CompressionLevel = 0 | 1 | 3 | 5 | 7 | 9

const LEVELS: {
  value: CompressionLevel
  label: string
  description: string
}[] = [
  { value: 0, label: "仅打包", description: "不压缩" },
  { value: 1, label: "极速", description: "速度优先" },
  { value: 3, label: "快速", description: "较低占用" },
  { value: 5, label: "标准", description: "推荐" },
  { value: 7, label: "较高", description: "体积优先" },
  { value: 9, label: "极限", description: "耗时更长" },
]

const LEVEL_OPTIONS = LEVELS.map((item) => ({
  value: String(item.value),
  label: `${item.label} · ${item.description}`,
}))

const COUNT_FORMATTER = new Intl.NumberFormat("zh-CN")

type CompressPageViewProps = {
  referencePreview: AiReferencePreviewController
  referencePreferences: CompressionNamingPreferencesController
  draft: CompressionDraft
  dragOver: boolean
  busy: boolean
  error: string | null
  aiError: string | null
  setAiError: React.Dispatch<React.SetStateAction<string | null>>
  activeAiProfile: AiProfile | null
  task: CompressionTaskStatus | null
  running: boolean
  showPassword: boolean
  passwordError: string | null
  setShowPassword: React.Dispatch<React.SetStateAction<boolean>>
  hasPermanentPassword: boolean
  usePermanentPassword: boolean
  setUsePermanentPassword: React.Dispatch<React.SetStateAction<boolean>>
  permanentPasswordReady: boolean
  passwordCredentialBusy: boolean
  deletePasswordOpen: boolean
  setDeletePasswordOpen: React.Dispatch<React.SetStateAction<boolean>>
  updateDraft: <Key extends keyof CompressionDraft>(
    key: Key,
    value: CompressionDraft[Key]
  ) => void
  handlePickFiles: () => void
  handlePickFolder: () => void
  handlePickOutput: () => void
  handleMoveSource: (index: number, direction: -1 | 1) => void
  onRemoveSource: (index: number) => void
  handleStart: (skipAiRename?: boolean) => Promise<void>
  handleCancel: () => Promise<void>
  cancelling: boolean
  handleSavePermanentPassword: () => Promise<void>
  handleDeletePermanentPassword: () => Promise<void>
  onOpenTaskOutput: () => void
  onOpenAiSettings: () => void
}

export function CompressPageView({
  referencePreview,
  referencePreferences,
  draft,
  dragOver,
  busy,
  error,
  aiError,
  setAiError,
  activeAiProfile,
  task,
  running,
  showPassword,
  passwordError,
  setShowPassword,
  hasPermanentPassword,
  usePermanentPassword,
  setUsePermanentPassword,
  permanentPasswordReady,
  passwordCredentialBusy,
  deletePasswordOpen,
  setDeletePasswordOpen,
  updateDraft,
  handlePickFiles,
  handlePickFolder,
  handlePickOutput,
  handleMoveSource,
  onRemoveSource,
  handleStart,
  handleCancel,
  cancelling,
  handleSavePermanentPassword,
  handleDeletePermanentPassword,
  onOpenTaskOutput,
  onOpenAiSettings,
}: CompressPageViewProps) {
  const {
    sources,
    outputMode,
    outputDirectory,
    baseName,
    format,
    level,
    password,
    passwordConfirmation,
    encryptFileNames,
    openWhenDone,
    useAiRename,
    useAiFileReference,
    aiReferenceExtensions,
    aiCustomReferenceExtensions,
  } = draft
  const [customReferenceExtension, setCustomReferenceExtension] =
    React.useState("")
  const [referenceExtensionError, setReferenceExtensionError] = React.useState<
    string | null
  >(null)
  const customReferenceInput = React.useRef<HTMLInputElement>(null)
  const draftLocked = busy || running || passwordCredentialBusy
  const referencePreferencesLocked = draftLocked || !referencePreferences.ready
  const selectedReferenceExtensions = parseAiReferenceExtensions(
    aiReferenceExtensions
  )
  const referenceExtensionOptions = [
    ...new Set([
      ...AI_REFERENCE_EXTENSION_OPTIONS,
      ...aiCustomReferenceExtensions,
      ...selectedReferenceExtensions,
    ]),
  ]
  function addReferenceExtensions() {
    if (referencePreferencesLocked || !customReferenceExtension.trim()) return
    try {
      const additions = parseAiReferenceExtensions(customReferenceExtension)
      if (!additions.length) {
        setReferenceExtensionError("请输入要添加的后缀，例如 rst。")
        return
      }
      const selected = [
        ...new Set([...selectedReferenceExtensions, ...additions]),
      ]
      if (selected.length > 32) {
        setReferenceExtensionError("最多可选择 32 种参考文件后缀。")
        return
      }
      referencePreferences.change(
        selected,
        [...new Set([...aiCustomReferenceExtensions, ...additions])].filter(
          (extension) => !AI_REFERENCE_EXTENSION_OPTIONS.includes(extension)
        )
      )
      setCustomReferenceExtension("")
      setReferenceExtensionError(null)
    } catch (reason) {
      setReferenceExtensionError((reason as Error).message)
    }
  }
  function removeReferenceExtension(suffix: string) {
    if (referencePreferencesLocked) return
    referencePreferences.change(
      selectedReferenceExtensions.filter((extension) => extension !== suffix),
      aiCustomReferenceExtensions.filter((extension) => extension !== suffix)
    )
    setReferenceExtensionError(null)
    customReferenceInput.current?.focus()
  }
  const defaultOutput = sources[0]
    ? compressionSourceParent(sources[0])
    : "首个来源的上级目录"
  const extension = format === "sevenZip" ? ".7z" : ".zip"
  const activeLevel = LEVELS.find((item) => item.value === level)

  const renderSource = (source: string, index: number) => (
    <div
      key={compressionSourceIdentity(source)}
      className="flex min-w-0 items-center gap-2 rounded-xl border border-border/80 bg-background px-2.5 py-2"
    >
      <FileArchive
        aria-hidden
        className="size-4 shrink-0 text-muted-foreground"
      />
      <div className="min-w-0 flex-1">
        <FullText
          text={compressionSourceFileName(source)}
          className="text-xs font-medium"
        />
        <FullText
          text={source}
          className="mt-0.5 text-xs text-muted-foreground"
        />
      </div>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {index + 1}
      </span>
      <SourceAction
        label="上移"
        disabled={draftLocked || index === 0}
        onClick={() => handleMoveSource(index, -1)}
      >
        <ArrowUp />
      </SourceAction>
      <SourceAction
        label="下移"
        disabled={draftLocked || index === sources.length - 1}
        onClick={() => handleMoveSource(index, 1)}
      >
        <ArrowDown />
      </SourceAction>
      <SourceAction
        label="移除"
        disabled={draftLocked}
        onClick={() => onRemoveSource(index)}
      >
        <Trash2 />
      </SourceAction>
    </div>
  )

  return (
    <WorkbenchPage data-workbench="compress">
      <WorkbenchPageContent
        width="wide"
        data-testid="compress-page"
        className="pb-5"
      >
        <WorkbenchPageHeader title="压缩" />
        <div className="byte-compress-stage">
          <Card
            size="sm"
            className={cn(
              "min-h-0 gap-0 py-0 shadow-none",
              dragOver && "border-foreground/40 bg-muted/50"
            )}
            aria-label="压缩来源"
          >
            <CardHeader className="shrink-0 px-4 py-3">
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <CardTitle className="byte-lead">待压缩文件</CardTitle>
                    {sources.length > 0 ? (
                      <Badge variant="secondary">
                        {COUNT_FORMATTER.format(sources.length)} 个
                      </Badge>
                    ) : null}
                  </div>
                  <CardDescription className="mt-0.5 text-xs">
                    {dragOver
                      ? "松开即可加入当前列表"
                      : "可混合添加文件与文件夹"}
                  </CardDescription>
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handlePickFiles}
                    disabled={draftLocked}
                  >
                    <FilePlus2 data-icon="inline-start" />
                    添加文件
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handlePickFolder}
                    disabled={draftLocked}
                  >
                    <FolderPlus data-icon="inline-start" />
                    添加文件夹
                  </Button>
                </div>
              </div>
            </CardHeader>
            <Separator />

            <CardContent className="min-h-0 flex-1 px-0">
              {sources.length > 0 ? (
                <ScrollArea
                  data-testid="compress-source-scroll"
                  className="h-full"
                  aria-label="已选来源，可调整顺序"
                >
                  <ol className="byte-packing-list flex flex-col">
                    {sources.map((source, index) => (
                      <li key={compressionSourceIdentity(source)}>
                        {renderSource(source, index)}
                      </li>
                    ))}
                  </ol>
                </ScrollArea>
              ) : (
                <Empty className="h-full min-h-0 gap-2 rounded-none p-4">
                  <EmptyHeader className="gap-1.5">
                    <EmptyMedia variant="icon">
                      <PackagePlus />
                    </EmptyMedia>
                    <EmptyTitle className="text-sm">
                      {dragOver ? "松开以添加来源" : "拖入文件或文件夹"}
                    </EmptyTitle>
                    <EmptyDescription className="hidden max-w-xs text-xs sm:block">
                      重复来源会自动去重
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </CardContent>
          </Card>

          <Card size="sm" className="@container min-h-0 gap-0 py-0">
            <CardHeader className="shrink-0 px-4 py-3">
              <CardTitle className="text-sm font-semibold">归档设置</CardTitle>
              <CardAction>
                <Badge variant="secondary">
                  {extension} · {activeLevel?.label ?? "标准"}
                </Badge>
              </CardAction>
            </CardHeader>
            <Separator />

            <CardContent className="min-h-0 flex-1 px-0">
              <ScrollArea
                data-testid="compress-settings-scroll"
                className="h-full"
                aria-label="归档设置"
              >
                <div className="byte-compress-settings flex flex-col gap-3 p-4">
                  {error ? (
                    <Alert variant="destructive">
                      <CircleAlert />
                      <AlertDescription>{error}</AlertDescription>
                    </Alert>
                  ) : null}

                  {task ? (
                    <CompressionTaskCard
                      task={task}
                      onOpen={onOpenTaskOutput}
                    />
                  ) : null}

                  <OutputLocationField
                    className="byte-compress-output"
                    mode={outputMode}
                    onModeChange={(mode) => updateDraft("outputMode", mode)}
                    siblingLabel="来源同级"
                    path={
                      outputMode === "custom"
                        ? outputDirectory
                        : sources[0]
                          ? defaultOutput
                          : null
                    }
                    pathTitle={
                      outputMode === "custom"
                        ? outputDirectory
                        : sources[0]
                          ? defaultOutput
                          : null
                    }
                    emptyLabel={
                      outputMode === "custom"
                        ? "尚未选择目录"
                        : "首个来源的上级目录"
                    }
                    onPick={handlePickOutput}
                    onClear={() => updateDraft("outputDirectory", null)}
                    headerAction={
                      <SwitchControl
                        checked={openWhenDone}
                        onCheckedChange={(checked) =>
                          updateDraft("openWhenDone", checked)
                        }
                        label="完成后打开"
                        disabled={draftLocked}
                        title="归档完成后自动打开输出文件夹"
                      />
                    }
                    disabled={draftLocked}
                  />

                  <Separator />

                  <div className="grid gap-3 @min-[30rem]:grid-cols-[minmax(0,1fr)_176px]">
                    <Field className="gap-1.5">
                      <FieldLabel htmlFor="archive-name">
                        归档基础名称
                      </FieldLabel>
                      <InputGroup>
                        <InputGroupInput
                          id="archive-name"
                          value={baseName}
                          onChange={(event) =>
                            updateDraft("baseName", event.target.value)
                          }
                          placeholder="例如：项目交付资料"
                          autoComplete="off"
                          disabled={draftLocked}
                          aria-describedby="archive-name-hint"
                        />
                        <InputGroupAddon align="inline-end">
                          <InputGroupText>{extension}</InputGroupText>
                        </InputGroupAddon>
                      </InputGroup>
                      <FieldDescription
                        id="archive-name-hint"
                        className="text-xs leading-relaxed text-muted-foreground"
                      >
                        无效文件名字符会自动替换。
                      </FieldDescription>
                    </Field>

                    <FieldSet className="gap-1.5">
                      <FieldLegend
                        variant="label"
                        className="mb-1.5 leading-snug"
                      >
                        归档格式
                      </FieldLegend>
                      <ToggleGroup
                        variant="outline"
                        spacing={0}
                        value={[format]}
                        disabled={draftLocked}
                        onValueChange={(values) => {
                          const next = values[0] as
                            | CompressionFormat
                            | undefined
                          if (!next) {
                            return
                          }
                          updateDraft("format", next)
                          if (next === "zip") {
                            updateDraft("encryptFileNames", false)
                          }
                        }}
                        className="w-full"
                      >
                        <ToggleGroupItem
                          value="sevenZip"
                          className="flex-1 text-xs"
                        >
                          7z
                        </ToggleGroupItem>
                        <ToggleGroupItem value="zip" className="flex-1 text-xs">
                          ZIP
                        </ToggleGroupItem>
                      </ToggleGroup>
                      <FieldDescription className="text-xs leading-relaxed">
                        {format === "sevenZip"
                          ? "压缩率更高，支持文件名加密"
                          : "兼容性更好，密码使用 AES-256"}
                      </FieldDescription>
                    </FieldSet>
                  </div>

                  {aiError ? (
                    <p role="alert" className="text-sm text-destructive">
                      {aiError}
                    </p>
                  ) : null}
                  <WorkbenchDetails
                    title="AI 命名选项"
                    label={
                      useAiRename ? "AI 命名 · 已开启" : "AI 命名 · 未开启"
                    }
                    description="选择命名方式，配置文件内容参考与预览。"
                  >
                    <Field
                      orientation="horizontal"
                      data-disabled={draftLocked || undefined}
                      className="items-center rounded-xl border border-border/80 bg-muted/30 p-3"
                    >
                      <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-background text-muted-foreground">
                        <WandSparkles aria-hidden className="size-4" />
                      </div>
                      <FieldContent className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <FieldLabel
                            htmlFor="compress-ai-rename"
                            className="text-xs"
                          >
                            使用 AI 优化名称
                          </FieldLabel>
                          {activeAiProfile ? (
                            <Badge
                              variant="outline"
                              className="max-w-full min-w-0 font-normal"
                            >
                              <FullText
                                text={`${activeAiProfile.name} · ${activeAiProfile.model || "未选择模型"}`}
                              />
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="font-normal">
                              未配置
                            </Badge>
                          )}
                          <WorkbenchDetailsActions>
                            <Button
                              type="button"
                              size="xs"
                              variant="outline"
                              disabled={draftLocked}
                              onClick={onOpenAiSettings}
                              aria-label="配置 AI 模型与重命名提示词"
                            >
                              <Settings2 data-icon="inline-start" />
                              配置
                            </Button>
                          </WorkbenchDetailsActions>
                        </div>
                        <FieldDescription className="text-xs leading-relaxed">
                          根据基础名称和提示词命名，也可开启文件内容参考。
                        </FieldDescription>
                      </FieldContent>
                      <Switch
                        id="compress-ai-rename"
                        size="sm"
                        checked={useAiRename}
                        disabled={referencePreferencesLocked}
                        onCheckedChange={(checked) => {
                          if (referencePreferencesLocked) return
                          referencePreferences.setEnabled(
                            "useAiRename",
                            checked
                          )
                          setAiError(
                            checked && !activeAiProfile
                              ? "尚未配置可用的 AI 模型，请先前往设置。"
                              : null
                          )
                        }}
                      />
                    </Field>

                    {referencePreferences.error ? (
                      <Alert variant="warning">
                        <CircleAlert />
                        <AlertDescription className="flex-1 text-xs">
                          {referencePreferences.error}
                        </AlertDescription>
                        <WorkbenchDetailsActions>
                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            disabled={draftLocked}
                            onClick={referencePreferences.retry}
                          >
                            {referencePreferences.ready
                              ? "重试保存"
                              : "重新读取"}
                          </Button>
                        </WorkbenchDetailsActions>
                      </Alert>
                    ) : !referencePreferences.ready ? (
                      <p
                        role="status"
                        className="text-xs text-muted-foreground"
                      >
                        正在读取 AI 命名设置…
                      </p>
                    ) : null}

                    {useAiRename ? (
                      <div className="grid gap-3 rounded-xl border border-border/80 p-3">
                        <Field
                          orientation="horizontal"
                          className="items-center"
                        >
                          <FieldContent>
                            <FieldLabel
                              htmlFor="compress-ai-file-reference"
                              className="text-xs"
                            >
                              参考文件内容
                            </FieldLabel>
                            <FieldDescription className="text-xs leading-relaxed">
                              读取压缩来源中匹配扩展名的文本，含子文件夹。内容摘录和文件名会发送给当前
                              AI 服务。
                            </FieldDescription>
                          </FieldContent>
                          <Switch
                            id="compress-ai-file-reference"
                            size="sm"
                            checked={useAiFileReference}
                            disabled={referencePreferencesLocked}
                            onCheckedChange={(checked) =>
                              referencePreferences.setEnabled(
                                "useAiFileReference",
                                checked
                              )
                            }
                          />
                        </Field>
                        {useAiFileReference ? (
                          <FieldSet className="gap-2">
                            <FieldLegend
                              id="compress-ai-reference-label"
                              variant="label"
                              className="text-xs"
                            >
                              参考文件扩展名
                            </FieldLegend>
                            <ToggleGroup
                              multiple
                              variant="outline"
                              size="sm"
                              spacing={1}
                              value={selectedReferenceExtensions}
                              disabled={referencePreferencesLocked}
                              aria-label="选择参考文件后缀"
                              aria-describedby="compress-ai-reference-hint"
                              onValueChange={(values) => {
                                if (referencePreferencesLocked) return
                                if (values.length > 32) {
                                  setReferenceExtensionError(
                                    "最多可选择 32 种参考文件后缀。"
                                  )
                                  return
                                }
                                referencePreferences.change(
                                  values,
                                  aiCustomReferenceExtensions
                                )
                                setReferenceExtensionError(null)
                              }}
                              className="w-full flex-wrap justify-start gap-1.5"
                            >
                              {referenceExtensionOptions.map((suffix) => {
                                const custom =
                                  !AI_REFERENCE_EXTENSION_OPTIONS.includes(
                                    suffix
                                  )
                                const selected =
                                  selectedReferenceExtensions.includes(suffix)
                                return (
                                  <div
                                    key={suffix}
                                    className={cn(
                                      "inline-flex max-w-full items-center rounded-3xl",
                                      custom && "border border-input pr-1",
                                      custom &&
                                        selected &&
                                        "border-primary/50 bg-primary/10 text-primary"
                                    )}
                                  >
                                    <ToggleGroupItem
                                      value={suffix}
                                      aria-label={`.${suffix}`}
                                      className={cn(
                                        "max-w-full gap-1.5 text-xs aria-pressed:border-primary/50 aria-pressed:bg-primary/10 aria-pressed:text-primary",
                                        custom &&
                                          "min-w-0 border-0 pr-1.5 aria-pressed:bg-transparent"
                                      )}
                                    >
                                      <Check
                                        aria-hidden
                                        className={cn(
                                          "size-3",
                                          !selectedReferenceExtensions.includes(
                                            suffix
                                          ) && "invisible"
                                        )}
                                      />
                                      <span className="truncate">
                                        .{suffix}
                                      </span>
                                    </ToggleGroupItem>
                                    {custom ? (
                                      <Button
                                        type="button"
                                        size="icon-xs"
                                        variant="ghost"
                                        disabled={referencePreferencesLocked}
                                        onClick={() =>
                                          removeReferenceExtension(suffix)
                                        }
                                        aria-label={`删除 .${suffix} 标签`}
                                        title={`删除 .${suffix} 标签`}
                                        className="shrink-0 rounded-full text-muted-foreground hover:text-destructive"
                                      >
                                        <X aria-hidden />
                                      </Button>
                                    ) : null}
                                  </div>
                                )
                              })}
                            </ToggleGroup>
                            <Field
                              className="gap-1.5"
                              data-invalid={Boolean(referenceExtensionError)}
                            >
                              <FieldLabel
                                htmlFor="compress-ai-reference-extensions"
                                className="sr-only"
                              >
                                自定义后缀
                              </FieldLabel>
                              <InputGroup>
                                <InputGroupInput
                                  id="compress-ai-reference-extensions"
                                  ref={customReferenceInput}
                                  value={customReferenceExtension}
                                  onChange={(event) => {
                                    setCustomReferenceExtension(
                                      event.target.value
                                    )
                                    setReferenceExtensionError(null)
                                  }}
                                  onKeyDown={(event) => {
                                    if (
                                      event.key === "Enter" &&
                                      !event.nativeEvent.isComposing
                                    ) {
                                      event.preventDefault()
                                      addReferenceExtensions()
                                    }
                                  }}
                                  placeholder="输入自定义后缀，例如 rst"
                                  autoComplete="off"
                                  spellCheck={false}
                                  maxLength={1024}
                                  disabled={referencePreferencesLocked}
                                  aria-invalid={Boolean(
                                    referenceExtensionError
                                  )}
                                  aria-describedby="compress-ai-reference-add-hint compress-ai-reference-error"
                                />
                                <InputGroupAddon align="inline-end">
                                  <InputGroupButton
                                    disabled={
                                      referencePreferencesLocked ||
                                      !customReferenceExtension.trim()
                                    }
                                    onClick={addReferenceExtensions}
                                    aria-label="添加后缀标签"
                                  >
                                    <Plus aria-hidden />
                                    添加
                                  </InputGroupButton>
                                </InputGroupAddon>
                              </InputGroup>
                              <FieldDescription
                                id="compress-ai-reference-add-hint"
                                className="text-xs leading-relaxed"
                              >
                                回车或点击添加后自动选中，多个后缀可用逗号或空格分隔。自定义标签可用
                                × 删除，标签与选中状态会自动保存。
                              </FieldDescription>
                              {referenceExtensionError ? (
                                <FieldError
                                  id="compress-ai-reference-error"
                                  className="text-xs"
                                >
                                  {referenceExtensionError}
                                </FieldError>
                              ) : null}
                            </Field>
                            <FieldDescription
                              id="compress-ai-reference-hint"
                              className="text-xs leading-relaxed"
                            >
                              点击标签可多选或取消。最多参考 8
                              个文件，每个读取前 8 KiB，总计 32
                              KiB；跳过不可读文本，无匹配时仅参考基础名称。
                            </FieldDescription>
                          </FieldSet>
                        ) : null}
                        {useAiFileReference ? (
                          <CompressionReferencePreview
                            preview={referencePreview}
                            hasSources={sources.length > 0}
                            hasExtensions={Boolean(
                              aiReferenceExtensions.trim()
                            )}
                            disabled={
                              draftLocked || !referencePreferences.ready
                            }
                          />
                        ) : null}
                      </div>
                    ) : null}

                    {useAiRename && (!activeAiProfile || aiError) ? (
                      <Alert
                        variant="warning"
                        className="animate-reveal-down motion-safe-only"
                      >
                        <CircleAlert />
                        <AlertDescription className="min-w-0 flex-1 text-xs">
                          {aiError ?? "尚未配置可用的 AI 模型，请先前往设置。"}
                        </AlertDescription>
                        {activeAiProfile && aiError ? (
                          <WorkbenchDetailsActions>
                            <Button
                              type="button"
                              size="xs"
                              variant="outline"
                              disabled={busy}
                              onClick={() => void handleStart(false)}
                            >
                              重试
                            </Button>
                            <Button
                              type="button"
                              size="xs"
                              variant="outline"
                              disabled={busy}
                              onClick={() => void handleStart(true)}
                            >
                              使用原名称
                            </Button>
                          </WorkbenchDetailsActions>
                        ) : null}
                      </Alert>
                    ) : null}
                  </WorkbenchDetails>
                  <Separator />

                  <div className="byte-compress-security grid gap-3 @min-[30rem]:grid-cols-[176px_minmax(0,1fr)]">
                    <Field
                      data-disabled={draftLocked || undefined}
                      className="gap-1.5"
                    >
                      <FieldLabel htmlFor="compression-level">
                        压缩级别
                      </FieldLabel>
                      <Select
                        items={LEVEL_OPTIONS}
                        value={String(level)}
                        disabled={draftLocked}
                        onValueChange={(value) => {
                          if (value === null) {
                            return
                          }
                          updateDraft(
                            "level",
                            Number(value) as CompressionLevel
                          )
                        }}
                      >
                        <SelectTrigger
                          id="compression-level"
                          className="w-full"
                          aria-describedby="compression-level-hint"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent
                          align="start"
                          alignItemWithTrigger={false}
                          className="min-w-56"
                        >
                          <SelectGroup>
                            <SelectLabel>速度与体积平衡</SelectLabel>
                            {LEVELS.map((item) => (
                              <SelectItem
                                key={item.value}
                                value={String(item.value)}
                              >
                                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                                  <span>{item.label}</span>
                                  <span className="text-xs font-normal text-muted-foreground">
                                    {item.description}
                                  </span>
                                </div>
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                      <FieldDescription
                        id="compression-level-hint"
                        className="text-xs leading-relaxed"
                      >
                        级别越高，通常越小、越慢。
                      </FieldDescription>
                    </Field>

                    <Field className="gap-1.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <FieldLabel htmlFor="compression-password">
                          密码（可选）
                        </FieldLabel>
                        <span className="text-xs text-muted-foreground">
                          系统凭据保存 · 不写入日志
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <InputGroup className="min-w-[min(100%,14rem)] flex-1">
                          <InputGroupInput
                            id="compression-password"
                            type={showPassword ? "text" : "password"}
                            value={password}
                            onChange={(event) =>
                              updateDraft("password", event.target.value)
                            }
                            placeholder={
                              hasPermanentPassword && usePermanentPassword
                                ? "留空则使用已保存的永久密码"
                                : "留空则创建无密码归档"
                            }
                            disabled={draftLocked}
                            autoComplete="off"
                          />
                          <InputGroupAddon align="inline-end">
                            <InputGroupButton
                              size="icon-xs"
                              onClick={() => setShowPassword((value) => !value)}
                              disabled={passwordCredentialBusy}
                              aria-label={
                                showPassword ? "隐藏密码" : "显示密码"
                              }
                            >
                              {showPassword ? <EyeOff /> : <Eye />}
                            </InputGroupButton>
                          </InputGroupAddon>
                        </InputGroup>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon-sm"
                          onClick={() => void handleSavePermanentPassword()}
                          disabled={
                            draftLocked || !permanentPasswordReady || !password
                          }
                          aria-label={
                            hasPermanentPassword
                              ? "更新永久密码"
                              : "永久保存密码"
                          }
                          title={
                            hasPermanentPassword
                              ? "更新永久密码"
                              : "永久保存密码"
                          }
                        >
                          {passwordCredentialBusy ? <Spinner /> : <KeyRound />}
                        </Button>
                        {hasPermanentPassword ? (
                          <>
                            <SwitchControl
                              checked={usePermanentPassword}
                              onCheckedChange={setUsePermanentPassword}
                              label="本次使用"
                              disabled={draftLocked || !permanentPasswordReady}
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => setDeletePasswordOpen(true)}
                              disabled={draftLocked}
                              aria-label="删除永久密码"
                              title="删除永久密码"
                            >
                              <Trash2 />
                            </Button>
                          </>
                        ) : null}
                        <SwitchControl
                          checked={encryptFileNames}
                          onCheckedChange={(checked) =>
                            updateDraft("encryptFileNames", checked)
                          }
                          label="加密文件名"
                          disabled={draftLocked || format !== "sevenZip"}
                          title={
                            format === "zip"
                              ? "ZIP 不支持隐藏归档内的文件名"
                              : undefined
                          }
                        />
                      </div>
                    </Field>
                    {password ? (
                      <Field
                        className="gap-1.5 @min-[30rem]:col-start-2"
                        data-invalid={Boolean(passwordError)}
                      >
                        <FieldLabel htmlFor="compression-password-confirmation">
                          确认新密码
                        </FieldLabel>
                        <InputGroup>
                          <InputGroupInput
                            id="compression-password-confirmation"
                            type={showPassword ? "text" : "password"}
                            value={passwordConfirmation}
                            onChange={(event) =>
                              updateDraft(
                                "passwordConfirmation",
                                event.target.value
                              )
                            }
                            placeholder="再次输入本次新密码"
                            disabled={draftLocked}
                            autoComplete="off"
                            aria-invalid={Boolean(passwordError)}
                            aria-describedby="compression-password-confirmation-help"
                          />
                        </InputGroup>
                        <FieldDescription
                          id="compression-password-confirmation-help"
                          role={passwordError ? "alert" : undefined}
                          className={
                            passwordError ? "text-destructive" : undefined
                          }
                        >
                          {passwordError ?? "两次输入须一致。"}
                        </FieldDescription>
                      </Field>
                    ) : null}
                  </div>
                </div>
              </ScrollArea>
            </CardContent>

            <Separator />
            <CardFooter className="shrink-0 justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <FullText
                  className="text-xs font-medium"
                  text={
                    baseName.trim()
                      ? `${baseName.trim()}.${format === "sevenZip" ? "7z" : "zip"}`
                      : "等待命名的归档"
                  }
                />
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {sources.length > 0
                    ? `${COUNT_FORMATTER.format(sources.length)} 个来源 · 同名文件自动使用 “(1)” 后缀`
                    : "添加来源后即可开始压缩"}
                </p>
              </div>
              {running ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleCancel}
                  disabled={cancelling}
                  aria-busy={cancelling}
                >
                  <Square data-icon="inline-start" />
                  {cancelling ? "正在停止…" : "取消压缩"}
                </Button>
              ) : (
                <Button
                  type="button"
                  onClick={() => void handleStart(false)}
                  disabled={
                    draftLocked ||
                    !permanentPasswordReady ||
                    !referencePreferences.ready ||
                    referencePreview.loading ||
                    sources.length === 0
                  }
                >
                  {busy ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <Archive data-icon="inline-start" />
                  )}
                  开始压缩
                </Button>
              )}
            </CardFooter>
          </Card>
        </div>
      </WorkbenchPageContent>
      <AlertDialog
        open={deletePasswordOpen}
        onOpenChange={(open) => {
          if (!passwordCredentialBusy) {
            setDeletePasswordOpen(open)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除永久密码？</AlertDialogTitle>
            <AlertDialogDescription>
              系统凭据库中的归档密码将被删除，之后创建归档不会再自动使用。此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={passwordCredentialBusy}>
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={passwordCredentialBusy}
              onClick={(event) => {
                event.preventDefault()
                void handleDeletePermanentPassword()
              }}
            >
              {passwordCredentialBusy ? "正在删除…" : "删除永久密码"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </WorkbenchPage>
  )
}

function SourceAction({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled: boolean
  onClick: () => void
  children: React.ReactElement<{ className?: string }>
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="size-7 shrink-0 rounded-md"
    >
      {children}
    </Button>
  )
}

function SwitchControl({
  checked,
  onCheckedChange,
  label,
  disabled = false,
  title,
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  label: string
  disabled?: boolean
  title?: string
}) {
  const id = React.useId()

  return (
    <Field
      orientation="horizontal"
      data-disabled={disabled || undefined}
      title={title}
      className="w-auto shrink-0 gap-2"
    >
      <Switch
        id={id}
        size="sm"
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
      <FieldLabel htmlFor={id} className="text-xs whitespace-nowrap">
        {label}
      </FieldLabel>
    </Field>
  )
}
