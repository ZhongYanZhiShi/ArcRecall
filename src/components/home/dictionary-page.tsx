"use client"

import {
  Copy,
  Check,
  FileUp,
  Library,
  Plus,
  RefreshCw,
  Search,
  Square,
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
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Field, FieldLabel } from "@/components/ui/field"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { DictionaryGroups } from "./dictionary-groups"
import { listGroup } from "@/lib/workflows"
import { DictionaryTableBody } from "@/components/home/dictionary-table-body"
import { TablePagination } from "@/components/ui/table-pagination"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import {
  DICTIONARY_PAGE_SIZE,
  DictionaryImportError,
  type DictionaryImportProgress,
  type DictionaryCandidateEntry,
  addDictionaryCandidates,
  deleteDictionaryCandidates,
  formatAddStatus,
  importDictionaryFile,
  listDictionary,
} from "@/lib/dictionary"
import { isDesktopRuntime } from "@/lib/runtime"

type StatusTone = "neutral" | "busy" | "ok" | "error"

export function DictionaryPage() {
  const [group, setGroup] = React.useState<string | null>(null)
  const [entries, setEntries] = React.useState<DictionaryCandidateEntry[]>([])
  const [pageIndex, setPageIndex] = React.useState(0)
  const [pageSize, setPageSize] = React.useState(DICTIONARY_PAGE_SIZE)
  const [matchedCount, setMatchedCount] = React.useState(0)
  const [totalCount, setTotalCount] = React.useState<number | null>(null)
  const [searchInput, setSearchInput] = React.useState("")
  const [appliedSearch, setAppliedSearch] = React.useState("")
  const [selectedIds, setSelectedIds] = React.useState<Set<number>>(
    () => new Set()
  )
  const [isBusy, setIsBusy] = React.useState(true)
  const [loadState, setLoadState] = React.useState<
    "loading" | "ready" | "error"
  >("loading")
  const [addFeedback, setAddFeedback] = React.useState("")
  const [copiedId, setCopiedId] = React.useState<number | null>(null)
  const [status, setStatus] = React.useState("解压时自动尝试此处的候选密码。")
  const [statusTone, setStatusTone] = React.useState<StatusTone>("neutral")
  const [addPanelOpen, setAddPanelOpen] = React.useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = React.useState(false)
  const [singleCandidate, setSingleCandidate] = React.useState("")
  const [pastedCandidates, setPastedCandidates] = React.useState("")
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const scrollAreaRef = React.useRef<HTMLDivElement>(null)
  const selectAllRef = React.useRef<HTMLElement>(null)
  const initialLoadStarted = React.useRef(false)
  const operationBusy = React.useRef(false)
  const importController = React.useRef<AbortController | null>(null)
  const [importProgress, setImportProgress] =
    React.useState<DictionaryImportProgress | null>(null)
  const [importCancelling, setImportCancelling] = React.useState(false)
  const importPercent = importProgress
    ? (importProgress.processedBytes / Math.max(1, importProgress.totalBytes)) *
      100
    : 0

  const loadEntries = React.useCallback(
    async (
      searchText: string,
      requestedPageIndex = 0,
      requestedPageSize = pageSize,
      requestedGroup = group
    ) => {
      setLoadState("loading")
      try {
        const fetchPage = (nextPageIndex: number) =>
          (requestedGroup
            ? (query: Parameters<typeof listDictionary>[0]) =>
                listGroup(requestedGroup, query ?? {})
            : listDictionary)({
            searchText,
            skip: nextPageIndex * requestedPageSize,
            take: requestedPageSize,
          })

        let resolvedPageIndex = Math.max(0, requestedPageIndex)
        let result = await fetchPage(resolvedPageIndex)
        const lastPageIndex = Math.max(
          0,
          Math.ceil(result.matchedCount / requestedPageSize) - 1
        )

        if (resolvedPageIndex > lastPageIndex) {
          resolvedPageIndex = lastPageIndex
          result = await fetchPage(resolvedPageIndex)
        }

        setEntries(result.entries)
        setTotalCount(result.totalCount)
        setAppliedSearch(searchText)
        setLoadState("ready")
        setMatchedCount(result.matchedCount)
        setPageIndex(resolvedPageIndex)
        setPageSize(requestedPageSize)
        setSelectedIds((prev) => {
          const visible = new Set(result.entries.map((e) => e.id))
          const next = new Set<number>()
          for (const id of prev) {
            if (visible.has(id)) {
              next.add(id)
            }
          }
          return next
        })
        const viewport = scrollAreaRef.current?.querySelector<HTMLElement>(
          '[data-slot="scroll-area-viewport"]'
        )
        if (viewport) {
          viewport.scrollTop = 0
        }
        return { ...result, pageIndex: resolvedPageIndex }
      } catch (error) {
        setLoadState("error")
        throw error
      }
    },
    [pageSize, group]
  )

  const runBusy = React.useCallback(
    async (
      workingMessage: string,
      operation: () => Promise<void>,
      inAddPanel = false
    ) => {
      if (isBusy || operationBusy.current) {
        return
      }
      operationBusy.current = true
      setIsBusy(true)
      setStatusTone("busy")
      setStatus(workingMessage)
      if (inAddPanel) setAddFeedback(workingMessage)
      try {
        await operation()
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error ?? "未知错误")
        if (inAddPanel) {
          setStatusTone("error")
          setAddFeedback(`添加失败：${message}。输入内容已保留，可重试。`)
        }
        if (!inAddPanel) {
          toast.error(`操作失败：${message}`, {
            id: "dictionary-action",
            duration: 6_000,
          })
        }
      } finally {
        setStatus("")
        operationBusy.current = false
        setIsBusy(false)
      }
    },
    [isBusy]
  )

  React.useEffect(() => {
    if (initialLoadStarted.current) {
      return
    }
    initialLoadStarted.current = true
    void (async () => {
      setIsBusy(true)
      setStatusTone("busy")
      setStatus("正在加载候选…")
      try {
        await loadEntries("")
        setStatusTone("ok")
        setStatus("")
      } catch (error) {
        initialLoadStarted.current = false
        const message =
          error instanceof Error ? error.message : String(error ?? "未知错误")
        if (!isDesktopRuntime()) {
          setStatusTone("neutral")
          setStatus("")
          toast.info("预览字典刷新后清空；桌面端自动保存。", {
            id: "dictionary-action",
            duration: 4_000,
          })
        } else {
          setStatusTone("error")
          setStatus("")
          toast.error(`加载失败：${message}`, {
            id: "dictionary-action",
            duration: 6_000,
          })
        }
      } finally {
        setIsBusy(false)
      }
    })()
  }, [loadEntries])

  const handleRefresh = () => {
    void runBusy("正在刷新候选…", async () => {
      const result = await loadEntries(appliedSearch, pageIndex)
      toast.success(
        formatLoadStatus(
          "刷新完成",
          result.totalCount,
          result.matchedCount,
          appliedSearch
        ),
        { id: "dictionary-action", duration: 4_000 }
      )
    })
  }

  const handleSearch = (searchText = searchInput) => {
    void runBusy("正在查询候选…", async () => {
      const result = await loadEntries(searchText, 0)
      toast.info(
        formatLoadStatus(
          "查询完成",
          result.totalCount,
          result.matchedCount,
          searchText
        ),
        { id: "dictionary-action", duration: 4_000 }
      )
    })
  }

  const clearSearch = () => {
    setSearchInput("")
    handleSearch("")
  }

  const openAddPanel = () => {
    setAddFeedback("")
    setAddPanelOpen(true)
  }

  const finishAdding = async (message: string) => {
    // Writes may succeed even when refreshing the list fails. Keep the result.
    let feedback = message
    let tone: StatusTone = "ok"
    try {
      const result = await loadEntries(appliedSearch, pageIndex)
      feedback += ` 全局共 ${result.totalCount} 条。`
    } catch {
      feedback += " 列表刷新失败，请刷新列表查看已添加的候选。"
      tone = "error"
    }
    // Keep the result in the fixed drawer footer so the next focused field stays clear.
    toast.dismiss("dictionary-action")
    setStatusTone(tone)
    setAddFeedback(feedback)
  }

  const handleDeleteConfirm = () => {
    if (selectedIds.size === 0) {
      return
    }
    const count = selectedIds.size
    void runBusy("正在删除候选…", async () => {
      const ids = [...selectedIds]
      await deleteDictionaryCandidates(ids)
      setDeleteDialogOpen(false)
      setSelectedIds(new Set())
      const result = await loadEntries(appliedSearch, pageIndex)
      toast.success(
        `已删除 ${count} 个候选。全局字典候选共 ${result.totalCount} 条。`,
        { id: "dictionary-action", duration: 4_000 }
      )
    })
  }

  const handleImportFile = (file: File | null) => {
    if (!file) {
      return
    }
    void runBusy("正在导入候选…", async () => {
      const controller = new AbortController()
      importController.current = controller
      setImportCancelling(false)
      setAddPanelOpen(false)
      let lastProgressAt = 0
      let lastPhase = ""
      let lastEncoding = ""
      let message: string
      let tone: StatusTone
      try {
        const summary = await importDictionaryFile(file, {
          group,
          signal: controller.signal,
          onProgress: (progress) => {
            const now = Date.now()
            if (
              now - lastProgressAt >= 100 ||
              progress.phase !== lastPhase ||
              progress.encoding !== lastEncoding ||
              progress.processedBytes === progress.totalBytes
            ) {
              lastProgressAt = now
              lastPhase = progress.phase
              lastEncoding = progress.encoding
              setImportProgress(progress)
            }
          },
        })
        message = formatAddStatus("导入完成", summary)
        tone = "ok"
      } catch (error) {
        if (error instanceof DictionaryImportError) {
          tone = error.cancelled ? "neutral" : "error"
          message = `${error.message} ${formatAddStatus("本次已处理", error.summary)}`
        } else {
          tone = "error"
          message = `导入失败：${error instanceof Error ? error.message : String(error)}`
        }
      } finally {
        importController.current = null
        setImportProgress(null)
        setImportCancelling(false)
      }
      // Cancellation or a later IPC error may leave committed batches.
      try {
        const result = await loadEntries(appliedSearch, pageIndex)
        message += ` 全局共 ${result.totalCount} 条。`
      } catch {
        message += " 列表刷新失败，请点击刷新查看已导入的候选。"
        tone = "error"
      }
      if (tone === "error") {
        toast.error(message, { id: "dictionary-action", duration: 6_000 })
      } else if (tone === "neutral") {
        toast.info(message, { id: "dictionary-action", duration: 6_000 })
      } else {
        toast.success(message, { id: "dictionary-action", duration: 6_000 })
      }
    })
  }

  const handleAddSingle = () => {
    if (singleCandidate.length === 0 || isBusy) {
      return
    }
    void runBusy(
      "正在添加候选…",
      async () => {
        const summary = await addDictionaryCandidates([singleCandidate], group)
        setSingleCandidate("")
        await finishAdding(formatAddStatus("单条新增完成", summary))
      },
      true
    )
  }

  const handleAddPasted = () => {
    if (pastedCandidates.length === 0 || isBusy) {
      return
    }
    void runBusy(
      "正在批量添加候选…",
      async () => {
        const candidates = splitLines(pastedCandidates)
        const summary = await addDictionaryCandidates(candidates, group)
        setPastedCandidates("")
        await finishAdding(formatAddStatus("批量新增完成", summary))
      },
      true
    )
  }

  const toggleSelect = (id: number, checked: boolean) => {
    if (isBusy || operationBusy.current) return
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (checked) {
        next.add(id)
      } else {
        next.delete(id)
      }
      return next
    })
  }

  const toggleSelectAllVisible = (checked: boolean) => {
    setSelectedIds((prev) => {
      if (entries.length === 0) {
        return prev
      }
      if (!checked) {
        const next = new Set(prev)
        for (const e of entries) {
          next.delete(e.id)
        }
        return next
      }
      const next = new Set(prev)
      for (const e of entries) {
        next.add(e.id)
      }
      return next
    })
  }

  const isEmpty = entries.length === 0
  const selectedVisibleCount = entries.filter((e) =>
    selectedIds.has(e.id)
  ).length
  const allVisibleSelected =
    entries.length > 0 && selectedVisibleCount === entries.length
  const someVisibleSelected =
    selectedVisibleCount > 0 && selectedVisibleCount < entries.length
  const pageCount = Math.ceil(matchedCount / pageSize)

  const handlePageChange = (nextPageIndex: number) => {
    if (
      isBusy ||
      nextPageIndex < 0 ||
      nextPageIndex >= pageCount ||
      nextPageIndex === pageIndex
    ) {
      return
    }
    void runBusy(`正在加载第 ${nextPageIndex + 1} 页…`, async () => {
      await loadEntries(appliedSearch, nextPageIndex)
      setStatusTone("ok")
      setStatus("")
    })
  }

  const handlePageSizeChange = (size: number) => {
    if (!Number.isSafeInteger(size) || size < 1) return
    void runBusy("正在加载候选…", async () => {
      await loadEntries(appliedSearch, 0, size)
      setStatusTone("ok")
      setStatus("")
    })
  }

  return (
    <WorkbenchPage data-workbench="dictionary">
      <WorkbenchPageContent className="gap-2">
        <WorkbenchPageHeader
          title="字典"
          description={
            totalCount === null
              ? "正在读取本机候选密码…"
              : `${new Intl.NumberFormat("zh-CN").format(totalCount)} 条 · 本机 · 解压时自动尝试这些候选密码。`
          }
          actions={
            <>
              <Button size="sm" disabled={isBusy} onClick={openAddPanel}>
                <Plus data-icon="inline-start" />
                添加密码
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={isBusy}
                onClick={() => fileInputRef.current?.click()}
              >
                <FileUp />
                导入字典
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={isBusy}
                onClick={handleRefresh}
              >
                <RefreshCw data-icon="inline-start" />
                刷新
              </Button>
            </>
          }
        />

        <DictionaryGroups
          value={group}
          ids={[...selectedIds]}
          disabled={isBusy}
          onChange={(next) => {
            setGroup(next)
            setSelectedIds(new Set())
            void runBusy("正在读取分组…", async () => {
              await loadEntries(appliedSearch, 0, pageSize, next)
            })
          }}
        />
        {importProgress ? (
          <Card size="sm" className="shrink-0 gap-2">
            <CardContent className="flex items-center gap-3">
              <div className="min-w-0 flex-1 space-y-2">
                <p className="text-xs" role="status">
                  {importProgress.phase === "validating"
                    ? `正在预检编码（${importProgress.encoding}）`
                    : "正在导入候选"}
                  {" · "}
                  {Math.round(importPercent)}%{" · "}新增{" "}
                  {importProgress.summary.addedCount} 条，重复{" "}
                  {importProgress.summary.duplicateCount} 条
                </p>
                <Progress
                  value={importPercent}
                  aria-label={
                    importProgress.phase === "validating"
                      ? "字典编码预检进度"
                      : "字典读取进度"
                  }
                />
                <p className="text-xs text-muted-foreground">
                  取消后保留已导入的候选。
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={importCancelling}
                onClick={() => {
                  setImportCancelling(true)
                  importController.current?.abort()
                }}
              >
                <Square data-icon="inline-start" />
                {importCancelling ? "正在取消" : "取消导入"}
              </Button>
            </CardContent>
          </Card>
        ) : null}

        <Card
          size="sm"
          className="shrink-0 gap-0 py-0 shadow-sm ring-border/60"
        >
          <CardContent className="flex items-center gap-2 px-0 py-2.5">
            {selectedIds.size > 0 ? (
              <div
                role="group"
                aria-label="所选候选操作"
                className="flex h-9 w-full items-center justify-between gap-2"
              >
                <span
                  role="status"
                  className="shrink-0 text-xs font-medium tabular-nums"
                >
                  已选 {selectedIds.size} 项
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={isBusy}
                    onClick={() => setDeleteDialogOpen(true)}
                  >
                    <Trash2 data-icon="inline-start" />
                    删除所选
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={isBusy}
                    onClick={() => {
                      setSelectedIds(new Set())
                      selectAllRef.current?.focus()
                    }}
                  >
                    取消选择
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <InputGroup className="h-9 min-w-0 flex-1">
                  <InputGroupAddon>
                    <Search aria-hidden />
                  </InputGroupAddon>
                  <InputGroupInput
                    type="search"
                    aria-label="搜索字典候选"
                    value={searchInput}
                    onChange={(event) => setSearchInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault()
                        handleSearch()
                      }
                    }}
                    placeholder="按明文搜索候选"
                    disabled={isBusy}
                    className="text-xs"
                  />
                </InputGroup>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-9 shrink-0"
                  disabled={isBusy}
                  onClick={() => handleSearch()}
                >
                  查询
                </Button>
              </>
            )}
          </CardContent>
        </Card>

        {appliedSearch ? (
          <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
            <p className="min-w-0 flex-1 break-all">
              当前查询：{appliedSearch} · 匹配 {matchedCount} 条
            </p>
            <Button
              size="sm"
              variant="ghost"
              disabled={isBusy}
              onClick={clearSearch}
            >
              清除搜索
            </Button>
          </div>
        ) : null}

        <Card
          size="sm"
          className="flex min-h-0 flex-1 flex-col gap-0 overflow-hidden rounded-xl py-0 shadow-sm ring-border/60"
        >
          <CardContent className="min-h-0 flex-1 p-0">
            <ScrollArea
              ref={scrollAreaRef}
              className="table-scroll-fade h-full max-h-full [&_[data-slot=table-container]]:overflow-visible"
            >
              <Table
                className="byte-dictionary-table"
                aria-rowcount={entries.length + 1}
              >
                <TableHeader className="sticky top-0 z-10 bg-card">
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="h-9 w-10 px-3">
                      <Checkbox
                        ref={selectAllRef}
                        checked={allVisibleSelected}
                        indeterminate={someVisibleSelected}
                        disabled={isEmpty || isBusy}
                        onCheckedChange={(checked) =>
                          toggleSelectAllVisible(checked === true)
                        }
                        aria-label="全选当前列表"
                      />
                    </TableHead>
                    <TableHead className="h-9 px-3 text-xs">
                      密码（点击复制）
                    </TableHead>
                    <TableHead className="h-9 w-24 px-3 text-right text-xs">
                      长度
                    </TableHead>
                    <TableHead className="h-9 w-16 px-3 text-right text-xs">
                      成功次数
                    </TableHead>
                  </TableRow>
                </TableHeader>
                {isEmpty ? (
                  <TableBody>
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={4} className="p-0">
                        <Empty className="min-h-[220px] border-0 px-6 py-10">
                          <EmptyHeader>
                            <EmptyMedia variant="icon">
                              {loadState === "loading" ? (
                                <Spinner />
                              ) : (
                                <Library />
                              )}
                            </EmptyMedia>
                            <EmptyTitle className="text-sm">
                              {loadState === "loading"
                                ? "正在加载候选…"
                                : loadState === "error"
                                  ? "候选加载失败"
                                  : appliedSearch
                                    ? "没有匹配的候选"
                                    : "字典还是空的"}
                            </EmptyTitle>
                            <EmptyDescription className="max-w-xs text-xs">
                              {loadState === "loading"
                                ? "请稍候。"
                                : loadState === "error"
                                  ? "请点击刷新列表重试。"
                                  : appliedSearch
                                    ? "试试其他关键词，或清除搜索查看全部候选。"
                                    : "导入文件或添加密码，重复项自动跳过。"}
                            </EmptyDescription>
                          </EmptyHeader>
                          {loadState !== "loading" ? (
                            <EmptyContent>
                              <Button
                                size="sm"
                                disabled={isBusy}
                                onClick={
                                  loadState === "error"
                                    ? handleRefresh
                                    : appliedSearch
                                      ? clearSearch
                                      : openAddPanel
                                }
                              >
                                {loadState === "error"
                                  ? "重试加载"
                                  : appliedSearch
                                    ? "显示全部候选"
                                    : "添加候选"}
                              </Button>
                            </EmptyContent>
                          ) : null}
                        </Empty>
                      </TableCell>
                    </TableRow>
                  </TableBody>
                ) : (
                  <DictionaryTableBody
                    count={entries.length}
                    scrollAreaRef={scrollAreaRef}
                  >
                    {(index) => {
                      const entry = entries[index]
                      const selected = selectedIds.has(entry.id)
                      return (
                        <TableRow
                          key={entry.id}
                          data-dictionary-index={index}
                          aria-rowindex={index + 2}
                          data-state={selected ? "selected" : undefined}
                          aria-disabled={isBusy || undefined}
                          className={isBusy ? undefined : "cursor-pointer"}
                          onClick={() => toggleSelect(entry.id, !selected)}
                        >
                          <TableCell className="w-10 px-3 py-2">
                            <Checkbox
                              onClick={(event) => event.stopPropagation()}
                              checked={selected}
                              disabled={isBusy}
                              onCheckedChange={(checked) =>
                                toggleSelect(entry.id, checked === true)
                              }
                              aria-label={`选择候选 #${entry.id}`}
                            />
                          </TableCell>
                          <TableCell className="max-w-0 px-3 py-2">
                            <button
                              type="button"
                              disabled={isBusy}
                              className="inline-flex max-w-full cursor-copy items-center gap-2 rounded-sm py-1 text-left font-mono text-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-default disabled:opacity-50"
                              aria-label={`复制候选 #${entry.id} 的完整密码`}
                              title="点击复制完整密码"
                              onClick={async (event) => {
                                event.stopPropagation()
                                setCopiedId(null)
                                try {
                                  await navigator.clipboard.writeText(
                                    entry.value
                                  )
                                  setCopiedId(entry.id)
                                  toast.success("密码已复制", {
                                    id: "dictionary-copy",
                                  })
                                } catch {
                                  toast.error(
                                    "复制失败，请检查剪贴板权限后重试。",
                                    { id: "dictionary-copy", duration: 6_000 }
                                  )
                                }
                              }}
                            >
                              <span className="min-w-0 truncate">
                                {entry.value}
                              </span>
                              {copiedId === entry.id ? (
                                <Check
                                  className="size-3 shrink-0"
                                  aria-label="已复制"
                                />
                              ) : (
                                <Copy
                                  className="size-3 shrink-0 text-muted-foreground"
                                  aria-hidden
                                />
                              )}
                            </button>
                          </TableCell>
                          <TableCell className="px-3 py-2 text-right text-xs text-muted-foreground tabular-nums">
                            <span title={`字节数：${entry.byteCount}`}>
                              {entry.byteCount} B
                            </span>
                          </TableCell>
                          <TableCell className="px-3 py-2 text-right text-xs text-muted-foreground tabular-nums">
                            <span
                              title={`成功次数：${entry.successCount}`}
                              className="inline-flex items-center gap-0.5"
                            >
                              <Check className="size-3" aria-hidden />
                              {entry.successCount}
                            </span>
                          </TableCell>
                        </TableRow>
                      )
                    }}
                  </DictionaryTableBody>
                )}
              </Table>
            </ScrollArea>
          </CardContent>
          <Separator />
          {status ? (
            <div className="max-h-28 shrink-0 overflow-y-auto border-b px-3 py-2">
              <p
                role="status"
                aria-live={addPanelOpen ? "off" : "polite"}
                className={`flex items-start gap-2 text-xs break-all whitespace-pre-wrap ${statusTone === "error" ? "text-destructive" : "text-muted-foreground"}`}
              >
                {statusTone === "busy" ? (
                  <Spinner className="mt-0.5 size-3 shrink-0" />
                ) : null}
                {status}
              </p>
              {statusTone === "error" ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2"
                  disabled={isBusy}
                  onClick={handleRefresh}
                >
                  刷新列表
                </Button>
              ) : null}
            </div>
          ) : null}
          {matchedCount > 0 ? (
            <TablePagination
              label="字典分页"
              pageIndex={pageIndex}
              pageSize={pageSize}
              totalCount={matchedCount}
              busy={isBusy}
              onPageChange={handlePageChange}
              onPageSizeChange={handlePageSizeChange}
            />
          ) : null}
        </Card>
      </WorkbenchPageContent>

      <input
        ref={fileInputRef}
        type="file"
        accept=".txt,.dic,.lst,text/plain"
        className="sr-only"
        tabIndex={-1}
        aria-label="导入候选字典文件"
        disabled={isBusy}
        onChange={(event) => {
          const file = event.target.files?.[0] ?? null
          event.target.value = ""
          handleImportFile(file)
        }}
      />
      {/* 添加候选：右侧抽屉，保留字典列表上下文 */}
      <Sheet open={addPanelOpen} onOpenChange={setAddPanelOpen}>
        <SheetContent
          side="right"
          showCloseButton
          className="workbench-details-panel gap-0 p-0"
        >
          <SheetHeader className="shrink-0 border-b border-border/80 p-4 pr-12">
            <SheetTitle>添加密码</SheetTitle>
            <SheetDescription>
              每行一个密码，重复项不重复保存。
              {group ? `本次添加到「${group}」分组。` : "本次添加到全部字典。"}
            </SheetDescription>
          </SheetHeader>

          <div className="workbench-details-body dictionary-add-body flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 [&>*]:shrink-0">
            <Card size="sm" className="drawer-section gap-0">
              <CardHeader className="flex flex-row items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <CardTitle className="text-sm">批量导入</CardTitle>
                  <CardDescription className="text-xs">
                    自动识别编码，不保存文件路径
                  </CardDescription>
                </div>
                <Button
                  size="sm"
                  className="shrink-0"
                  disabled={isBusy}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <FileUp data-icon="inline-start" />
                  选择文件
                </Button>
              </CardHeader>
            </Card>

            <Separator />

            <Field>
              <FieldLabel
                htmlFor="dict-single"
                className="text-xs text-muted-foreground"
              >
                新增单条
              </FieldLabel>
              <InputGroup>
                <InputGroupInput
                  id="dict-single"
                  type="text"
                  value={singleCandidate}
                  onChange={(event) => setSingleCandidate(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault()
                      handleAddSingle()
                    }
                  }}
                  disabled={isBusy}
                  placeholder="输入一条候选密码"
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupButton
                    variant="outline"
                    disabled={isBusy || singleCandidate.length === 0}
                    onClick={handleAddSingle}
                  >
                    添加
                  </InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
            </Field>

            <Field className="dictionary-paste-field">
              <FieldLabel
                htmlFor="dict-paste"
                className="text-xs text-muted-foreground"
              >
                粘贴多行
              </FieldLabel>
              <Textarea
                id="dict-paste"
                value={pastedCandidates}
                onChange={(event) => setPastedCandidates(event.target.value)}
                disabled={isBusy}
                rows={6}
                placeholder={"每行一条\n例如：\npassword1\npassword2"}
                className="rounded-xl font-mono text-xs"
              />
            </Field>
          </div>
          <div
            data-slot="dictionary-add-footer"
            className="shrink-0 border-t bg-background p-4"
          >
            {addFeedback ? (
              <div className="mb-3 max-h-20 overflow-y-auto">
                <p
                  role="status"
                  className={`text-sm break-all whitespace-pre-wrap ${statusTone === "error" ? "text-destructive" : "text-muted-foreground"}`}
                >
                  {addFeedback}
                </p>
                {loadState === "error" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2"
                    disabled={isBusy}
                    onClick={() => {
                      setAddPanelOpen(false)
                      handleRefresh()
                    }}
                  >
                    刷新列表
                  </Button>
                ) : null}
              </div>
            ) : null}
            <div className="flex justify-end">
              <Button
                size="sm"
                disabled={isBusy || pastedCandidates.length === 0}
                onClick={handleAddPasted}
                aria-busy={isBusy && addFeedback.startsWith("正在批量")}
              >
                {isBusy && addFeedback.startsWith("正在批量")
                  ? "添加中…"
                  : "添加多行"}
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      {/* 删除确认 */}
      <AlertDialog
        open={deleteDialogOpen}
        onOpenChange={(open) => {
          if (!operationBusy.current) setDeleteDialogOpen(open)
        }}
      >
        <AlertDialogContent size="default">
          <AlertDialogHeader>
            <AlertDialogTitle>删除候选</AlertDialogTitle>
            <AlertDialogDescription>
              确认从全部字典和所有分组删除选中的 {selectedIds.size}{" "}
              个候选？此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isBusy}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={isBusy || selectedIds.size === 0}
              onClick={handleDeleteConfirm}
            >
              {isBusy ? "删除中…" : "删除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </WorkbenchPage>
  )
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/)
}

function formatLoadStatus(
  prefix: string,
  totalCount: number,
  matchedCount: number,
  searchText: string
): string {
  const searchSuffix =
    searchText.length === 0 ? "" : `，当前查询共匹配 ${matchedCount} 条`
  return `${prefix}：全局字典候选共 ${totalCount} 条${searchSuffix}。`
}
