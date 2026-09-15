"use client"

import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  DatabaseBackup,
  Download,
  FileJson,
  FolderOpen,
  MoreHorizontal,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
} from "lucide-react"
import * as React from "react"

import {
  WorkbenchPage,
  WorkbenchPageContent,
  WorkbenchPageHeader,
} from "@/components/layout/workbench-page"
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
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  formatBytes,
  isRoutineLogDetail,
  presentLogEntry,
} from "@/components/home/log-presentation"
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
import { createRefreshQueue } from "@/lib/refresh-queue"

const PAGE_SIZE = 200
const REFRESH_INTERVAL_MS = 2_500
const SEARCH_DEBOUNCE_MS = 300

type LevelFilter = LogLevel | "attention" | "all"
type DisplayMode = "summary" | "all"

const LEVELS: { value: LevelFilter; label: string }[] = [
  { value: "attention", label: "需关注" },
  { value: "all", label: "全部级别" },
  { value: "error", label: "错误" },
  { value: "warn", label: "警告" },
  { value: "info", label: "信息" },
  { value: "debug", label: "调试" },
]

const LEVEL_META: Record<
  LogLevel,
  {
    label: string
    dot: string
    badge: "destructive" | "secondary" | "outline" | "warning"
  }
> = {
  error: {
    label: "错误",
    dot: "bg-destructive",
    badge: "destructive",
  },
  warn: {
    label: "警告",
    dot: "bg-warning",
    badge: "warning",
  },
  info: {
    label: "信息",
    dot: "bg-muted-foreground",
    badge: "outline",
  },
  debug: {
    label: "调试",
    dot: "bg-muted-foreground/60",
    badge: "secondary",
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

const LOG_TIMESTAMP_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
})

const LOG_REFRESH_TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
})

export function LogsPage() {
  const [level, setLevel] = React.useState<LevelFilter>("attention")
  const [searchText, setSearchText] = React.useState("")
  const [appliedSearch, setAppliedSearch] = React.useState("")
  const [pageIndex, setPageIndex] = React.useState(0)
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
  const [lastRefreshedAt, setLastRefreshedAt] = React.useState<number | null>(
    null
  )
  const [listFocused, setListFocused] = React.useState(false)
  const [expandedEntryIds, setExpandedEntryIds] = React.useState<Set<string>>(
    () => new Set()
  )
  const requestSequence = React.useRef(0)
  const [refreshQueue] = React.useState(createRefreshQueue)
  const visible = React.useRef(false)
  const listRef = React.useRef<HTMLDivElement>(null)
  const autoRefreshPaused =
    autoRefresh &&
    (pageIndex > 0 ||
      listFocused ||
      expandedEntryIds.size > 0 ||
      searchText.trim().length > 0)

  React.useLayoutEffect(() => {
    visible.current = true
    return () => {
      visible.current = false
      requestSequence.current += 1
      refreshQueue.clearPending()
    }
  }, [refreshQueue])

  React.useLayoutEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0
  }, [appliedSearch, level, pageIndex])

  React.useEffect(() => {
    if (searchText.trim() === appliedSearch) return
    const timeout = window.setTimeout(() => {
      setAppliedSearch(searchText.trim())
      setPageIndex(0)
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timeout)
  }, [appliedSearch, searchText])

  const refresh = React.useCallback(
    (silent = false) => {
      const requestId = ++requestSequence.current
      if (!silent) {
        setRefreshing(true)
      }
      return refreshQueue.run(async () => {
        if (!visible.current || requestSequence.current !== requestId) return
        try {
          const next = await listLogs({
            level: level === "all" || level === "attention" ? undefined : level,
            attentionOnly: level === "attention",
            searchText: appliedSearch,
            skip: pageIndex * PAGE_SIZE,
            take: PAGE_SIZE,
          })
          if (requestSequence.current !== requestId) {
            return
          }
          const lastPage = Math.max(
            0,
            Math.ceil(next.matchedCount / PAGE_SIZE) - 1
          )
          if (pageIndex > lastPage) {
            setPageIndex(lastPage)
            return
          }
          const loadedIds = new Set(next.entries.map((entry) => entry.id))
          setExpandedEntryIds((current) => {
            const retained = new Set(
              [...current].filter((entryId) => loadedIds.has(entryId))
            )
            return retained.size === current.size ? current : retained
          })
          setResult(next)
          setLastRefreshedAt(Date.now())
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
      })
    },
    [appliedSearch, level, pageIndex, refreshQueue]
  )

  const latestRefresh = React.useRef(refresh)
  React.useLayoutEffect(() => {
    latestRefresh.current = refresh
  }, [refresh])

  React.useEffect(() => {
    const initialRefresh = window.setTimeout(() => {
      void refresh()
    }, 0)
    return () => {
      window.clearTimeout(initialRefresh)
      requestSequence.current += 1
      refreshQueue.clearPending()
    }
  }, [refresh, refreshQueue])

  React.useEffect(() => {
    if (!autoRefresh || autoRefreshPaused) return
    let disposed = false
    let timeout: number
    const poll = async () => {
      if (!refreshQueue.isRunning()) await refresh(true)
      if (!disposed) timeout = window.setTimeout(poll, REFRESH_INTERVAL_MS)
    }
    timeout = window.setTimeout(poll, REFRESH_INTERVAL_MS)
    return () => {
      disposed = true
      window.clearTimeout(timeout)
    }
  }, [autoRefresh, autoRefreshPaused, refresh, refreshQueue])

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
        await latestRefresh.current(true)
      } catch (reason) {
        setError(errorMessage(reason))
      } finally {
        setAction(null)
      }
    },
    [action]
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
    setPageIndex(0)
    void runAction("clear", async () => {
      const removed = await clearLogs()
      return `历史日志已清空，共移除 ${removed} 个日志文件。`
    })
  }

  const stats = result?.stats
  const isBusy = action !== null
  const compactMode =
    displayMode === "summary" && appliedSearch === "" && level !== "debug"
  const resultEntries = result?.entries
  const visibleEntries = React.useMemo(() => {
    const entries = resultEntries ?? []
    return compactMode
      ? entries.filter((entry) => !isRoutineLogDetail(entry))
      : entries
  }, [compactMode, resultEntries])
  const hiddenRoutineCount =
    (resultEntries?.length ?? 0) - visibleEntries.length
  const passiveStatus = result
    ? [
        `当前可见 ${visibleEntries.length} 条`,
        `已加载 ${result.entries.length} 条`,
        `共匹配 ${result.matchedCount} 条`,
        hiddenRoutineCount > 0
          ? `收起 ${hiddenRoutineCount} 条常规与过程记录`
          : null,
        lastRefreshedAt
          ? `最后刷新 ${formatRefreshTime(lastRefreshedAt)}`
          : null,
      ]
        .filter((part): part is string => Boolean(part))
        .join(" · ")
    : "正在读取本机日志…"

  const handleEntryExpandedChange = (entryId: string, open: boolean) => {
    setExpandedEntryIds((current) => {
      const next = new Set(current)
      if (open) {
        next.add(entryId)
      } else {
        next.delete(entryId)
      }
      return next
    })
  }

  return (
    <WorkbenchPage>
      <WorkbenchPageContent className="gap-2">
        <WorkbenchPageHeader
          title="日志"
          titleHidden
          actions={
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button variant="outline" size="sm" disabled={isBusy} />
                }
              >
                <MoreHorizontal data-icon="inline-start" />
                日志工具
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" sideOffset={8}>
                <DropdownMenuGroup>
                  <DropdownMenuLabel>诊断与维护</DropdownMenuLabel>
                  <DropdownMenuItem
                    disabled={isBusy}
                    onClick={handleOpenDirectory}
                  >
                    <FolderOpen />
                    打开日志目录
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={isBusy} onClick={handleBackup}>
                    <DatabaseBackup />
                    备份数据库
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={isBusy} onClick={handleExport}>
                    <Download />
                    导出诊断记录
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={isBusy || (result?.totalCount ?? 0) === 0}
                    onClick={() => setClearDialogOpen(true)}
                  >
                    <Trash2 />
                    清空本机日志
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          }
        />

        <Card
          size="sm"
          aria-label="日志概览"
          className="grid shrink-0 grid-cols-2 gap-px overflow-hidden bg-border py-0 shadow-sm sm:grid-cols-4"
        >
          <SummaryMetric
            label="当前可见"
            value={String(visibleEntries.length)}
            hint={
              compactMode && hiddenRoutineCount > 0
                ? `已加载 ${result?.entries.length ?? 0} · 收起 ${hiddenRoutineCount}`
                : `已加载 ${result?.entries.length ?? 0} · 共匹配 ${result?.matchedCount ?? 0}`
            }
            icon={<FileJson className="size-4" />}
          />
          <SummaryMetric
            label="需关注"
            value={String((stats?.errorCount ?? 0) + (stats?.warnCount ?? 0))}
            hint={
              <>
                <span className="font-medium text-destructive">
                  {stats?.errorCount ?? 0} 错误
                </span>
                <span aria-hidden>·</span>
                <span className="font-medium text-warning-foreground">
                  {stats?.warnCount ?? 0} 警告
                </span>
              </>
            }
            icon={<AlertTriangle className="size-4" />}
            tone="attention"
            active={level === "attention"}
            onClick={() => {
              setLevel("attention")
              setSearchText("")
              setDisplayMode("summary")
              setPageIndex(0)
            }}
          />
          <SummaryMetric
            label="磁盘占用"
            value={formatBytes(stats?.diskBytes ?? 0)}
            hint={`${stats?.fileCount ?? 0} 个文件`}
            icon={<DatabaseBackup className="size-4" />}
          />
          <SummaryMetric
            label="隐私保护"
            value="已启用"
            hint="敏感字段写入前脱敏"
            icon={<ShieldCheck className="size-4" />}
          />
        </Card>

        <Card size="sm" className="min-h-0 flex-1 gap-0 overflow-hidden py-0">
          <CardContent className="flex h-full min-h-0 flex-col p-0">
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/80 p-2.5">
              <div className="min-w-48 flex-1">
                <Label htmlFor="log-search" className="sr-only">
                  搜索日志
                </Label>
                <InputGroup>
                  <InputGroupAddon>
                    <Search aria-hidden />
                  </InputGroupAddon>
                  <InputGroupInput
                    id="log-search"
                    value={searchText}
                    onChange={(event) => {
                      setSearchText(event.target.value)
                    }}
                    placeholder="搜索事件、来源或内容…"
                    className="text-xs"
                  />
                </InputGroup>
              </div>

              <Select
                value={level}
                onValueChange={(value) => {
                  if (value) {
                    setLevel(value as LevelFilter)
                    setPageIndex(0)
                  }
                }}
              >
                <SelectTrigger aria-label="按日志级别筛选" className="w-28">
                  <SelectValue>
                    {LEVELS.find((item) => item.value === level)?.label}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  <SelectGroup>
                    <SelectLabel>日志级别</SelectLabel>
                    {LEVELS.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>

              <ToggleGroup
                value={[displayMode]}
                onValueChange={(value) => {
                  const next = value[0] as DisplayMode | undefined
                  if (next) {
                    setDisplayMode(next)
                  }
                }}
                aria-label="日志显示方式"
              >
                <ToggleGroupItem value="summary">摘要</ToggleGroupItem>
                <ToggleGroupItem value="all">全部事件</ToggleGroupItem>
              </ToggleGroup>

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
                  {autoRefreshPaused ? "自动刷新已暂停" : "自动刷新"}
                </Label>
                <Button
                  variant="ghost"
                  aria-label="立即刷新日志"
                  title="立即刷新"
                  disabled={refreshing}
                  onClick={() => void refresh()}
                >
                  <RefreshCw
                    data-icon="inline-start"
                    className={cn(
                      refreshing && "animate-spin motion-reduce:animate-none"
                    )}
                  />
                  刷新
                </Button>
              </div>
            </div>

            {error || notice ? (
              <Alert
                aria-live="polite"
                aria-atomic="true"
                variant={error ? "destructive" : "success"}
                className="shrink-0 rounded-none border-x-0 border-t-0 px-3 py-1.5"
              >
                <AlertDescription className="text-xs">
                  {error ?? notice}
                </AlertDescription>
              </Alert>
            ) : (
              <div className="shrink-0 border-b border-border/80 px-3 py-1.5 text-xs text-muted-foreground">
                {passiveStatus}
              </div>
            )}

            <div
              ref={listRef}
              className="min-h-0 flex-1 scroll-fade overflow-y-auto"
              onFocusCapture={() => setListFocused(true)}
              onBlurCapture={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) {
                  setListFocused(false)
                }
              }}
            >
              {loading ? (
                <LogState icon={<Spinner />} title="正在读取日志" />
              ) : result?.entries.length ? (
                <>
                  {hiddenRoutineCount > 0 ? (
                    <div className="flex items-center justify-between gap-3 border-b border-border/70 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                      <p>
                        已收起 {hiddenRoutineCount} 条常规、技术与过程记录。
                      </p>
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
                        <LogRow
                          key={entry.id}
                          entry={entry}
                          expanded={expandedEntryIds.has(entry.id)}
                          onExpandedChange={(open) =>
                            handleEntryExpandedChange(entry.id, open)
                          }
                        />
                      ))}
                    </ol>
                  ) : (
                    <LogState
                      icon={<CheckCircle2 className="size-5" />}
                      title="没有需要关注的摘要"
                      description="切换到“全部事件”查看常规记录。"
                    />
                  )}
                </>
              ) : (
                <LogState
                  icon={<CheckCircle2 className="size-5" />}
                  title={
                    level === "attention"
                      ? "当前没有需关注的日志"
                      : "没有匹配的日志"
                  }
                  description={
                    level === "attention"
                      ? "错误与警告会优先显示在这里。"
                      : result?.totalCount
                        ? "尝试调整级别或搜索条件。"
                        : "新的运行事件会自动出现在这里。"
                  }
                />
              )}
            </div>

            {result && (pageIndex > 0 || result.hasMore) ? (
              <>
                <Separator />
                <div className="flex shrink-0 items-center justify-between gap-2 p-2">
                  <p className="px-1 text-xs text-muted-foreground tabular-nums">
                    第 {pageIndex + 1} /{" "}
                    {Math.max(1, Math.ceil(result.matchedCount / PAGE_SIZE))} 页
                  </p>
                  <nav aria-label="日志分页" className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={refreshing || pageIndex === 0}
                      onClick={() =>
                        setPageIndex((current) => Math.max(0, current - 1))
                      }
                    >
                      <ChevronLeft data-icon="inline-start" />
                      上一页
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={refreshing || !result.hasMore}
                      onClick={() => setPageIndex((current) => current + 1)}
                    >
                      下一页
                      <ChevronRight data-icon="inline-end" />
                    </Button>
                  </nav>
                </div>
              </>
            ) : null}
          </CardContent>
        </Card>
      </WorkbenchPageContent>

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
    </WorkbenchPage>
  )
}

function SummaryMetric({
  label,
  value,
  hint,
  icon,
  tone = "default",
  active = false,
  onClick,
}: {
  label: string
  value: string
  hint: React.ReactNode
  icon: React.ReactNode
  tone?: "default" | "attention" | "danger"
  active?: boolean
  onClick?: () => void
}) {
  const content = (
    <>
      <span
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-xl bg-muted/80 text-muted-foreground",
          tone === "attention" && "bg-warning/10 text-warning-foreground",
          tone === "danger" && "bg-destructive/10 text-destructive"
        )}
      >
        {icon}
      </span>
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <p className="shrink-0 text-sm font-semibold tracking-tight tabular-nums">
            {value}
          </p>
          <p className="truncate text-xs font-medium tracking-wide text-muted-foreground">
            {label}
          </p>
        </div>
        <p className="mt-0.5 flex min-w-0 items-center gap-1.5 truncate text-xs text-muted-foreground">
          {hint}
        </p>
      </div>
    </>
  )
  const className = cn(
    "relative flex min-w-0 items-center gap-2.5 bg-card px-3 py-2.5 text-left",
    tone === "danger" && "bg-destructive/[0.035]",
    active &&
      "after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-t-full after:bg-primary"
  )

  return onClick ? (
    <button
      type="button"
      aria-pressed={active}
      className={cn(
        className,
        "transition-colors outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      )}
      onClick={onClick}
    >
      {content}
    </button>
  ) : (
    <div className={className}>{content}</div>
  )
}

function LogRow({
  entry,
  expanded,
  onExpandedChange,
}: {
  entry: LogEntry
  expanded: boolean
  onExpandedChange: (open: boolean) => void
}) {
  const meta = LEVEL_META[entry.level]
  const presentation = presentLogEntry(entry)
  const context = Object.entries(entry.context)

  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1.5 px-3 py-2.5 text-xs transition-colors [contain-intrinsic-size:auto_76px] [content-visibility:auto] hover:bg-muted/30 sm:grid-cols-[7.25rem_4rem_minmax(0,1fr)] sm:gap-2">
      <time
        dateTime={new Date(entry.timestampMs).toISOString()}
        className="font-mono text-xs leading-5 whitespace-nowrap text-muted-foreground"
      >
        {formatTimestamp(entry.timestampMs)}
      </time>
      <div>
        <Badge variant={meta.badge} className="h-5 gap-1 px-1.5 font-normal">
          <span aria-hidden className={cn("size-1.5 rounded-full", meta.dot)} />
          {meta.label}
        </Badge>
      </div>
      <div className="col-span-2 min-w-0 sm:col-span-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="font-medium text-foreground">
            {presentation.title}
          </span>
          <span className="text-xs text-muted-foreground">
            {sourceLabel(entry.source)}
          </span>
        </div>
        {presentation.description ? (
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {presentation.description}
          </p>
        ) : null}
        <Collapsible
          open={expanded}
          onOpenChange={onExpandedChange}
          className="group mt-1.5"
        >
          <CollapsibleTrigger className="inline-flex cursor-pointer items-center gap-1 rounded-md text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30">
            技术详情
            <ChevronDown className="size-3 transition-transform group-data-[open]/collapsible:rotate-180" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <dl className="mt-2 grid gap-1.5 rounded-lg border border-border/70 bg-muted/20 p-2 text-xs sm:grid-cols-2">
              <TechnicalField
                label="来源"
                value={`${sourceLabel(entry.source)}（${entry.source}）`}
              />
              <TechnicalField label="事件标识" value={entry.event} />
              {context.map(([key, value]) => (
                <TechnicalField key={key} label={key} value={value} />
              ))}
            </dl>
          </CollapsibleContent>
        </Collapsible>
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
  description?: string
}) {
  return (
    <Empty className="h-full min-h-40 border-0 p-6">
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle className="text-sm">{title}</EmptyTitle>
        {description ? (
          <EmptyDescription className="text-xs">{description}</EmptyDescription>
        ) : null}
      </EmptyHeader>
    </Empty>
  )
}

function formatTimestamp(timestamp: number) {
  return LOG_TIMESTAMP_FORMATTER.format(
    Number.isFinite(timestamp) ? timestamp : 0
  )
}

function formatRefreshTime(timestamp: number) {
  return LOG_REFRESH_TIME_FORMATTER.format(
    Number.isFinite(timestamp) ? timestamp : 0
  )
}

function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason ?? "未知错误")
}

function sourceLabel(source: string) {
  return SOURCE_LABELS[source] ?? "应用"
}
