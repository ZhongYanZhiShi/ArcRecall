"use client"

import {
  Check,
  Clipboard,
  Eye,
  EyeOff,
  FileArchive,
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
import { Card, CardContent } from "@/components/ui/card"
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
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
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
      <WorkbenchPageContent className="gap-2">
        <WorkbenchPageHeader
          title="历史"
          titleHidden
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

        <Card size="sm" className="shrink-0 gap-0 py-0 shadow-sm">
          <CardContent className="flex items-center gap-2 py-2.5">
            <InputGroup className="h-9 min-w-0 flex-1">
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
                className="text-xs"
              />
            </InputGroup>
            <Button
              size="sm"
              variant="outline"
              className="h-9"
              disabled={busy}
              onClick={handleSearch}
            >
              搜索
            </Button>
          </CardContent>
        </Card>

        <Card
          size="sm"
          className="flex min-h-0 flex-1 flex-col gap-0 overflow-hidden py-0 shadow-sm"
        >
          <CardContent className="min-h-0 flex-1 p-0">
            <div className="hidden h-full md:block">
              <ScrollArea className="table-scroll-fade h-full max-h-full [&_[data-slot=table-container]]:overflow-visible">
                <Table className="table-fixed">
                  <TableHeader className="sticky top-0 z-10 bg-card">
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="h-9 w-1/4 px-3 text-xs">
                        压缩包原名
                      </TableHead>
                      <TableHead className="h-9 w-1/5 px-3 text-xs">
                        解压密码
                      </TableHead>
                      <TableHead className="h-9 px-3 text-xs">
                        最近文件位置
                      </TableHead>
                      <TableHead className="h-9 w-36 px-3 text-xs">
                        最近解压时间
                      </TableHead>
                      <TableHead className="h-9 w-10 px-2">
                        <span className="sr-only">操作</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {loading ? (
                      <StateRow
                        icon={<Spinner />}
                        title="正在读取历史"
                        description="正在查询本机恢复记录。"
                      />
                    ) : result?.entries.length ? (
                      result.entries.map((entry) => (
                        <TableRow key={entry.id}>
                          <TableCell className="px-3 py-2.5">
                            <div className="flex items-start gap-2">
                              <FileArchive
                                aria-hidden
                                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                              />
                              <div className="min-w-0">
                                <p className="text-sm font-medium wrap-anywhere whitespace-normal">
                                  {historyEntryName(entry)}
                                </p>
                                <p className="mt-0.5 text-xs text-muted-foreground">
                                  {entry.archiveFormat} ·{" "}
                                  {formatBytes(entry.fileSize)}
                                  {entry.volumeCount > 1
                                    ? ` · ${entry.volumeCount} 卷`
                                    : ""}
                                </p>
                              </div>
                            </div>
                          </TableCell>
                          <TableCell className="px-3 py-2">
                            <PasswordCell
                              entry={entry}
                              revealed={
                                revealed?.id === entry.id
                                  ? revealed.value
                                  : null
                              }
                              copied={copiedId === entry.id}
                              busy={busy}
                              onReveal={() => handleReveal(entry)}
                              onCopy={() => handleCopy(entry)}
                            />
                          </TableCell>
                          <TableCell className="px-3 py-2.5 whitespace-normal">
                            <HistoryLocations
                              entry={entry}
                              busy={busy}
                              copiedPath={copiedPath}
                              onCopy={handleCopyPath}
                            />
                          </TableCell>
                          <TableCell className="px-3 py-2.5 text-xs text-muted-foreground tabular-nums">
                            {formatDate(entry.lastVerifiedAtMs)}
                          </TableCell>
                          <TableCell className="px-2 py-2">
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => setDeleteTarget(entry)}
                              aria-label={
                                entry.archiveName
                                  ? `删除 ${entry.archiveName} 的记录`
                                  : "删除此条历史记录"
                              }
                              title="删除"
                            >
                              <Trash2 />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))
                    ) : (
                      <StateRow
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
                  </TableBody>
                </Table>
              </ScrollArea>
            </div>
            <div className="h-full scroll-fade overflow-y-auto md:hidden">
              {loading ? (
                <HistoryMobileState
                  icon={<Spinner />}
                  title="正在读取历史"
                  description="正在查询本机恢复记录。"
                />
              ) : result?.entries.length ? (
                <ul className="divide-y divide-border/70">
                  {result.entries.map((entry) => (
                    <li key={entry.id}>
                      <HistoryMobileEntry
                        entry={entry}
                        revealed={
                          revealed?.id === entry.id ? revealed.value : null
                        }
                        copied={copiedId === entry.id}
                        busy={busy}
                        onReveal={() => handleReveal(entry)}
                        onCopy={() => handleCopy(entry)}
                        onDelete={() => setDeleteTarget(entry)}
                        copiedPath={copiedPath}
                        onCopyPath={handleCopyPath}
                      />
                    </li>
                  ))}
                </ul>
              ) : (
                <HistoryMobileState
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
            </div>
          </CardContent>
          <Separator />
          <TablePagination
            label="历史分页"
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
        </Card>
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
}: {
  entry: RecoveryHistoryEntry
  busy: boolean
  copiedPath: string | null
  onCopy: (path: string) => void
}) {
  if (!entry.archivePath && !entry.outputDirectory) {
    return <span className="text-xs text-muted-foreground">—</span>
  }
  return (
    <dl className="space-y-1 text-xs">
      {[
        { label: "压缩包", path: entry.archivePath },
        { label: "解压到", path: entry.outputDirectory },
      ].map(({ label, path }) => (
        <div key={label} className="flex items-start gap-2">
          <dt className="shrink-0 pt-1.5 text-muted-foreground">{label}</dt>
          <dd className="flex min-w-0 flex-1 items-start gap-1">
            <span className="min-w-0 flex-1 pt-1.5 wrap-anywhere">
              {path || "—"}
            </span>
            {path ? (
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={busy}
                onClick={() => onCopy(path)}
                aria-label={`复制${label}路径`}
                title={`复制${label}路径`}
              >
                {copiedPath === path ? <Check /> : <Clipboard />}
              </Button>
            ) : null}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function HistoryMobileEntry({
  entry,
  revealed,
  copied,
  busy,
  onReveal,
  onCopy,
  onDelete,
  copiedPath,
  onCopyPath,
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
}) {
  return (
    <article className="flex flex-col gap-3 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-start gap-1.5 text-sm font-medium">
            <FileArchive
              aria-hidden
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            />
            <span className="wrap-anywhere">{historyEntryName(entry)}</span>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {formatBytes(entry.fileSize)}
            {entry.volumeCount > 1 ? ` · ${entry.volumeCount} 卷` : ""}
          </p>
        </div>
        <Badge variant="outline">{entry.archiveFormat}</Badge>
      </div>

      <p className="text-xs text-muted-foreground">
        最近解压：{formatDate(entry.lastVerifiedAtMs)}
      </p>

      <HistoryLocations
        entry={entry}
        busy={busy}
        copiedPath={copiedPath}
        onCopy={onCopyPath}
      />

      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-xs text-muted-foreground">解压密码</span>
        <code
          className={cn(
            "min-w-0 flex-1 rounded-lg bg-muted/70 px-2.5 py-2 text-xs wrap-anywhere whitespace-pre-wrap",
            !revealed && "tracking-[0.14em] text-muted-foreground"
          )}
          title={revealed ?? undefined}
        >
          {entry.hasPassword ? (revealed ?? "••••••••") : "—"}
        </code>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-11"
          disabled={busy || !entry.hasPassword}
          onClick={onReveal}
        >
          {revealed ? (
            <EyeOff data-icon="inline-start" />
          ) : (
            <Eye data-icon="inline-start" />
          )}
          {revealed ? "隐藏" : "查看"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-11"
          disabled={busy || !entry.hasPassword}
          onClick={onCopy}
        >
          {copied ? (
            <Check data-icon="inline-start" />
          ) : (
            <Clipboard data-icon="inline-start" />
          )}
          {copied ? "已复制" : "复制"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="destructive"
          className="h-11"
          disabled={busy}
          onClick={onDelete}
        >
          <Trash2 data-icon="inline-start" />
          删除
        </Button>
      </div>
    </article>
  )
}

function HistoryMobileState({
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

function PasswordCell({
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
    return <span className="text-xs text-muted-foreground">—</span>
  }

  return (
    <div className="flex min-w-0 items-center gap-1">
      <code
        className={cn(
          "min-w-0 flex-1 rounded-md bg-muted/70 px-2 py-1 text-xs wrap-anywhere whitespace-pre-wrap",
          !revealed && "tracking-[0.14em] text-muted-foreground"
        )}
        title={revealed ?? undefined}
      >
        {revealed ?? "••••••••"}
      </code>
      <Button
        size="icon-sm"
        variant="ghost"
        disabled={busy}
        onClick={onReveal}
        aria-label={revealed ? "隐藏密码" : "查看密码"}
        title={revealed ? "隐藏密码" : "查看密码"}
      >
        {revealed ? <EyeOff /> : <Eye />}
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        disabled={busy}
        onClick={onCopy}
        aria-label="复制密码"
        title="复制密码"
      >
        {copied ? <Check /> : <Clipboard />}
      </Button>
    </div>
  )
}

function StateRow({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode
  title: string
  description: string
}) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={5} className="p-0">
        <Empty className="min-h-56 border-0 px-6 py-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">{icon}</EmptyMedia>
            <EmptyTitle className="text-sm">{title}</EmptyTitle>
            <EmptyDescription className="max-w-sm text-xs">
              {description}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </TableCell>
    </TableRow>
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
