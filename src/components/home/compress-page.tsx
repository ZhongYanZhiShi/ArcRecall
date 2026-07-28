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
  LoaderCircle,
  PackagePlus,
  Square,
  Trash2,
  WandSparkles,
} from "lucide-react"
import * as React from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  generateAiArchiveName,
  listAiProfiles,
  type AiSettings,
} from "@/lib/ai"
import { Label } from "@/components/ui/label"
import {
  cancelCompression,
  getCompressionStatus,
  pickCompressionFiles,
  pickCompressionFolder,
  pickCompressionOutputDirectory,
  startCompression,
  type CompressionFormat,
  type CompressionTaskStatus,
} from "@/lib/compression"
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
  const [dragOver, setDragOver] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [aiError, setAiError] = React.useState<string | null>(null)
  const [aiSettings, setAiSettings] = React.useState<AiSettings | null>(null)
  const [task, setTask] = React.useState<CompressionTaskStatus | null>(null)
  const openedTasks = React.useRef(new Set<string>())
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
      if (encryptFileNames && !password) {
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
      level,
      outputDirectory,
      outputMode,
      password,
      sources,
      updateDraft,
      useAiRename,
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

  return (
    <div className="h-full min-h-0 overflow-hidden">
      <div className="mx-auto flex h-full min-h-0 w-full max-w-[820px] flex-col overflow-y-auto px-5 pt-6 pb-5">
        <header className="shrink-0">
          <p className="text-[11px] font-medium tracking-[0.18em] text-muted-foreground uppercase">
            Pack
          </p>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">
            创建归档
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            混合添加文件与文件夹，默认输出到首个来源的同级目录。
          </p>
        </header>

        <section
          className={cn(
            "mt-4 shrink-0 rounded-2xl border border-dashed bg-card p-4",
            dragOver && "dropzone-drag"
          )}
          aria-label="压缩来源"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground">
                <PackagePlus className="size-5" strokeWidth={1.8} />
              </div>
              <div className="min-w-0">
                <h2 className="text-sm font-semibold">
                  {dragOver
                    ? "松开以添加来源"
                    : sources.length > 0
                      ? `已选择 ${COUNT_FORMATTER.format(sources.length)} 个来源`
                      : "拖入文件或文件夹"}
                </h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  父文件夹已选中时，内部重复项目会在开始压缩前自动去重。
                </p>
              </div>
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

          {sources.length > 0 ? (
            <ol className="mt-3 space-y-1.5" aria-label="已选来源，可调整顺序">
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
                      className="mt-0.5 truncate text-[10px] text-muted-foreground"
                      title={source}
                    >
                      {source}
                    </p>
                  </div>
                  <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
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
          ) : null}
        </section>

        <section className="mt-3 shrink-0 rounded-xl border border-border bg-card px-3 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <div
              role="group"
              aria-label="输出位置"
              className="relative grid h-8 shrink-0 grid-cols-2 items-stretch rounded-md border border-border bg-background p-0.5"
            >
              <span
                aria-hidden
                className={cn(
                  "motion-safe-only absolute top-0.5 bottom-0.5 left-0.5 w-[calc(50%-2px)] rounded bg-foreground transition-transform duration-200",
                  outputMode === "custom" && "translate-x-full"
                )}
              />
              <SegmentButton
                active={outputMode === "sibling"}
                onClick={() => updateDraft("outputMode", "sibling")}
                disabled={running}
              >
                来源同级
              </SegmentButton>
              <SegmentButton
                active={outputMode === "custom"}
                onClick={() => updateDraft("outputMode", "custom")}
                disabled={running}
              >
                自定义目录
              </SegmentButton>
            </div>
            <p
              className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
              title={
                outputMode === "custom"
                  ? (outputDirectory ?? undefined)
                  : defaultOutput
              }
            >
              {outputMode === "custom"
                ? (outputDirectory ?? "尚未选择目录")
                : defaultOutput}
            </p>
            {outputMode === "custom" ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handlePickOutput}
                disabled={running}
              >
                <FolderOpen data-icon="inline-start" />
                选择
              </Button>
            ) : null}
            <SwitchControl
              checked={openWhenDone}
              onCheckedChange={(checked) =>
                updateDraft("openWhenDone", checked)
              }
              label="完成后打开"
            />
          </div>
        </section>

        <section className="mt-3 shrink-0 rounded-xl border border-border bg-card p-3">
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_176px]">
            <div className="space-y-1.5">
              <Label htmlFor="archive-name">归档基础名称</Label>
              <div className="relative">
                <Input
                  id="archive-name"
                  value={baseName}
                  onChange={(event) =>
                    updateDraft("baseName", event.target.value)
                  }
                  placeholder="例如：项目交付资料"
                  disabled={running}
                  className="pr-12"
                  aria-describedby="archive-name-hint"
                />
                <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">
                  {extension}
                </span>
              </div>
              <p
                id="archive-name-hint"
                className="text-[10px] leading-relaxed text-muted-foreground"
              >
                名称由你提供；无效文件名字符会在本机安全替换。
              </p>
            </div>

            <fieldset className="space-y-1.5">
              <legend className="text-xs font-medium">归档格式</legend>
              <div className="grid h-9 grid-cols-2 rounded-lg border border-border bg-muted/50 p-0.5">
                <FormatButton
                  active={format === "sevenZip"}
                  onClick={() => updateDraft("format", "sevenZip")}
                  disabled={running}
                >
                  7z
                </FormatButton>
                <FormatButton
                  active={format === "zip"}
                  onClick={() => {
                    updateDraft("format", "zip")
                    updateDraft("encryptFileNames", false)
                  }}
                  disabled={running}
                >
                  ZIP
                </FormatButton>
              </div>
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                {format === "sevenZip"
                  ? "压缩率更高，支持文件名加密"
                  : "兼容性更好，密码使用 AES-256"}
              </p>
            </fieldset>
          </div>

          <div className="mt-3 rounded-xl border border-border/80 bg-muted/30 px-3 py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-background text-muted-foreground">
                  <WandSparkles className="size-4" />
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <p className="text-xs font-medium">使用 AI 优化名称</p>
                    {activeAiProfile ? (
                      <span className="rounded-full border border-border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {activeAiProfile.name} ·{" "}
                        {activeAiProfile.model || "未选择模型"}
                      </span>
                    ) : (
                      <span className="rounded-full border border-border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        未配置
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">
                    只发送你填写的基础名称与提示词，不读取来源文件、路径或内容。
                  </p>
                </div>
              </div>
              <SwitchControl
                checked={useAiRename}
                onCheckedChange={(checked) => {
                  updateDraft("useAiRename", checked)
                  setAiError(
                    checked && !activeAiProfile
                      ? "尚未配置可用的 AI 模型，请先前往设置。"
                      : null
                  )
                }}
                label="AI 重命名"
                disabled={running}
              />
            </div>
            {useAiRename && (!activeAiProfile || aiError) ? (
              <div
                role="alert"
                className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-2.5 py-2 text-[11px] text-amber-800 dark:text-amber-200"
              >
                <span className="min-w-0 flex-1">
                  {aiError ?? "尚未配置可用的 AI 模型，请先前往设置。"}
                </span>
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
              </div>
            ) : null}
          </div>

          <div className="mt-3 grid gap-3 border-t border-border/70 pt-3 md:grid-cols-[176px_minmax(0,1fr)]">
            <div className="space-y-1.5">
              <Label htmlFor="compression-level">压缩级别</Label>
              <select
                id="compression-level"
                value={level}
                disabled={running}
                onChange={(event) =>
                  updateDraft(
                    "level",
                    Number(event.target.value) as CompressionLevel
                  )
                }
                className="h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {LEVELS.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label} · {item.description}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="compression-password">密码（可选）</Label>
                <span className="text-[10px] text-muted-foreground">
                  不保存、不写入日志
                </span>
              </div>
              <div className="flex gap-2">
                <div className="relative min-w-0 flex-1">
                  <Input
                    id="compression-password"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(event) =>
                      updateDraft("password", event.target.value)
                    }
                    placeholder="留空则创建无密码归档"
                    disabled={running}
                    autoComplete="off"
                    className="pr-9"
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
            </div>
          </div>

          <div className="mt-3 flex items-center justify-between gap-3 border-t border-border/70 pt-3">
            <div className="min-w-0">
              <p className="text-xs font-medium">
                {format === "sevenZip" ? "7z 标准归档" : "ZIP AES-256 归档"}
              </p>
              <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
                同名文件自动使用 “(1)” 后缀；失败或取消时清理临时文件。
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
                disabled={busy || sources.length === 0}
              >
                {busy ? (
                  <LoaderCircle
                    className="animate-spin"
                    data-icon="inline-start"
                  />
                ) : (
                  <Archive data-icon="inline-start" />
                )}
                开始压缩
              </Button>
            )}
          </div>
        </section>

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

        {error ? (
          <p
            role="alert"
            className="mt-3 shrink-0 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
          >
            {error}
          </p>
        ) : null}
      </div>
    </div>
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
        "mt-3 shrink-0 overflow-hidden rounded-xl border bg-card",
        task.success
          ? "border-emerald-500/35"
          : task.phase === "failed"
            ? "border-destructive/35"
            : "border-border"
      )}
    >
      {task.running ? (
        <div
          className="h-0.5 w-full overflow-hidden bg-muted"
          role="progressbar"
          aria-label="压缩进度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
        >
          <div
            className="motion-safe-only h-full bg-foreground transition-[width] duration-300"
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
              <Check className="size-4 shrink-0 text-emerald-600" />
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
          <p className="mt-1 text-[11px] text-muted-foreground tabular-nums">
            {task.processedSourceCount} / {task.totalSourceCount} 个来源 · 用时{" "}
            {formatElapsed(task.elapsedMs)}
          </p>
          <p
            className="mt-1 truncate font-mono text-[10px] text-muted-foreground"
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
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-30 [&_svg]:size-3.5"
    >
      {children}
    </button>
  )
}

function SegmentButton({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "motion-safe-only relative z-10 min-w-20 rounded px-2 text-[11px] font-medium transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50",
        active
          ? "text-background"
          : "text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </button>
  )
}

function FormatButton({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean
  disabled: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "rounded-md text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </button>
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
  return (
    <label
      title={title}
      className={cn(
        "flex shrink-0 items-center gap-2 text-xs",
        disabled ? "cursor-not-allowed text-muted-foreground" : "cursor-pointer"
      )}
    >
      <span
        className={cn(
          "motion-safe-only relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border transition-colors duration-200",
          checked
            ? "border-foreground bg-foreground"
            : "border-border bg-muted",
          disabled && "opacity-50"
        )}
      >
        <input
          type="checkbox"
          className="sr-only"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onCheckedChange(event.target.checked)}
        />
        <span
          className={cn(
            "motion-safe-only absolute size-2.5 rounded-full transition-all duration-200",
            checked
              ? "right-0.5 bg-background"
              : "left-0.5 bg-muted-foreground/50"
          )}
        />
      </span>
      <span className="whitespace-nowrap">{label}</span>
    </label>
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
