"use client"

import {
  Check,
  ChevronLeft,
  ChevronRight,
  Clipboard,
  Clock3,
  Eye,
  EyeOff,
  Fingerprint,
  History,
  KeyRound,
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
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
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
import {
  Pagination,
  PaginationContent,
  PaginationItem,
} from "@/components/ui/pagination"
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
}

export function HistoryPage() {
  const [result, setResult] = React.useState<RecoveryHistoryListResult | null>(
    null
  )
  const [searchInput, setSearchInput] = React.useState("")
  const [appliedSearch, setAppliedSearch] = React.useState("")
  const [pageIndex, setPageIndex] = React.useState(0)
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [revealed, setRevealed] = React.useState<RevealedPassword | null>(null)
  const [copiedId, setCopiedId] = React.useState<number | null>(null)
  const [deleteTarget, setDeleteTarget] =
    React.useState<RecoveryHistoryEntry | null>(null)
  const [clearDialogOpen, setClearDialogOpen] = React.useState(false)

  const load = React.useCallback(
    async (searchText = appliedSearch, requestedPage = pageIndex) => {
      setError(null)
      try {
        let next = await listRecoveryHistory({
          searchText,
          skip: requestedPage * HISTORY_PAGE_SIZE,
          take: HISTORY_PAGE_SIZE,
        })
        const pageCount = Math.max(
          1,
          Math.ceil(next.matchedCount / HISTORY_PAGE_SIZE)
        )
        const resolvedPage =
          requestedPage >= pageCount && requestedPage > 0
            ? pageCount - 1
            : requestedPage
        if (resolvedPage !== requestedPage) {
          next = await listRecoveryHistory({
            searchText,
            skip: resolvedPage * HISTORY_PAGE_SIZE,
            take: HISTORY_PAGE_SIZE,
          })
        }
        setResult(next)
        setPageIndex(resolvedPage)
        setAppliedSearch(searchText)
        setRevealed(null)
        return next
      } catch (reason) {
        setError(toErrorMessage(reason))
        return null
      }
    },
    [appliedSearch, pageIndex]
  )

  React.useEffect(() => {
    let disposed = false
    void listRecoveryHistory({
      searchText: "",
      skip: 0,
      take: HISTORY_PAGE_SIZE,
    })
      .then((next) => {
        if (!disposed) {
          setResult(next)
        }
      })
      .catch((reason) => {
        if (!disposed) {
          setError(toErrorMessage(reason))
        }
      })
      .finally(() => {
        if (!disposed) {
          setLoading(false)
        }
      })
    return () => {
      disposed = true
    }
  }, [])

  React.useEffect(() => {
    if (!revealed) {
      return
    }
    const timeout = window.setTimeout(() => setRevealed(null), 30_000)
    return () => window.clearTimeout(timeout)
  }, [revealed])

  React.useEffect(() => {
    if (copiedId == null) {
      return
    }
    const timeout = window.setTimeout(() => setCopiedId(null), 1_800)
    return () => window.clearTimeout(timeout)
  }, [copiedId])

  const runBusy = React.useCallback(
    async (action: () => Promise<void>) => {
      if (busy) {
        return
      }
      setBusy(true)
      setError(null)
      setNotice(null)
      try {
        await action()
      } catch (reason) {
        setError(toErrorMessage(reason))
      } finally {
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
      await load()
      setNotice("历史记录已刷新。")
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
        const password = await fetchPassword(entry.id)
        setRevealed({ id: entry.id, value: password })
        setNotice("密码将在 30 秒后自动隐藏。")
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
        await navigator.clipboard.writeText(password)
        setCopiedId(entry.id)
        setNotice("密码已复制到剪贴板。")
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
      await load()
      setNotice(deleted ? "历史记录已删除。" : "该记录已经不存在。")
    })
  }, [deleteTarget, load, runBusy])

  const handleClear = React.useCallback(() => {
    setClearDialogOpen(false)
    void runBusy(async () => {
      const removed = await clearRecoveryHistory()
      setSearchInput("")
      await load("", 0)
      setNotice(`已清空 ${removed} 条历史记录。`)
    })
  }, [load, runBusy])

  const pageCount = Math.max(
    1,
    Math.ceil((result?.matchedCount ?? 0) / HISTORY_PAGE_SIZE)
  )
  const displayedPage = Math.min(pageIndex + 1, pageCount)

  return (
    <WorkbenchPage>
      <WorkbenchPageContent className="gap-2">
        <WorkbenchPageHeader
          eyebrow="Recall"
          title="历史"
          description="按内容指纹归并成功记录，不保存来源文件名或路径"
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
              <Button
                size="sm"
                variant="destructive"
                disabled={busy || (result?.totalCount ?? 0) === 0}
                onClick={() => setClearDialogOpen(true)}
              >
                <Trash2 data-icon="inline-start" />
                清空
              </Button>
            </>
          }
        />

        <Card
          size="sm"
          aria-label="历史概览"
          className="grid shrink-0 grid-cols-3 gap-0 divide-x divide-border/70 py-0 shadow-sm"
        >
          <SummaryMetric
            icon={<History className="size-4" />}
            label="成功归档"
            value={String(result?.totalCount ?? 0)}
            hint="相同内容指纹自动归并"
          />
          <SummaryMetric
            icon={<KeyRound className="size-4" />}
            label="已存密码"
            value={String(result?.passwordCount ?? 0)}
            hint="本机数据库明文保存"
          />
          <SummaryMetric
            icon={<ShieldCheck className="size-4" />}
            label="来源信息"
            value="不记录"
            hint="无文件名、路径和字典内容"
          />
        </Card>

        <Card size="sm" className="shrink-0 gap-0 py-0 shadow-sm">
          <CardContent className="flex items-center gap-2 py-2.5">
            <InputGroup className="h-8 min-w-0 flex-1">
              <InputGroupAddon>
                <Search aria-hidden />
              </InputGroupAddon>
              <InputGroupInput
                type="search"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault()
                    handleSearch()
                  }
                }}
                placeholder="按内容指纹前缀查询"
                disabled={busy}
                className="font-mono text-xs"
              />
            </InputGroup>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={handleSearch}
            >
              查询
            </Button>
          </CardContent>
        </Card>

        <Card
          size="sm"
          className="flex min-h-0 flex-1 flex-col gap-0 overflow-hidden py-0 shadow-sm"
        >
          <Alert
            aria-live="polite"
            variant={error ? "destructive" : "default"}
            className="shrink-0 rounded-none border-x-0 border-t-0 px-3 py-1.5"
          >
            <AlertDescription className="text-[11px]">
              {error ??
                notice ??
                (result
                  ? `匹配 ${result.matchedCount} / ${result.totalCount} 条 · 密码默认遮罩，查看后 30 秒自动隐藏`
                  : "正在读取本机历史…")}
            </AlertDescription>
          </Alert>
          <CardContent className="min-h-0 flex-1 p-0">
            <ScrollArea className="h-full max-h-full [&_[data-slot=table-container]]:overflow-visible">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-card">
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="h-9 min-w-40 px-3 text-xs">
                      内容指纹
                    </TableHead>
                    <TableHead className="h-9 w-16 px-3 text-xs">
                      格式
                    </TableHead>
                    <TableHead className="h-9 w-28 px-3 text-right text-xs">
                      大小 / 分卷
                    </TableHead>
                    <TableHead className="h-9 w-36 px-3 text-xs">
                      首次成功
                    </TableHead>
                    <TableHead className="h-9 w-36 px-3 text-xs">
                      最近验证
                    </TableHead>
                    <TableHead className="h-9 min-w-44 px-3 text-xs">
                      密码
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
                          <div className="flex items-center gap-2">
                            <Fingerprint className="size-3.5 shrink-0 text-muted-foreground" />
                            <div className="min-w-0">
                              <p className="font-mono text-xs">
                                {entry.fingerprintPrefix}…
                              </p>
                              <p className="mt-0.5 text-[10px] text-muted-foreground">
                                已验证 {entry.verificationCount} 次
                              </p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="px-3 py-2.5 text-xs font-medium">
                          {entry.archiveFormat}
                        </TableCell>
                        <TableCell className="px-3 py-2.5 text-right text-xs tabular-nums">
                          <p>{formatBytes(entry.fileSize)}</p>
                          <p className="mt-0.5 text-[10px] text-muted-foreground">
                            {entry.volumeCount} 卷
                          </p>
                        </TableCell>
                        <TableCell className="px-3 py-2.5 text-[11px] text-muted-foreground tabular-nums">
                          {formatDate(entry.firstSuccessAtMs)}
                        </TableCell>
                        <TableCell className="px-3 py-2.5 text-[11px] text-muted-foreground tabular-nums">
                          <span className="inline-flex items-center gap-1">
                            <Clock3 className="size-3" />
                            {formatDate(entry.lastVerifiedAtMs)}
                          </span>
                        </TableCell>
                        <TableCell className="px-3 py-2">
                          <PasswordCell
                            entry={entry}
                            revealed={
                              revealed?.id === entry.id ? revealed.value : null
                            }
                            copied={copiedId === entry.id}
                            busy={busy}
                            onReveal={() => handleReveal(entry)}
                            onCopy={() => handleCopy(entry)}
                          />
                        </TableCell>
                        <TableCell className="px-2 py-2">
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => setDeleteTarget(entry)}
                            aria-label={`删除指纹 ${entry.fingerprintPrefix} 的记录`}
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
                        appliedSearch ? "没有匹配的历史" : "还没有成功记录"
                      }
                      description={
                        appliedSearch
                          ? "请检查指纹前缀，或清空查询后重试。"
                          : "成功解压归档后，会在这里按内容指纹自动归档。"
                      }
                    />
                  )}
                </TableBody>
              </Table>
            </ScrollArea>
          </CardContent>
          <Separator />
          <div className="flex h-10 shrink-0 items-center justify-between px-3">
            <p className="text-xs text-muted-foreground tabular-nums">
              第 {displayedPage} / {pageCount} 页
            </p>
            <Pagination
              aria-label="历史分页"
              className="mx-0 w-auto justify-end"
            >
              <PaginationContent>
                <PaginationItem>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    disabled={busy || pageIndex <= 0}
                    onClick={() =>
                      void runBusy(async () => {
                        await load(appliedSearch, pageIndex - 1)
                      })
                    }
                    aria-label="上一页"
                    title="上一页"
                  >
                    <ChevronLeft />
                  </Button>
                </PaginationItem>
                <PaginationItem>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    disabled={busy || pageIndex + 1 >= pageCount}
                    onClick={() =>
                      void runBusy(async () => {
                        await load(appliedSearch, pageIndex + 1)
                      })
                    }
                    aria-label="下一页"
                    title="下一页"
                  >
                    <ChevronRight />
                  </Button>
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          </div>
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
              将删除指纹 {deleteTarget?.fingerprintPrefix}… 的摘要和已保存密码。
              此操作不可撤销。
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
            <AlertDialogTitle>清空恢复历史</AlertDialogTitle>
            <AlertDialogDescription>
              将删除全部归档摘要和已保存密码。字典候选和运行日志不会受影响，此操作不可撤销。
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

function SummaryMetric({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode
  label: string
  value: string
  hint: string
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5 px-3 py-2.5">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-muted/80 text-muted-foreground">
        {icon}
      </div>
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <p className="shrink-0 text-sm font-semibold tabular-nums">{value}</p>
          <p className="truncate text-[10px] font-medium tracking-wide text-muted-foreground">
            {label}
          </p>
        </div>
        <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
          {hint}
        </p>
      </div>
    </div>
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
    return <span className="text-[11px] text-muted-foreground">未保存</span>
  }

  return (
    <div className="flex min-w-0 items-center gap-1">
      <code
        className={cn(
          "min-w-0 flex-1 truncate rounded-md bg-muted/70 px-2 py-1 text-[11px]",
          !revealed && "tracking-[0.14em] text-muted-foreground"
        )}
        title={revealed ?? undefined}
      >
        {revealed ?? "••••••••"}
      </code>
      <Button
        size="icon-xs"
        variant="ghost"
        disabled={busy}
        onClick={onReveal}
        aria-label={revealed ? "隐藏密码" : "查看密码"}
        title={revealed ? "隐藏密码" : "查看密码"}
      >
        {revealed ? <EyeOff /> : <Eye />}
      </Button>
      <Button
        size="icon-xs"
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
      <TableCell colSpan={7} className="p-0">
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
