"use client"

import {
  Check,
  ChevronDown,
  Clock3,
  Clipboard,
  Eye,
  EyeOff,
  FileArchive,
  FolderOpen,
  History,
  MoreHorizontal,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react"
import * as React from "react"
import { toast } from "sonner"

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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
import { TablePagination } from "@/components/ui/table-pagination"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"
import {
  clearRecoveryHistory,
  deleteRecoveryHistory,
  HISTORY_PAGE_SIZE,
  listRecoveryHistory,
  revealHistoryPassword,
  type RecoveryHistoryEntry,
  type RecoveryHistoryListResult,
} from "@/lib/history"
import { cn } from "@/lib/utils"
import { copySensitiveText } from "@/lib/sensitive-clipboard"
import { openHistoryLocation } from "@/lib/history-location"

const DATE_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
})

type RevealedPassword = {
  id: number
  value: string
  expiresAt: number
}

export function HistoryPage() {
  const [result, setResult] = React.useState<RecoveryHistoryListResult | null>(
    null
  )
  const [searchInput, setSearchInput] = React.useState("")
  const [appliedSearch, setAppliedSearch] = React.useState("")
  const [pageIndex, setPageIndex] = React.useState(0)
  const [pageSize, setPageSize] = React.useState(HISTORY_PAGE_SIZE)
  const [loading, setLoading] = React.useState(true)
  const [working, setBusy] = React.useState(false)
  const busy = loading || working
  const [loadFailed, setLoadFailed] = React.useState(false)
  const [revealed, setRevealed] = React.useState<RevealedPassword | null>(null)
  const [copiedId, setCopiedId] = React.useState<number | null>(null)
  const [copiedPath, setCopiedPath] = React.useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] =
    React.useState<RecoveryHistoryEntry | null>(null)
  const [clearDialogOpen, setClearDialogOpen] = React.useState(false)
  const requestSequence = React.useRef(0)
  const operationBusy = React.useRef(false)
  const revealVersion = React.useRef(0)

  React.useLayoutEffect(() => {
    return () => {
      // Activity preserves state, so explicitly discard secrets when hidden.
      revealVersion.current += 1
      setRevealed(null)
    }
  }, [])

  const load = React.useCallback(
    async (
      searchText = appliedSearch,
      requestedPage = pageIndex,
      requestedPageSize = pageSize
    ) => {
      const requestId = ++requestSequence.current
      setLoading(true)
      setLoadFailed(false)
      try {
        let next = await listRecoveryHistory({
          searchText,
          skip: requestedPage * requestedPageSize,
          take: requestedPageSize,
        })
        if (requestId !== requestSequence.current) return null
        const pageCount = Math.max(
          1,
          Math.ceil(next.matchedCount / requestedPageSize)
        )
        const resolvedPage =
          requestedPage >= pageCount && requestedPage > 0
            ? pageCount - 1
            : requestedPage
        if (resolvedPage !== requestedPage) {
          next = await listRecoveryHistory({
            searchText,
            skip: resolvedPage * requestedPageSize,
            take: requestedPageSize,
          })
        }
        if (requestId !== requestSequence.current) return null
        setResult(next)
        setPageIndex(resolvedPage)
        setPageSize(requestedPageSize)
        setAppliedSearch(searchText)
        setRevealed(null)
        return next
      } catch (reason) {
        if (requestId === requestSequence.current) {
          setLoadFailed(true)
          toast.error(toErrorMessage(reason), {
            id: "history-feedback",
            duration: 6_000,
          })
        }
        return null
      } finally {
        if (requestId === requestSequence.current) setLoading(false)
      }
    },
    [appliedSearch, pageIndex, pageSize]
  )

  const latestLoad = React.useRef(load)
  React.useLayoutEffect(() => {
    latestLoad.current = load
  }, [load])

  React.useEffect(() => {
    // Activity resumes this effect when returning from another workbench page.
    void latestLoad.current()
    return () => {
      requestSequence.current += 1
    }
  }, [])

  React.useEffect(() => {
    if (!revealed) {
      return
    }
    const timeout = window.setTimeout(
      () => setRevealed(null),
      Math.max(0, revealed.expiresAt - Date.now())
    )
    return () => window.clearTimeout(timeout)
  }, [revealed])

  React.useEffect(() => {
    if (copiedId == null && copiedPath == null) {
      return
    }
    const timeout = window.setTimeout(() => {
      setCopiedId(null)
      setCopiedPath(null)
    }, 1_800)
    return () => window.clearTimeout(timeout)
  }, [copiedId, copiedPath])

  const runBusy = React.useCallback(
    async (action: () => Promise<void>) => {
      if (busy || operationBusy.current) {
        return
      }
      operationBusy.current = true
      setBusy(true)
      try {
        await action()
      } catch (reason) {
        toast.error(toErrorMessage(reason), {
          id: "history-feedback",
          duration: 6_000,
        })
      } finally {
        operationBusy.current = false
        setBusy(false)
      }
    },
    [busy]
  )

  const handleSearch = React.useCallback(() => {
    void runBusy(async () => {
      await load(searchInput.trim(), 0)
    })
  }, [load, runBusy, searchInput])

  const handleRefresh = React.useCallback(() => {
    void runBusy(async () => {
      if (await load())
        toast.success("历史记录已刷新", { id: "history-feedback" })
    })
  }, [load, runBusy])

  const fetchPassword = React.useCallback(async (id: number) => {
    const password = await revealHistoryPassword(id)
    if (password == null) {
      throw new Error("这条记录没有可查看的密码。")
    }
    return password
  }, [])

  const handleReveal = React.useCallback(
    (entry: RecoveryHistoryEntry) => {
      if (revealed?.id === entry.id) {
        setRevealed(null)
        return
      }
      void runBusy(async () => {
        const version = revealVersion.current
        const password = await fetchPassword(entry.id)
        if (version !== revealVersion.current) return
        setRevealed({
          id: entry.id,
          value: password,
          expiresAt: Date.now() + 30_000,
        })
      })
    },
    [fetchPassword, revealed?.id, runBusy]
  )

  const handleCopy = React.useCallback(
    (entry: RecoveryHistoryEntry) => {
      void runBusy(async () => {
        const password =
          revealed?.id === entry.id
            ? revealed.value
            : await fetchPassword(entry.id)
        await copySensitiveText(password)
        setCopiedId(entry.id)
        toast.success("密码已复制", { id: "history-feedback" })
      })
    },
    [fetchPassword, revealed, runBusy]
  )

  const handleDelete = React.useCallback(() => {
    const target = deleteTarget
    if (!target) {
      return
    }
    setDeleteTarget(null)
    void runBusy(async () => {
      const deleted = await deleteRecoveryHistory(target.id)
      if (!(await load())) {
        if (deleted) {
          toast.warning("历史记录已删除，但列表刷新失败，请重试刷新", {
            id: "history-feedback",
            duration: 6_000,
          })
        }
        return
      }
      if (deleted) {
        toast.success("历史记录已删除", { id: "history-feedback" })
      } else {
        toast.info("该记录已经不存在", { id: "history-feedback" })
      }
    })
  }, [deleteTarget, load, runBusy])

  const handleCopyPath = React.useCallback(
    (path: string) => {
      void runBusy(async () => {
        await navigator.clipboard.writeText(path)
        setCopiedPath(path)
        toast.success("路径已复制", { id: "history-feedback" })
      })
    },
    [runBusy]
  )

  const handleOpenPath = React.useCallback(
    (path: string, kind: "archive" | "output") => {
      void runBusy(() => openHistoryLocation(path, kind))
    },
    [runBusy]
  )

  const handleClear = React.useCallback(() => {
    setClearDialogOpen(false)
    void runBusy(async () => {
      const removed = await clearRecoveryHistory()
      setSearchInput("")
      if (!(await load("", 0))) {
        toast.warning(
          `已清空 ${removed} 条历史记录，但列表刷新失败，请重试刷新`,
          { id: "history-feedback", duration: 6_000 }
        )
        return
      }
      toast.success(`已清空 ${removed} 条历史记录`, { id: "history-feedback" })
    })
  }, [load, runBusy])

  return (
    <WorkbenchPage>
      <WorkbenchPageContent width="wide" className="gap-3">
        <WorkbenchPageHeader
          title="历史"
          actions={
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={handleRefresh}
              >
                <RefreshCw
                  data-icon="inline-start"
                  className={cn(
                    busy && "animate-spin motion-reduce:animate-none"
                  )}
                />
                刷新
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button size="sm" variant="outline" disabled={busy} />
                  }
                >
                  <MoreHorizontal data-icon="inline-start" />
                  历史工具
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" sideOffset={8}>
                  <DropdownMenuGroup>
                    <DropdownMenuItem
                      variant="destructive"
                      disabled={busy || (result?.totalCount ?? 0) === 0}
                      onClick={() => setClearDialogOpen(true)}
                    >
                      <Trash2 />
                      清空历史记录
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          }
        />

        <div className="flex shrink-0 items-center gap-2">
          <InputGroup className="h-10 min-w-0 flex-1 border-border/80 bg-card">
            <InputGroupAddon>
              <Search aria-hidden />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              aria-label="搜索压缩包名称或路径"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  handleSearch()
                }
              }}
              placeholder="搜索压缩包名称或路径"
              disabled={busy}
              className="text-sm"
            />
          </InputGroup>
          <Button
            variant="outline"
            className="h-10 bg-card"
            disabled={busy}
            onClick={handleSearch}
          >
            搜索
          </Button>
        </div>

        <ScrollArea
          data-slot="history-scroll-area"
          className="min-h-0 flex-1 rounded-xl border border-border/80 bg-card"
        >
          {loading ? (
            <HistoryState
              icon={<Spinner />}
              title="正在读取历史"
              description="正在查询本机恢复记录。"
            />
          ) : result?.entries.length ? (
            <ul aria-label="解压历史记录" className="divide-y divide-border/70">
              {result.entries.map((entry) => (
                <li key={entry.id} className="min-w-0">
                  <HistoryEntry
                    entry={entry}
                    revealed={revealed?.id === entry.id ? revealed.value : null}
                    copied={copiedId === entry.id}
                    busy={busy}
                    onReveal={() => handleReveal(entry)}
                    onCopy={() => handleCopy(entry)}
                    onDelete={() => setDeleteTarget(entry)}
                    copiedPath={copiedPath}
                    onCopyPath={handleCopyPath}
                    onOpenPath={handleOpenPath}
                  />
                  {!!entry.children?.length && (
                    <Collapsible
                      onOpenChange={(open) => {
                        if (!open) {
                          revealVersion.current += 1
                          if (
                            entry.children?.some(
                              (child) => child.id === revealed?.id
                            )
                          ) {
                            setRevealed(null)
                          }
                        }
                      }}
                      className="mx-4 mb-4 overflow-hidden rounded-lg border border-border/60 bg-muted/20"
                    >
                      <CollapsibleTrigger
                        render={
                          <Button
                            size="sm"
                            variant="ghost"
                            className="group h-9 w-full justify-start rounded-none px-3 text-xs text-muted-foreground"
                          />
                        }
                      >
                        <ChevronDown
                          aria-hidden
                          className="size-3.5 transition-transform group-aria-expanded:rotate-180"
                        />
                        嵌套压缩包 · {entry.children.length}
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <ul
                          aria-label={`${historyEntryName(entry)}的嵌套压缩包`}
                          className="divide-y divide-border/60 border-t border-border/60 bg-card"
                        >
                          {entry.children.map((child) => (
                            <li key={child.id}>
                              <HistoryEntry
                                entry={child}
                                revealed={
                                  revealed?.id === child.id
                                    ? revealed.value
                                    : null
                                }
                                copied={copiedId === child.id}
                                busy={busy}
                                onReveal={() => handleReveal(child)}
                                onCopy={() => handleCopy(child)}
                                onDelete={() => setDeleteTarget(child)}
                                copiedPath={copiedPath}
                                onCopyPath={handleCopyPath}
                                onOpenPath={handleOpenPath}
                              />
                            </li>
                          ))}
                        </ul>
                      </CollapsibleContent>
                    </Collapsible>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <HistoryState
              icon={<History className="size-5" />}
              title={
                loadFailed
                  ? "暂时无法显示历史"
                  : appliedSearch
                    ? "没有匹配的历史"
                    : "还没有成功记录"
              }
              description={
                loadFailed
                  ? "请点击右上角刷新重试。"
                  : appliedSearch
                    ? "试试压缩包名称或路径中的关键词，或清空搜索查看全部。"
                    : "成功解压后，会在这里保存压缩包原名、密码和文件位置。"
              }
            />
          )}
        </ScrollArea>
        <div className="shrink-0 rounded-xl border border-border/70 bg-card">
          <TablePagination
            label="历史分页"
            itemUnit="组"
            pageIndex={pageIndex}
            pageSize={pageSize}
            totalCount={result?.matchedCount ?? 0}
            busy={busy}
            onPageChange={(nextPage) => {
              void runBusy(async () => {
                await load(appliedSearch, nextPage)
              })
            }}
            onPageSizeChange={(size) => {
              void runBusy(async () => {
                await load(appliedSearch, 0, size)
              })
            }}
          />
        </div>
      </WorkbenchPageContent>

      <AlertDialog
        open={deleteTarget != null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null)
          }
        }}
      >
        <AlertDialogContent size="default">
          <AlertDialogHeader>
            <AlertDialogTitle>删除历史记录</AlertDialogTitle>
            <AlertDialogDescription>
              将删除
              {deleteTarget?.archiveName
                ? `“${deleteTarget.archiveName}”的历史记录`
                : "此条历史记录"}
              和已保存密码，压缩包及解压文件不会被删除。此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={handleDelete}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={clearDialogOpen} onOpenChange={setClearDialogOpen}>
        <AlertDialogContent size="default">
          <AlertDialogHeader>
            <AlertDialogTitle>清空解压历史</AlertDialogTitle>
            <AlertDialogDescription>
              将删除全部解压历史和已保存密码，压缩包及解压文件不会被删除。此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={handleClear}
            >
              清空历史
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </WorkbenchPage>
  )
}

function historyEntryName(entry: RecoveryHistoryEntry) {
  return entry.archiveName || "—"
}

function HistoryLocations({
  entry,
  busy,
  copiedPath,
  onCopy,
  onOpen,
}: {
  entry: RecoveryHistoryEntry
  busy: boolean
  copiedPath: string | null
  onCopy: (path: string) => void
  onOpen: (path: string, kind: "archive" | "output") => void
}) {
  const [expanded, setExpanded] = React.useState(false)
  const locationsId = React.useId()

  if (!entry.archivePath && !entry.outputDirectory) {
    return (
      <div className="flex min-h-28 items-center gap-2 text-xs text-muted-foreground md:min-h-24">
        <FolderOpen aria-hidden className="size-4" />
        文件位置 <span>—</span>
      </div>
    )
  }
  return (
    <div className="min-w-0">
      <dl
        id={locationsId}
        className="relative space-y-1 text-xs before:absolute before:top-5 before:bottom-5 before:left-2 before:w-px before:bg-border"
      >
        {[
          {
            label: "压缩包",
            path: entry.archivePath,
            icon: FileArchive,
            kind: "archive" as const,
            openLabel: "打开压缩包所在文件夹",
          },
          {
            label: "解压到",
            path: entry.outputDirectory,
            icon: FolderOpen,
            kind: "output" as const,
            openLabel: "打开解压目录",
          },
        ].map(({ label, path, icon: Icon, kind, openLabel }) => (
          <div key={label} className="flex min-w-0 items-start gap-2">
            <dt className="flex shrink-0 items-center gap-2 pt-2.5 text-muted-foreground md:pt-2">
              <span className="relative z-10 flex size-4 items-center justify-center bg-card">
                <Icon aria-hidden className="size-3.5" />
              </span>
              {label}
            </dt>
            <dd className="flex min-w-0 flex-1 items-start gap-1">
              <span
                className={cn(
                  "min-w-0 flex-1 py-2.5 md:py-2",
                  expanded ? "wrap-anywhere whitespace-pre-wrap" : "truncate"
                )}
                title={path ?? undefined}
              >
                {path || "—"}
              </span>
              {path ? (
                <>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className="size-9 text-muted-foreground md:size-8"
                    disabled={busy}
                    onClick={() => onOpen(path, kind)}
                    aria-label={openLabel}
                    title={openLabel}
                  >
                    <FolderOpen />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className="size-9 text-muted-foreground md:size-8"
                    disabled={busy}
                    onClick={() => onCopy(path)}
                    aria-label={`复制${label}路径`}
                    title={`复制${label}路径`}
                  >
                    {copiedPath === path ? <Check /> : <Clipboard />}
                  </Button>
                </>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>
      <Button
        size="xs"
        variant="ghost"
        className="mt-1 h-8 gap-1 px-1 text-xs text-muted-foreground md:h-7"
        aria-expanded={expanded}
        aria-controls={locationsId}
        onClick={() => setExpanded((value) => !value)}
      >
        <ChevronDown
          aria-hidden
          className={cn("size-3.5", expanded && "rotate-180")}
        />
        {expanded ? "收起路径" : "展开路径"}
      </Button>
    </div>
  )
}

function HistoryEntry({
  entry,
  revealed,
  copied,
  busy,
  onReveal,
  onCopy,
  onDelete,
  copiedPath,
  onCopyPath,
  onOpenPath,
}: {
  entry: RecoveryHistoryEntry
  revealed: string | null
  copied: boolean
  busy: boolean
  onReveal: () => void
  onCopy: () => void
  onDelete: () => void
  copiedPath: string | null
  onCopyPath: (path: string) => void
  onOpenPath: (path: string, kind: "archive" | "output") => void
}) {
  const titleId = React.useId()

  return (
    <article
      aria-labelledby={titleId}
      className="flex min-w-0 flex-col gap-3 p-4"
    >
      <header className="flex items-start gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
          <FileArchive aria-hidden className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h2
            id={titleId}
            className="line-clamp-2 font-heading text-sm leading-5 font-semibold wrap-anywhere"
            title={entry.archiveName ?? undefined}
          >
            {historyEntryName(entry)}
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <Badge variant="outline" className="rounded-md px-1.5 py-0">
              {entry.archiveFormat}
            </Badge>
            <span>{formatBytes(entry.fileSize)}</span>
            {entry.volumeCount > 1 ? <span>{entry.volumeCount} 卷</span> : null}
            <time
              dateTime={new Date(entry.lastVerifiedAtMs).toISOString()}
              aria-label={`最近解压：${formatDate(entry.lastVerifiedAtMs)}`}
              title="最近解压时间"
              className="inline-flex items-center gap-1.5 tabular-nums"
            >
              <Clock3 aria-hidden className="size-3.5" />
              {formatDate(entry.lastVerifiedAtMs)}
            </time>
          </div>
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          className="text-muted-foreground"
          disabled={busy}
          onClick={onDelete}
          aria-label={
            entry.archiveName
              ? `删除 ${entry.archiveName} 的记录`
              : "删除此条历史记录"
          }
          title="删除记录"
        >
          <Trash2 />
        </Button>
      </header>

      <div className="flex min-w-0 flex-col gap-3 md:flex-row md:items-start md:gap-6 md:pl-11">
        <div className="min-w-0 flex-1">
          <HistoryLocations
            entry={entry}
            busy={busy}
            copiedPath={copiedPath}
            onCopy={onCopyPath}
            onOpen={onOpenPath}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-2 border-t border-border/60 pt-3 md:w-72 md:shrink-0 md:border-t-0 md:border-l md:pt-0 md:pl-5">
          <span className="text-xs text-muted-foreground">解压密码</span>
          <HistoryPassword
            entry={entry}
            revealed={revealed}
            copied={copied}
            busy={busy}
            onReveal={onReveal}
            onCopy={onCopy}
          />
        </div>
      </div>
    </article>
  )
}

function HistoryState({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode
  title: string
  description: string
}) {
  return (
    <Empty className="h-full min-h-56 border-0 px-6 py-10">
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle className="text-sm">{title}</EmptyTitle>
        <EmptyDescription className="max-w-sm text-xs">
          {description}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

function HistoryPassword({
  entry,
  revealed,
  copied,
  busy,
  onReveal,
  onCopy,
}: {
  entry: RecoveryHistoryEntry
  revealed: string | null
  copied: boolean
  busy: boolean
  onReveal: () => void
  onCopy: () => void
}) {
  if (!entry.hasPassword) {
    return (
      <div className="flex min-h-9 items-center text-xs text-muted-foreground">
        <span>—</span>
      </div>
    )
  }

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <code
        className={cn(
          "min-w-0 flex-1 rounded-lg bg-muted/70 px-2.5 py-2 text-sm wrap-anywhere whitespace-pre-wrap",
          !revealed && "tracking-[0.14em] text-muted-foreground"
        )}
        title={revealed ?? undefined}
      >
        {revealed ?? "••••••••"}
      </code>
      <Button
        size="sm"
        variant="ghost"
        className="h-9 px-2 text-xs"
        disabled={busy}
        onClick={onReveal}
        aria-label={revealed ? "隐藏密码" : "查看密码"}
        title={revealed ? "隐藏密码" : "查看密码"}
      >
        {revealed ? <EyeOff /> : <Eye />}
        {revealed ? "隐藏" : "查看"}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-9 px-2 text-xs"
        disabled={busy}
        onClick={onCopy}
        aria-label="复制密码"
        title="复制密码"
      >
        {copied ? <Check /> : <Clipboard />}
        {copied ? "已复制" : "复制"}
      </Button>
    </div>
  )
}

function formatDate(timestamp: number): string {
  return DATE_FORMATTER.format(new Date(timestamp))
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B"
  }
  const units = ["B", "KiB", "MiB", "GiB", "TiB"]
  const exponent = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024))
  )
  const value = bytes / 1024 ** exponent
  return `${value >= 100 || exponent === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[exponent]}`
}

function toErrorMessage(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.message
  }
  if (typeof reason === "string") {
    return reason
  }
  return "历史操作失败，请稍后重试。"
}
