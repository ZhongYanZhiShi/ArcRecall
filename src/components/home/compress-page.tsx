"use client"

import { getCurrentWebview } from "@tauri-apps/api/webview"
import {
  Archive,
  ArrowDown,
  ArrowUp,
  Check,
  CircleAlert,
  Eye,
  EyeOff,
  FileArchive,
  FilePlus2,
  FolderOpen,
  FolderPlus,
  KeyRound,
  PackagePlus,
  Square,
  Trash2,
  WandSparkles,
} from "lucide-react"
import * as React from "react"

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
import {
  generateAiArchiveName,
  listAiProfiles,
  type AiSettings,
} from "@/lib/ai"
import { Progress } from "@/components/ui/progress"
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
import {
  cancelCompression,
  deletePermanentCompressionPassword,
  getCompressionStatus,
  getPermanentCompressionPasswordStatus,
  pickCompressionFiles,
  pickCompressionFolder,
  pickCompressionOutputDirectory,
  savePermanentCompressionPassword,
  startCompression,
  type CompressionFormat,
  type CompressionTaskStatus,
} from "@/lib/compression"
import {
  forgetCompletedArchiveBaseName,
  shouldForgetArchiveBaseName,
} from "@/lib/compression-draft"
import { isDesktopRuntime } from "@/lib/dictionary"
import { openPath } from "@/lib/settings"
import { cn } from "@/lib/utils"

type OutputMode = "sibling" | "custom"
type CompressionLevel = 0 | 1 | 3 | 5 | 7 | 9

export type CompressionDraft = {
  sources: string[]
  outputMode: OutputMode
  outputDirectory: string | null
  baseName: string
  format: CompressionFormat
  level: CompressionLevel
  password: string
  encryptFileNames: boolean
  openWhenDone: boolean
  useAiRename: boolean
}

export function createCompressionDraft(): CompressionDraft {
  return {
    sources: [],
    outputMode: "sibling",
    outputDirectory: null,
    baseName: "",
    format: "sevenZip",
    level: 5,
    password: "",
    encryptFileNames: false,
    openWhenDone: true,
    useAiRename: false,
  }
}

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

export function CompressPage({
  draft,
  onDraftChange,
  onOpenAiSettings,
}: {
  draft: CompressionDraft
  onDraftChange: React.Dispatch<React.SetStateAction<CompressionDraft>>
  onOpenAiSettings: () => void
}) {
  const {
    sources,
    outputMode,
    outputDirectory,
    baseName,
    format,
    level,
    password,
    encryptFileNames,
    openWhenDone,
    useAiRename,
  } = draft
  const [showPassword, setShowPassword] = React.useState(false)
  const [hasPermanentPassword, setHasPermanentPassword] = React.useState(false)
  const [usePermanentPassword, setUsePermanentPassword] = React.useState(false)
  const [permanentPasswordReady, setPermanentPasswordReady] =
    React.useState(false)
  const [passwordCredentialBusy, setPasswordCredentialBusy] =
    React.useState(false)
  const [deletePasswordOpen, setDeletePasswordOpen] = React.useState(false)
  const [dragOver, setDragOver] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [aiError, setAiError] = React.useState<string | null>(null)
  const [aiSettings, setAiSettings] = React.useState<AiSettings | null>(null)
  const [task, setTask] = React.useState<CompressionTaskStatus | null>(null)
  const openedTasks = React.useRef(new Set<string>())
  const archiveNamesAwaitingCompletion = React.useRef(new Set<string>())
  const running = Boolean(task?.running)
  const runningRef = React.useRef(running)

  React.useEffect(() => {
    runningRef.current = running
  }, [running])

  const setSources = React.useCallback(
    (update: React.SetStateAction<string[]>) => {
      onDraftChange((current) => ({
        ...current,
        sources:
          typeof update === "function" ? update(current.sources) : update,
      }))
    },
    [onDraftChange]
  )

  const updateDraft = React.useCallback(
    <Key extends keyof CompressionDraft>(
      key: Key,
      value: CompressionDraft[Key]
    ) => {
      onDraftChange((current) => ({ ...current, [key]: value }))
    },
    [onDraftChange]
  )

  React.useEffect(() => {
    let disposed = false
    void getPermanentCompressionPasswordStatus()
      .then((status) => {
        if (disposed) {
          return
        }
        setHasPermanentPassword(status.hasPassword)
        setUsePermanentPassword(status.hasPassword)
      })
      .catch((reason) => {
        if (!disposed) {
          setError(toErrorMessage(reason))
        }
      })
      .finally(() => {
        if (!disposed) {
          setPermanentPasswordReady(true)
        }
      })
    return () => {
      disposed = true
    }
  }, [])

  const handleSavePermanentPassword = React.useCallback(async () => {
    if (!password) {
      setError("请先输入要永久保存的密码。")
      return
    }
    setPasswordCredentialBusy(true)
    setError(null)
    try {
      const status = await savePermanentCompressionPassword(password)
      setHasPermanentPassword(status.hasPassword)
      setUsePermanentPassword(status.hasPassword)
      updateDraft("password", "")
      setShowPassword(false)
    } catch (reason) {
      setError(toErrorMessage(reason))
    } finally {
      setPasswordCredentialBusy(false)
    }
  }, [password, updateDraft])

  const handleDeletePermanentPassword = React.useCallback(async () => {
    setPasswordCredentialBusy(true)
    setError(null)
    try {
      const status = await deletePermanentCompressionPassword()
      setHasPermanentPassword(status.hasPassword)
      setUsePermanentPassword(false)
      setDeletePasswordOpen(false)
    } catch (reason) {
      setError(toErrorMessage(reason))
    } finally {
      setPasswordCredentialBusy(false)
    }
  }, [])

  const refreshAiSettings = React.useCallback(() => {
    void listAiProfiles()
      .then((next) => {
        setAiSettings(next)
        setAiError(null)
      })
      .catch((reason) => {
        setAiSettings(null)
        setAiError(toErrorMessage(reason))
      })
  }, [])

  React.useEffect(refreshAiSettings, [refreshAiSettings])

  const appendSources = React.useCallback(
    (paths: string[]) => {
      setSources((current) => {
        const seen = new Set(current.map(sourceIdentity))
        const next = [...current]
        for (const path of paths) {
          const normalized = normalizeSourcePath(path)
          if (!normalized || seen.has(sourceIdentity(normalized))) {
            continue
          }
          seen.add(sourceIdentity(normalized))
          next.push(normalized)
        }
        return next
      })
    },
    [setSources]
  )

  React.useEffect(() => {
    if (!isDesktopRuntime()) {
      return
    }
    let disposed = false
    void getCompressionStatus()
      .then((latest) => {
        if (!disposed && latest) {
          setTask((current) => current ?? latest)
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

  React.useEffect(() => {
    if (!isDesktopRuntime()) {
      return
    }
    let disposed = false
    let unlisten: (() => void) | undefined
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (disposed || runningRef.current) {
          setDragOver(false)
          return
        }
        if (event.payload.type === "over") {
          setDragOver(true)
        } else if (event.payload.type === "drop") {
          setDragOver(false)
          appendSources(event.payload.paths)
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
  }, [appendSources])

  React.useEffect(() => {
    if (!task?.running) {
      return
    }
    let disposed = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const latest = await getCompressionStatus(task.taskId)
        if (disposed || !latest) {
          return
        }
        setTask(latest)
        if (latest.running) {
          timeout = setTimeout(poll, 650)
        }
      } catch (reason) {
        if (!disposed) {
          setError(toErrorMessage(reason))
          timeout = setTimeout(poll, 1500)
        }
      }
    }
    timeout = setTimeout(poll, 300)
    return () => {
      disposed = true
      if (timeout) {
        clearTimeout(timeout)
      }
    }
  }, [task?.running, task?.taskId])

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
    void openPath(task.outputPath).catch((reason) =>
      setError(toErrorMessage(reason))
    )
  }, [openWhenDone, task])

  React.useEffect(() => {
    if (
      task &&
      shouldForgetArchiveBaseName(task, archiveNamesAwaitingCompletion.current)
    ) {
      onDraftChange(forgetCompletedArchiveBaseName)
    }
  }, [onDraftChange, task])

  const handlePickFiles = React.useCallback(async () => {
    setError(null)
    try {
      appendSources(await pickCompressionFiles())
    } catch (reason) {
      setError(toErrorMessage(reason))
    }
  }, [appendSources])

  const handlePickFolder = React.useCallback(async () => {
    setError(null)
    try {
      const path = await pickCompressionFolder()
      if (path) {
        appendSources([path])
      }
    } catch (reason) {
      setError(toErrorMessage(reason))
    }
  }, [appendSources])

  const handlePickOutput = React.useCallback(async () => {
    setError(null)
    try {
      const path = await pickCompressionOutputDirectory()
      if (path) {
        updateDraft("outputDirectory", path)
        updateDraft("outputMode", "custom")
      }
    } catch (reason) {
      setError(toErrorMessage(reason))
    }
  }, [updateDraft])

  const handleMoveSource = React.useCallback(
    (index: number, direction: -1 | 1) => {
      setSources((current) => {
        const target = index + direction
        if (target < 0 || target >= current.length) {
          return current
        }
        const next = [...current]
        ;[next[index], next[target]] = [next[target], next[index]]
        return next
      })
    },
    [setSources]
  )

  const activeAiProfile =
    aiSettings?.profiles.find(
      (profile) => profile.id === aiSettings.activeProfileId
    ) ?? null

  const handleStart = React.useCallback(
    async (skipAiRename = false) => {
      if (sources.length === 0) {
        setError("请先添加至少一个文件或文件夹。")
        return
      }
      if (!baseName.trim()) {
        setError("请输入归档基础名称。")
        return
      }
      if (
        encryptFileNames &&
        !password &&
        !(hasPermanentPassword && usePermanentPassword)
      ) {
        setError("开启文件名加密前需要设置密码。")
        return
      }
      if (outputMode === "custom" && !outputDirectory) {
        setError("请选择自定义输出目录。")
        return
      }
      if (useAiRename && !skipAiRename && !activeAiProfile) {
        setAiError("尚未配置可用的 AI 模型，请先前往设置。")
        return
      }

      setBusy(true)
      setError(null)
      setAiError(null)
      try {
        let resolvedName = baseName.trim()
        if (useAiRename && !skipAiRename) {
          resolvedName = await generateAiArchiveName(
            resolvedName,
            activeAiProfile?.id
          )
          updateDraft("baseName", resolvedName)
        }
        const next = await startCompression({
          sources,
          outputDirectory:
            outputMode === "custom" ? outputDirectory : undefined,
          baseName: resolvedName,
          format,
          level,
          password: password || undefined,
          usePermanentPassword: hasPermanentPassword && usePermanentPassword,
          encryptFileNames,
        })
        setTask(next)
      } catch (reason) {
        const message = toErrorMessage(reason)
        if (useAiRename && !skipAiRename) {
          setAiError(message)
        } else {
          setError(message)
        }
      } finally {
        setBusy(false)
      }
    },
    [
      activeAiProfile,
      baseName,
      encryptFileNames,
      format,
      hasPermanentPassword,
      level,
      outputDirectory,
      outputMode,
      password,
      sources,
      updateDraft,
      useAiRename,
      usePermanentPassword,
    ]
  )

  const handleCancel = React.useCallback(async () => {
    if (!task?.running) {
      return
    }
    setError(null)
    try {
      await cancelCompression(task.taskId)
    } catch (reason) {
      setError(toErrorMessage(reason))
    }
  }, [task])

  const defaultOutput = sources[0]
    ? parentPathForDisplay(sources[0])
    : "首个来源的上级目录"
  const extension = format === "sevenZip" ? ".7z" : ".zip"
  const activeLevel = LEVELS.find((item) => item.value === level)

  return (
    <WorkbenchPage>
      <WorkbenchPageContent
        width="wide"
        data-testid="compress-page"
        className="pb-5"
      >
        <WorkbenchPageHeader
          title="创建归档"
          description="先整理来源，再设置归档参数；主操作始终保持可见。"
          size="large"
        />

        <div className="mt-4 grid min-h-0 flex-1 grid-rows-[minmax(11rem,0.85fr)_minmax(0,1.15fr)] gap-3 lg:grid-cols-[minmax(18rem,0.85fr)_minmax(0,1.4fr)] lg:grid-rows-1">
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
                    <CardTitle className="text-sm font-semibold">
                      压缩来源
                    </CardTitle>
                    {sources.length > 0 ? (
                      <Badge variant="secondary">
                        {COUNT_FORMATTER.format(sources.length)} 个
                      </Badge>
                    ) : null}
                  </div>
                  <CardDescription className="mt-0.5 text-xs">
                    {dragOver
                      ? "松开即可加入当前列表"
                      : "支持混合添加文件与文件夹，可调整归档顺序。"}
                  </CardDescription>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handlePickFiles}
                    disabled={running}
                  >
                    <FilePlus2 data-icon="inline-start" />
                    添加文件
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handlePickFolder}
                    disabled={running}
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
                  <ol className="flex flex-col gap-1.5 p-3 pr-4">
                    {sources.map((source, index) => (
                      <li
                        key={sourceIdentity(source)}
                        className="flex min-w-0 items-center gap-2 rounded-xl border border-border/80 bg-background px-2.5 py-2"
                      >
                        <FileArchive
                          aria-hidden
                          className="size-4 shrink-0 text-muted-foreground"
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-medium">
                            {fileNameFromPath(source)}
                          </p>
                          <p
                            className="mt-0.5 truncate text-xs text-muted-foreground"
                            title={source}
                          >
                            {source}
                          </p>
                        </div>
                        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                          {index + 1}
                        </span>
                        <SourceAction
                          label="上移"
                          disabled={running || index === 0}
                          onClick={() => handleMoveSource(index, -1)}
                        >
                          <ArrowUp />
                        </SourceAction>
                        <SourceAction
                          label="下移"
                          disabled={running || index === sources.length - 1}
                          onClick={() => handleMoveSource(index, 1)}
                        >
                          <ArrowDown />
                        </SourceAction>
                        <SourceAction
                          label="移除"
                          disabled={running}
                          onClick={() =>
                            setSources((current) =>
                              current.filter(
                                (_, sourceIndex) => sourceIndex !== index
                              )
                            )
                          }
                        >
                          <Trash2 />
                        </SourceAction>
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
                      父文件夹已选中时，内部重复项目会在开始压缩前自动去重。
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </CardContent>
          </Card>

          <Card size="sm" className="min-h-0 gap-0 py-0">
            <CardHeader className="shrink-0 px-4 py-3">
              <CardTitle className="text-sm font-semibold">归档设置</CardTitle>
              <CardDescription className="text-xs">
                输出、格式、命名与安全选项
              </CardDescription>
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
                <div className="flex flex-col gap-3 p-4">
                  {error ? (
                    <Alert variant="destructive">
                      <CircleAlert />
                      <AlertDescription>{error}</AlertDescription>
                    </Alert>
                  ) : null}

                  {task ? (
                    <CompressionTaskCard
                      task={task}
                      onOpen={() =>
                        void openPath(task.outputPath).catch((reason) =>
                          setError(toErrorMessage(reason))
                        )
                      }
                    />
                  ) : null}

                  <OutputLocationField
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
                        disabled={running}
                        title="归档完成后自动打开输出文件夹"
                      />
                    }
                    disabled={running}
                  />

                  <Separator />

                  <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_176px]">
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
                          disabled={running}
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
                        名称由你提供；无效文件名字符会在本机安全替换。
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
                        disabled={running}
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

                  <Field
                    orientation="horizontal"
                    data-disabled={running || undefined}
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
                          <Badge variant="outline" className="font-normal">
                            {activeAiProfile.name} ·{" "}
                            {activeAiProfile.model || "未选择模型"}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="font-normal">
                            未配置
                          </Badge>
                        )}
                      </div>
                      <FieldDescription className="text-xs leading-relaxed">
                        只发送你填写的基础名称与提示词，不读取来源文件、路径或内容。
                      </FieldDescription>
                    </FieldContent>
                    <Switch
                      id="compress-ai-rename"
                      size="sm"
                      checked={useAiRename}
                      disabled={running}
                      onCheckedChange={(checked) => {
                        updateDraft("useAiRename", checked)
                        setAiError(
                          checked && !activeAiProfile
                            ? "尚未配置可用的 AI 模型，请先前往设置。"
                            : null
                        )
                      }}
                    />
                  </Field>

                  {useAiRename && (!activeAiProfile || aiError) ? (
                    <Alert
                      variant="warning"
                      className="animate-reveal-down motion-safe-only"
                    >
                      <CircleAlert />
                      <AlertDescription className="min-w-0 flex-1 text-xs">
                        {aiError ?? "尚未配置可用的 AI 模型，请先前往设置。"}
                      </AlertDescription>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {activeAiProfile && aiError ? (
                          <>
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
                          </>
                        ) : null}
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          disabled={busy}
                          onClick={onOpenAiSettings}
                        >
                          前往 AI 设置
                        </Button>
                      </div>
                    </Alert>
                  ) : null}

                  <Separator />

                  <div className="grid gap-3 md:grid-cols-[176px_minmax(0,1fr)]">
                    <Field
                      data-disabled={running || undefined}
                      className="gap-1.5"
                    >
                      <FieldLabel htmlFor="compression-level">
                        压缩级别
                      </FieldLabel>
                      <Select
                        items={LEVEL_OPTIONS}
                        value={String(level)}
                        disabled={running}
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
                        级别越高通常体积越小，但耗时和资源占用也会增加。
                      </FieldDescription>
                    </Field>

                    <Field className="gap-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <FieldLabel htmlFor="compression-password">
                          密码（可选）
                        </FieldLabel>
                        <span className="text-xs text-muted-foreground">
                          系统凭据保存 · 不写入日志
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <InputGroup className="min-w-0 flex-1">
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
                            disabled={running || passwordCredentialBusy}
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
                            running ||
                            passwordCredentialBusy ||
                            !permanentPasswordReady ||
                            !password
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
                              disabled={
                                running ||
                                passwordCredentialBusy ||
                                !permanentPasswordReady
                              }
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => setDeletePasswordOpen(true)}
                              disabled={running || passwordCredentialBusy}
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
                          disabled={running || format !== "sevenZip"}
                          title={
                            format === "zip"
                              ? "ZIP 不支持隐藏归档内的文件名"
                              : undefined
                          }
                        />
                      </div>
                    </Field>
                  </div>
                </div>
              </ScrollArea>
            </CardContent>

            <Separator />
            <CardFooter className="shrink-0 justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="text-xs font-medium">
                  {format === "sevenZip" ? "7z 标准归档" : "ZIP AES-256 归档"}
                </p>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {sources.length > 0
                    ? `${COUNT_FORMATTER.format(sources.length)} 个来源 · 同名文件自动使用 “(1)” 后缀`
                    : "添加来源后即可开始压缩"}
                </p>
              </div>
              {running ? (
                <Button type="button" variant="outline" onClick={handleCancel}>
                  <Square data-icon="inline-start" />
                  取消压缩
                </Button>
              ) : (
                <Button
                  type="button"
                  onClick={() => void handleStart(false)}
                  disabled={
                    busy || passwordCredentialBusy || sources.length === 0
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

function CompressionTaskCard({
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

function normalizeSourcePath(value: string) {
  return value.trim().replace(/^["']|["']$/g, "")
}

function sourceIdentity(path: string) {
  return path.toLocaleLowerCase()
}

function fileNameFromPath(path: string) {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/)
  return parts.at(-1) || path
}

function parentPathForDisplay(path: string) {
  const normalized = path.replace(/[\\/]+$/, "")
  const index = Math.max(
    normalized.lastIndexOf("\\"),
    normalized.lastIndexOf("/")
  )
  return index > 0 ? normalized.slice(0, index) : normalized
}

function formatElapsed(elapsedMs: number) {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
}

function toErrorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason ?? "未知错误")
}
