"use client"

import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  DatabaseBackup,
  Download,
  FileJson,
  FolderOpen,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
} from "lucide-react"
import * as React from "react"

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
import { Card, CardContent } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  type LogEntry,
  type LogLevel,
  type LogListResult,
  backupDatabase,
  clearLogs,
  exportLogs,
  listLogs,
  openLogDirectory,
} from "@/lib/logging"
import { cn } from "@/lib/utils"

const PAGE_SIZE = 200
const REFRESH_INTERVAL_MS = 2_500

type LevelFilter = LogLevel | "all"
type DisplayMode = "summary" | "all"

const LEVELS: { value: LevelFilter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "error", label: "错误" },
  { value: "warn", label: "警告" },
  { value: "info", label: "信息" },
  { value: "debug", label: "调试" },
]

const LEVEL_META: Record<
  LogLevel,
  { label: string; dot: string; badge: "destructive" | "secondary" | "outline" }
> = {
  error: {
    label: "错误",
    dot: "bg-destructive",
    badge: "destructive",
  },
  warn: {
    label: "警告",
    dot: "bg-amber-500",
    badge: "secondary",
  },
  info: {
    label: "信息",
    dot: "bg-emerald-500",
    badge: "outline",
  },
  debug: {
    label: "调试",
    dot: "bg-sky-500",
    badge: "outline",
  },
}

const SOURCE_LABELS: Record<string, string> = {
  desktop: "应用",
  frontend: "界面",
  recovery: "恢复与解压",
  dictionary: "候选字典",
  engine: "外部引擎",
  database: "数据库",
  logs: "日志",
  settings: "设置",
}

const PHASE_LABELS: Record<string, string> = {
  preparing: "准备任务",
  verifying: "验证密码",
  converting: "转换压缩包哈希",
  hashcat: "使用 Hashcat 恢复密码",
  john: "使用 John 恢复密码",
  internal: "尝试候选密码",
  extracting: "解压文件",
  recursive: "扫描嵌套压缩包",
  completed: "完成任务",
  exhausted: "结束候选尝试",
  cancelled: "取消任务",
  failed: "处理失败",
}

const CONTEXT_LABELS: Record<string, string> = {
  added_count: "新增",
  deleted_count: "删除",
  duplicate_count: "重复",
  invalid_count: "无效",
  submitted_count: "提交",
  requested_count: "请求",
  byte_count: "数据量",
  entry_count: "记录",
  removed_file_count: "删除文件",
  log_level: "日志级别",
  log_max_disk_mib: "容量上限",
}

const ROUTINE_DETAIL_EVENTS = new Set([
  "app.started",
  "archive.analyzed",
  "logs.ready",
  "recovery.requested",
  "recovery.phase_changed",
])

const LOG_TIMESTAMP_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
})

const TRAILING_SENTENCE_PATTERN = /[。；;]+$/

export function LogsPage() {
  const [level, setLevel] = React.useState<LevelFilter>("all")
  const [searchText, setSearchText] = React.useState("")
  const deferredSearch = React.useDeferredValue(searchText)
  const [take, setTake] = React.useState(PAGE_SIZE)
  const [result, setResult] = React.useState<LogListResult | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [refreshing, setRefreshing] = React.useState(false)
  const [autoRefresh, setAutoRefresh] = React.useState(true)
  const [displayMode, setDisplayMode] = React.useState<DisplayMode>("summary")
  const [action, setAction] = React.useState<
    "export" | "backup" | "clear" | "directory" | null
  >(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [clearDialogOpen, setClearDialogOpen] = React.useState(false)
  const requestSequence = React.useRef(0)

  const refresh = React.useCallback(
    async (silent = false) => {
      const requestId = ++requestSequence.current
      if (!silent) {
        setRefreshing(true)
      }
      try {
        const next = await listLogs({
          level: level === "all" ? undefined : level,
          searchText: deferredSearch,
          take,
        })
        if (requestSequence.current !== requestId) {
          return
        }
        setResult(next)
        setError(null)
      } catch (reason) {
        if (requestSequence.current !== requestId) {
          return
        }
        setError(`读取日志失败：${errorMessage(reason)}`)
      } finally {
        if (requestSequence.current === requestId) {
          setLoading(false)
          setRefreshing(false)
        }
      }
    },
    [deferredSearch, level, take]
  )

  React.useEffect(() => {
    const initialRefresh = window.setTimeout(() => {
      void refresh(true)
    }, 0)
    const interval = autoRefresh
      ? window.setInterval(() => {
          void refresh(true)
        }, REFRESH_INTERVAL_MS)
      : null
    return () => {
      window.clearTimeout(initialRefresh)
      if (interval !== null) {
        window.clearInterval(interval)
      }
    }
  }, [autoRefresh, refresh])

  const runAction = React.useCallback(
    async (
      nextAction: "export" | "backup" | "clear" | "directory",
      operation: () => Promise<string>
    ) => {
      if (action) {
        return
      }
      setAction(nextAction)
      setError(null)
      try {
        setNotice(await operation())
        await refresh(true)
      } catch (reason) {
        setError(errorMessage(reason))
      } finally {
        setAction(null)
      }
    },
    [action, refresh]
  )

  const handleExport = () => {
    void runAction("export", async () => {
      const exported = await exportLogs()
      return `已导出 ${exported.entryCount} 条日志：${exported.path}`
    })
  }

  const handleBackup = () => {
    void runAction("backup", async () => {
      const backup = await backupDatabase()
      return `SQLite 备份已创建（${formatBytes(backup.byteCount)}）：${backup.path}`
    })
  }

  const handleOpenDirectory = () => {
    void runAction("directory", async () => {
      await openLogDirectory()
      return "已打开日志目录。"
    })
  }

  const handleClear = () => {
    setClearDialogOpen(false)
    setTake(PAGE_SIZE)
    void runAction("clear", async () => {
      const removed = await clearLogs()
      return `历史日志已清空，共移除 ${removed} 个日志文件。`
    })
  }

  const stats = result?.stats
  const isBusy = action !== null
  const compactMode =
    displayMode === "summary" &&
    deferredSearch.trim() === "" &&
    level !== "debug"
  const resultEntries = result?.entries
  const visibleEntries = React.useMemo(() => {
    const entries = resultEntries ?? []
    return compactMode
      ? entries.filter((entry) => !isRoutineDetail(entry))
      : entries
  }, [compactMode, resultEntries])
  const hiddenRoutineCount =
    (resultEntries?.length ?? 0) - visibleEntries.length

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="mx-auto flex h-full min-h-0 w-full max-w-[960px] flex-col gap-2 px-5 pt-6 pb-2">
        <header className="flex shrink-0 flex-wrap items-start justify-between gap-3 pr-12 lg:pr-0">
          <div className="min-w-0">
            <p className="text-[11px] font-medium tracking-[0.16em] text-muted-foreground uppercase">
              Operations
            </p>
            <h1 className="mt-1 text-lg font-semibold tracking-tight">日志</h1>
            <p className="mt-0.5 text-xs text-muted-foreground">
              默认显示重要结果；过程记录可在“全部事件”中查看。
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <Button
              variant="outline"
              size="sm"
              disabled={isBusy}
              onClick={handleOpenDirectory}
            >
              <FolderOpen data-icon="inline-start" />
              目录
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={isBusy}
              onClick={handleBackup}
            >
              <DatabaseBackup data-icon="inline-start" />
              备份数据库
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={isBusy}
              onClick={handleExport}
            >
              <Download data-icon="inline-start" />
              导出
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={isBusy || (result?.totalCount ?? 0) === 0}
              onClick={() => setClearDialogOpen(true)}
            >
              <Trash2 data-icon="inline-start" />
              清空
            </Button>
          </div>
        </header>

        <section
          aria-label="日志概览"
          className="grid shrink-0 grid-cols-2 gap-2 lg:grid-cols-4"
        >
          <SummaryCard
            label={compactMode ? "摘要" : "事件"}
            value={String(
              compactMode ? visibleEntries.length : (result?.totalCount ?? 0)
            )}
            hint={
              compactMode
                ? `已收起 ${hiddenRoutineCount} 条过程记录`
                : `当前显示 ${result?.entries.length ?? 0} 条`
            }
            icon={<FileJson className="size-4" />}
          />
          <SummaryCard
            label="需关注"
            value={String((stats?.errorCount ?? 0) + (stats?.warnCount ?? 0))}
            hint={`${stats?.errorCount ?? 0} 错误 · ${stats?.warnCount ?? 0} 警告`}
            icon={<AlertTriangle className="size-4" />}
            tone={(stats?.errorCount ?? 0) > 0 ? "danger" : "default"}
          />
          <SummaryCard
            label="磁盘占用"
            value={formatBytes(stats?.diskBytes ?? 0)}
            hint={`${stats?.fileCount ?? 0} 个文件 · 上限可在设置中调整`}
            icon={<DatabaseBackup className="size-4" />}
          />
          <SummaryCard
            label="隐私保护"
            value="已启用"
            hint="敏感字段写入前脱敏"
            icon={<ShieldCheck className="size-4" />}
          />
        </section>

        <Card size="sm" className="min-h-0 flex-1 gap-0 overflow-hidden py-0">
          <CardContent className="flex h-full min-h-0 flex-col p-0">
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/80 p-2.5">
              <fieldset className="flex flex-wrap items-center gap-1">
                <legend className="sr-only">按日志级别筛选</legend>
                {LEVELS.map((item) => (
                  <Button
                    key={item.value}
                    type="button"
                    size="xs"
                    variant={level === item.value ? "default" : "ghost"}
                    aria-pressed={level === item.value}
                    onClick={() => {
                      setLevel(item.value)
                      setTake(PAGE_SIZE)
                    }}
                  >
                    {item.label}
                  </Button>
                ))}
              </fieldset>

              <span
                aria-hidden
                className="hidden h-5 w-px bg-border sm:block"
              />
              <fieldset className="flex items-center gap-1">
                <legend className="sr-only">日志显示方式</legend>
                <Button
                  type="button"
                  size="xs"
                  variant={displayMode === "summary" ? "secondary" : "ghost"}
                  aria-pressed={displayMode === "summary"}
                  onClick={() => setDisplayMode("summary")}
                >
                  简洁
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant={displayMode === "all" ? "secondary" : "ghost"}
                  aria-pressed={displayMode === "all"}
                  onClick={() => setDisplayMode("all")}
                >
                  全部事件
                </Button>
              </fieldset>

              <div className="relative min-w-[180px] flex-1">
                <Label htmlFor="log-search" className="sr-only">
                  搜索日志
                </Label>
                <Search
                  aria-hidden
                  className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  id="log-search"
                  value={searchText}
                  onChange={(event) => {
                    setSearchText(event.target.value)
                    setTake(PAGE_SIZE)
                  }}
                  placeholder="搜索事件、来源或内容…"
                  className="h-8 rounded-xl pl-8 text-xs"
                />
              </div>

              <div className="flex items-center gap-2">
                <Checkbox
                  id="logs-auto-refresh"
                  checked={autoRefresh}
                  onCheckedChange={setAutoRefresh}
                />
                <Label
                  htmlFor="logs-auto-refresh"
                  className="text-xs text-muted-foreground"
                >
                  自动刷新
                </Label>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="立即刷新日志"
                  title="立即刷新"
                  disabled={refreshing}
                  onClick={() => void refresh()}
                >
                  <RefreshCw
                    className={cn(
                      "size-3.5",
                      refreshing && "animate-spin motion-reduce:animate-none"
                    )}
                  />
                </Button>
              </div>
            </div>

            <div
              aria-live="polite"
              aria-atomic="true"
              className={cn(
                "shrink-0 border-b px-3 py-1.5 text-[11px]",
                error
                  ? "border-destructive/20 bg-destructive/5 text-destructive"
                  : "border-border/60 bg-muted/20 text-muted-foreground"
              )}
            >
              {error ??
                notice ??
                (result
                  ? compactMode && hiddenRoutineCount > 0
                    ? `摘要显示 ${visibleEntries.length} 条 · 已收起 ${hiddenRoutineCount} 条过程记录`
                    : `匹配 ${result.matchedCount} / ${result.totalCount} 条`
                  : "正在读取本机日志…")}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {loading ? (
                <LogState
                  icon={
                    <RefreshCw className="size-5 animate-spin motion-reduce:animate-none" />
                  }
                  title="正在读取日志"
                  description="正在扫描本机轮转日志文件。"
                />
              ) : result?.entries.length ? (
                <>
                  {hiddenRoutineCount > 0 ? (
                    <div className="flex items-center justify-between gap-3 border-b border-border/70 bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
                      <p>已收起 {hiddenRoutineCount} 条技术与过程记录。</p>
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        className="shrink-0"
                        onClick={() => setDisplayMode("all")}
                      >
                        查看全部事件
                      </Button>
                    </div>
                  ) : null}
                  {visibleEntries.length ? (
                    <ol
                      aria-label="日志事件"
                      className="divide-y divide-border/70"
                    >
                      {visibleEntries.map((entry) => (
                        <LogRow key={entry.id} entry={entry} />
                      ))}
                    </ol>
                  ) : (
                    <LogState
                      icon={<CheckCircle2 className="size-5" />}
                      title="没有需要关注的摘要"
                      description="阶段切换等技术记录已被收起，可切换到“全部事件”查看。"
                    />
                  )}
                </>
              ) : (
                <LogState
                  icon={<CheckCircle2 className="size-5" />}
                  title="没有匹配的日志"
                  description={
                    result?.totalCount
                      ? "尝试调整级别或搜索条件。"
                      : "新的运行事件会自动出现在这里。"
                  }
                />
              )}
            </div>

            {result?.hasMore ? (
              <div className="shrink-0 border-t border-border/80 p-2 text-center">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={refreshing}
                  onClick={() => setTake((current) => current + PAGE_SIZE)}
                >
                  查看更多
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <AlertDialog open={clearDialogOpen} onOpenChange={setClearDialogOpen}>
        <AlertDialogContent size="default">
          <AlertDialogHeader>
            <AlertDialogTitle>清空本机日志</AlertDialogTitle>
            <AlertDialogDescription>
              将删除当前及轮转日志文件。建议先导出诊断记录；此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={isBusy}
              onClick={handleClear}
            >
              清空日志
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function SummaryCard({
  label,
  value,
  hint,
  icon,
  tone = "default",
}: {
  label: string
  value: string
  hint: string
  icon: React.ReactNode
  tone?: "default" | "danger"
}) {
  return (
    <Card
      size="sm"
      className={cn("gap-0 py-0", tone === "danger" && "border-destructive/25")}
    >
      <CardContent className="flex items-start gap-2.5 p-3">
        <span
          className={cn(
            "mt-0.5 rounded-lg bg-muted p-1.5 text-muted-foreground",
            tone === "danger" && "bg-destructive/10 text-destructive"
          )}
        >
          {icon}
        </span>
        <div className="min-w-0">
          <p className="text-[11px] text-muted-foreground">{label}</p>
          <p className="text-base font-semibold tracking-tight">{value}</p>
          <p className="truncate text-[10px] text-muted-foreground">{hint}</p>
        </div>
      </CardContent>
    </Card>
  )
}

function LogRow({ entry }: { entry: LogEntry }) {
  const meta = LEVEL_META[entry.level]
  const presentation = presentLogEntry(entry)
  const context = Object.entries(entry.context)

  return (
    <li className="grid grid-cols-[7.25rem_4rem_minmax(0,1fr)] gap-2 px-3 py-2.5 text-xs transition-colors [contain-intrinsic-size:auto_76px] [content-visibility:auto] hover:bg-muted/30">
      <time
        dateTime={new Date(entry.timestampMs).toISOString()}
        className="font-mono text-[10px] leading-5 whitespace-nowrap text-muted-foreground"
      >
        {formatTimestamp(entry.timestampMs)}
      </time>
      <div>
        <Badge variant={meta.badge} className="h-5 gap-1 px-1.5 font-normal">
          <span aria-hidden className={cn("size-1.5 rounded-full", meta.dot)} />
          {meta.label}
        </Badge>
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="font-medium text-foreground">
            {presentation.title}
          </span>
          <span className="text-[10px] text-muted-foreground">
            {sourceLabel(entry.source)}
          </span>
        </div>
        {presentation.description ? (
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            {presentation.description}
          </p>
        ) : null}
        <details className="group mt-1.5">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-md text-[10px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30 [&::-webkit-details-marker]:hidden">
            技术详情
            <ChevronDown className="size-3 transition-transform group-open:rotate-180" />
          </summary>
          <dl className="mt-2 grid gap-1.5 rounded-lg border border-border/70 bg-muted/20 p-2 text-[10px] sm:grid-cols-2">
            <TechnicalField
              label="来源"
              value={`${sourceLabel(entry.source)}（${entry.source}）`}
            />
            <TechnicalField label="事件标识" value={entry.event} />
            {context.map(([key, value]) => (
              <TechnicalField key={key} label={key} value={value} />
            ))}
          </dl>
        </details>
      </div>
    </li>
  )
}

function TechnicalField({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-mono break-all text-foreground/80">
        {value || "—"}
      </dd>
    </div>
  )
}

function LogState({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode
  title: string
  description: string
}) {
  return (
    <div className="flex h-full min-h-40 items-center justify-center p-6 text-center">
      <div>
        <span className="mx-auto flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          {icon}
        </span>
        <p className="mt-3 text-sm font-medium">{title}</p>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
  )
}

function formatTimestamp(timestamp: number) {
  return LOG_TIMESTAMP_FORMATTER.format(timestamp)
}

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason ?? "未知错误")
}

function isRoutineDetail(entry: LogEntry) {
  return entry.level === "debug" || ROUTINE_DETAIL_EVENTS.has(entry.event)
}

function presentLogEntry(entry: LogEntry): {
  title: string
  description?: string
} {
  const engine = entry.context.engine
  const nestedExtracted = parseCount(entry.context.nested_extracted)
  const nestedSkipped = parseCount(entry.context.nested_skipped)

  switch (entry.event) {
    case "app.started":
      return {
        title: "ArcRecall 已启动",
        description: joinSummary([
          entry.context.version ? `版本 ${entry.context.version}` : undefined,
          entry.context.platform
            ? `运行环境 ${entry.context.platform}`
            : undefined,
        ]),
      }
    case "logs.ready":
      return {
        title: "日志功能已就绪",
        description: entry.context.retention
          ? `当前保留策略：${entry.context.retention}`
          : undefined,
      }
    case "recovery.requested":
      return {
        title: "已收到恢复与解压请求",
        description:
          entry.context.mode === "known"
            ? "使用手动输入的密码优先验证"
            : "将在需要时使用候选字典恢复密码",
      }
    case "archive.analyzed":
      return {
        title: "压缩包分析完成",
        description: entry.context.format
          ? `识别为 ${entry.context.format} 格式`
          : undefined,
      }
    case "recovery.started":
      return {
        title: "开始恢复与解压",
        description: joinSummary([
          entry.context.archive_format
            ? `压缩格式 ${entry.context.archive_format}`
            : undefined,
          entry.context.candidate_count
            ? `候选密码 ${entry.context.candidate_count} 条`
            : undefined,
        ]),
      }
    case "recovery.phase_changed": {
      const phase = phaseLabel(entry.context.phase)
      return {
        title: phase ? `正在${phase}` : "恢复任务进入下一阶段",
        description: joinSummary([
          engine ? `使用 ${engine}` : undefined,
          "这是故障排查用的过程记录",
        ]),
      }
    }
    case "recovery.completed":
      return {
        title: "恢复与解压完成",
        description: joinSummary([
          engine ? `使用 ${engine}` : undefined,
          nestedExtracted > 0
            ? `处理了 ${nestedExtracted} 个嵌套压缩包`
            : "没有需要处理的嵌套压缩包",
          nestedSkipped > 0 ? `${nestedSkipped} 个嵌套压缩包未处理` : undefined,
        ]),
      }
    case "recovery.cancel_requested":
      return {
        title: "正在停止恢复任务",
        description: "已向外部引擎发送取消请求",
      }
    case "recovery.cancelled":
      return { title: "恢复任务已取消" }
    case "recovery.unsuccessful":
      return {
        title: "未找到可用密码",
        description: engine ? `已使用 ${engine} 完成当前候选尝试` : undefined,
      }
    case "recovery.failed":
      return {
        title: "恢复与解压失败",
        description: "展开技术详情可获取用于排查的事件编号",
      }
    case "database.backup_completed":
      return {
        title: "数据库备份已创建",
        description: entry.context.byte_count
          ? `备份大小 ${formatBytes(Number(entry.context.byte_count))}`
          : undefined,
      }
    case "logs.exported":
      return {
        title: "日志已导出",
        description: entry.context.entry_count
          ? `共导出 ${entry.context.entry_count} 条记录`
          : undefined,
      }
    case "logs.cleared":
      return { title: "历史日志已清空" }
    case "settings.saved":
      return { title: "应用设置已保存" }
    default:
      return {
        title: trimSentence(entry.message),
        description: genericContextSummary(entry.context),
      }
  }
}

function sourceLabel(source: string) {
  return SOURCE_LABELS[source] ?? "应用"
}

function phaseLabel(phase: string | undefined) {
  if (!phase) {
    return undefined
  }
  return PHASE_LABELS[phase] ?? phase
}

function genericContextSummary(context: Record<string, string>) {
  const parts = Object.entries(context)
    .filter(([key]) => key in CONTEXT_LABELS)
    .slice(0, 3)
    .map(([key, value]) => {
      if (key === "byte_count") {
        return `${CONTEXT_LABELS[key]} ${formatBytes(Number(value))}`
      }
      if (key === "log_max_disk_mib") {
        return `${CONTEXT_LABELS[key]} ${value} MiB`
      }
      return `${CONTEXT_LABELS[key]} ${value}`
    })
  return parts.length ? parts.join(" · ") : undefined
}

function joinSummary(parts: Array<string | undefined>) {
  const summary = parts.filter((part): part is string => Boolean(part))
  return summary.length ? summary.join(" · ") : undefined
}

function parseCount(value: string | undefined) {
  const count = Number(value ?? 0)
  return Number.isFinite(count) ? count : 0
}

function trimSentence(message: string) {
  return message.trim().replace(TRAILING_SENTENCE_PATTERN, "")
}
