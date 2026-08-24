"use client"

import {
  ChevronLeft,
  ChevronRight,
  FileUp,
  Library,
  Plus,
  RefreshCw,
  Search,
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
import {
  Pagination,
  PaginationContent,
  PaginationItem,
} from "@/components/ui/pagination"
import { ScrollArea } from "@/components/ui/scroll-area"
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
  type DictionaryCandidateEntry,
  addDictionaryCandidates,
  deleteDictionaryCandidates,
  formatAddStatus,
  importDictionaryFile,
  isDesktopRuntime,
  listDictionary,
} from "@/lib/dictionary"

type StatusTone = "neutral" | "busy" | "ok" | "error"

export function DictionaryPage() {
  const [entries, setEntries] = React.useState<DictionaryCandidateEntry[]>([])
  const [pageIndex, setPageIndex] = React.useState(0)
  const [matchedCount, setMatchedCount] = React.useState(0)
  const [searchInput, setSearchInput] = React.useState("")
  const [appliedSearch, setAppliedSearch] = React.useState("")
  const [selectedIds, setSelectedIds] = React.useState<Set<number>>(
    () => new Set()
  )
  const [isBusy, setIsBusy] = React.useState(false)
  const [status, setStatus] = React.useState(
    "导入候选后，解压 / 验密流程会直接使用这份全局字典。"
  )
  const [statusTone, setStatusTone] = React.useState<StatusTone>("neutral")
  const [addPanelOpen, setAddPanelOpen] = React.useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = React.useState(false)
  const [singleCandidate, setSingleCandidate] = React.useState("")
  const [pastedCandidates, setPastedCandidates] = React.useState("")
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const scrollAreaRef = React.useRef<HTMLDivElement>(null)
  const initialLoadStarted = React.useRef(false)

  const loadEntries = React.useCallback(
    async (searchText: string, requestedPageIndex = 0) => {
      const fetchPage = (nextPageIndex: number) =>
        listDictionary({
          searchText,
          skip: nextPageIndex * DICTIONARY_PAGE_SIZE,
          take: DICTIONARY_PAGE_SIZE,
        })

      let resolvedPageIndex = Math.max(0, requestedPageIndex)
      let result = await fetchPage(resolvedPageIndex)
      const lastPageIndex = Math.max(
        0,
        Math.ceil(result.matchedCount / DICTIONARY_PAGE_SIZE) - 1
      )

      if (resolvedPageIndex > lastPageIndex) {
        resolvedPageIndex = lastPageIndex
        result = await fetchPage(resolvedPageIndex)
      }

      setEntries(result.entries)
      setMatchedCount(result.matchedCount)
      setPageIndex(resolvedPageIndex)
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
    },
    []
  )

  const runBusy = React.useCallback(
    async (workingMessage: string, operation: () => Promise<void>) => {
      if (isBusy) {
        return
      }
      setIsBusy(true)
      setStatusTone("busy")
      setStatus(workingMessage)
      try {
        await operation()
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error ?? "未知错误")
        setStatusTone("error")
        setStatus(`操作失败：${message}`)
      } finally {
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
        const result = await loadEntries("")
        setStatusTone("ok")
        setStatus(`共 ${result.totalCount} 条`)
      } catch (error) {
        initialLoadStarted.current = false
        const message =
          error instanceof Error ? error.message : String(error ?? "未知错误")
        if (!isDesktopRuntime()) {
          setStatusTone("neutral")
          setStatus(
            "浏览器预览使用内存字典（刷新即清空）；桌面端写入本机 SQLite。"
          )
        } else {
          setStatusTone("error")
          setStatus(`加载失败：${message}`)
        }
      } finally {
        setIsBusy(false)
      }
    })()
  }, [loadEntries])

  const handleRefresh = () => {
    void runBusy("正在刷新候选…", async () => {
      const result = await loadEntries(appliedSearch, pageIndex)
      setStatusTone("ok")
      setStatus(
        formatLoadStatus(
          "刷新完成",
          result.totalCount,
          result.entries.length,
          appliedSearch
        )
      )
    })
  }

  const handleSearch = () => {
    void runBusy("正在查询候选…", async () => {
      setAppliedSearch(searchInput)
      const result = await loadEntries(searchInput, 0)
      setStatusTone("ok")
      setStatus(
        formatLoadStatus(
          "查询完成",
          result.totalCount,
          result.entries.length,
          searchInput
        )
      )
    })
  }

  const handleDeleteConfirm = () => {
    if (selectedIds.size === 0) {
      return
    }
    const count = selectedIds.size
    setDeleteDialogOpen(false)
    void runBusy("正在删除候选…", async () => {
      const ids = [...selectedIds]
      await deleteDictionaryCandidates(ids)
      setSelectedIds(new Set())
      const result = await loadEntries(appliedSearch, pageIndex)
      setStatusTone("ok")
      setStatus(
        `已删除 ${count} 个候选。全局字典候选共 ${result.totalCount} 条。`
      )
    })
  }

  const handleImportFile = (file: File | null) => {
    if (!file) {
      return
    }
    void runBusy("正在导入候选…", async () => {
      try {
        const summary = await importDictionaryFile(file)
        const result = await loadEntries(appliedSearch, pageIndex)
        setStatusTone("ok")
        setStatus(
          `${formatAddStatus("导入完成", summary)} 全局共 ${result.totalCount} 条。`
        )
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error ?? "未知错误")
        setStatusTone("error")
        setStatus(`导入失败：${message}`)
      }
    })
  }

  const handleAddSingle = () => {
    if (singleCandidate.length === 0 || isBusy) {
      return
    }
    void runBusy("正在添加候选…", async () => {
      const summary = await addDictionaryCandidates([singleCandidate])
      setSingleCandidate("")
      const result = await loadEntries(appliedSearch, pageIndex)
      setStatusTone("ok")
      setStatus(
        `${formatAddStatus("单条新增完成", summary)} 全局共 ${result.totalCount} 条。`
      )
    })
  }

  const handleAddPasted = () => {
    if (pastedCandidates.length === 0 || isBusy) {
      return
    }
    void runBusy("正在添加候选…", async () => {
      const candidates = splitLines(pastedCandidates)
      const summary = await addDictionaryCandidates(candidates)
      setPastedCandidates("")
      const result = await loadEntries(appliedSearch, pageIndex)
      setStatusTone("ok")
      setStatus(
        `${formatAddStatus("批量新增完成", summary)} 全局共 ${result.totalCount} 条。`
      )
    })
  }

  const toggleSelect = (id: number, checked: boolean) => {
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
  const pageCount = Math.ceil(matchedCount / DICTIONARY_PAGE_SIZE)
  const displayedPage = pageCount === 0 ? 0 : pageIndex + 1
  const hasPreviousPage = pageIndex > 0
  const hasNextPage = pageIndex + 1 < pageCount

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
      const result = await loadEntries(appliedSearch, nextPageIndex)
      setStatusTone("ok")
      setStatus(
        `第 ${result.pageIndex + 1} 页加载完成。全局字典候选共 ${result.totalCount} 条。`
      )
    })
  }

  return (
    <WorkbenchPage>
      <WorkbenchPageContent className="gap-2">
        <WorkbenchPageHeader
          title="字典"
          description="管理本机全局密码候选集 · 解压验密直接读取此处"
          actions={
            <>
              <Button
                size="sm"
                disabled={isBusy}
                onClick={() => setAddPanelOpen(true)}
              >
                <Plus data-icon="inline-start" />
                添加
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
              <Button
                size="sm"
                variant="outline"
                disabled={isBusy || selectedIds.size === 0}
                onClick={() => setDeleteDialogOpen(true)}
              >
                <Trash2 data-icon="inline-start" />
                删除
              </Button>
            </>
          }
        />

        <Card
          size="sm"
          className="shrink-0 gap-0 py-0 shadow-sm ring-border/60"
        >
          <CardContent className="flex items-center gap-2 py-2.5">
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
              onClick={handleSearch}
            >
              查询
            </Button>
          </CardContent>
        </Card>

        <Card
          size="sm"
          className="flex min-h-0 flex-1 flex-col gap-0 overflow-hidden rounded-xl py-0 shadow-sm ring-border/60"
        >
          <CardContent className="min-h-0 flex-1 p-0">
            <ScrollArea
              ref={scrollAreaRef}
              className="h-full max-h-full [&_[data-slot=table-container]]:overflow-visible"
            >
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-card">
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="h-9 w-10 px-3">
                      <Checkbox
                        checked={allVisibleSelected}
                        indeterminate={someVisibleSelected}
                        disabled={isEmpty || isBusy}
                        onCheckedChange={(checked) =>
                          toggleSelectAllVisible(checked === true)
                        }
                        aria-label="全选当前列表"
                      />
                    </TableHead>
                    <TableHead className="h-9 px-3 text-xs">候选明文</TableHead>
                    <TableHead className="h-9 w-20 px-3 text-right text-xs">
                      字节
                    </TableHead>
                    <TableHead className="h-9 w-16 px-3 text-right text-xs">
                      命中
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isEmpty ? (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={4} className="p-0">
                        <Empty className="min-h-[220px] border-0 px-6 py-10">
                          <EmptyHeader>
                            <EmptyMedia variant="icon">
                              <Library />
                            </EmptyMedia>
                            <EmptyTitle className="text-sm">
                              没有可显示的候选
                            </EmptyTitle>
                            <EmptyDescription className="max-w-xs text-xs">
                              导入字典文件，或直接添加候选；重复项会自动跳过。
                            </EmptyDescription>
                          </EmptyHeader>
                          <EmptyContent>
                            <Button
                              size="sm"
                              disabled={isBusy}
                              onClick={() => setAddPanelOpen(true)}
                            >
                              <Plus data-icon="inline-start" />
                              添加候选
                            </Button>
                          </EmptyContent>
                        </Empty>
                      </TableCell>
                    </TableRow>
                  ) : (
                    entries.map((entry) => {
                      const selected = selectedIds.has(entry.id)
                      return (
                        <TableRow
                          key={entry.id}
                          data-state={selected ? "selected" : undefined}
                          className="cursor-pointer"
                          onClick={() => toggleSelect(entry.id, !selected)}
                        >
                          <TableCell
                            className="w-10 px-3 py-2"
                            onClick={(event) => event.stopPropagation()}
                          >
                            <Checkbox
                              checked={selected}
                              disabled={isBusy}
                              onCheckedChange={(checked) =>
                                toggleSelect(entry.id, checked === true)
                              }
                              aria-label={`选择候选 #${entry.id}`}
                            />
                          </TableCell>
                          <TableCell className="max-w-0 px-3 py-2">
                            <div className="min-w-0">
                              <p className="truncate font-mono text-xs">
                                {entry.value}
                              </p>
                              <p className="mt-0.5 text-xs text-muted-foreground">
                                #{entry.id}
                              </p>
                            </div>
                          </TableCell>
                          <TableCell className="px-3 py-2 text-right text-xs text-muted-foreground tabular-nums">
                            {entry.byteCount}
                          </TableCell>
                          <TableCell className="px-3 py-2 text-right text-xs text-muted-foreground tabular-nums">
                            {entry.successCount}
                          </TableCell>
                        </TableRow>
                      )
                    })
                  )}
                </TableBody>
              </Table>
            </ScrollArea>
          </CardContent>
          <Separator />
          <div className="flex h-10 shrink-0 items-center justify-between gap-3 px-3">
            <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              <span className="shrink-0 tabular-nums">
                第 {displayedPage} / {pageCount} 页
              </span>
              <span aria-hidden="true">·</span>
              <span
                className={`flex min-w-0 items-center gap-1.5 ${
                  statusTone === "error" ? "text-destructive" : ""
                }`}
                aria-live="polite"
              >
                {statusTone === "busy" ? (
                  <Spinner className="size-3 shrink-0" />
                ) : null}
                <span className="truncate">{status}</span>
              </span>
            </div>
            <Pagination
              aria-label="字典分页"
              className="mx-0 w-auto shrink-0 justify-end"
            >
              <PaginationContent>
                <PaginationItem>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    disabled={isBusy || !hasPreviousPage}
                    onClick={() => handlePageChange(pageIndex - 1)}
                    aria-label="上一页"
                    title="上一页"
                  >
                    <ChevronLeft />
                  </Button>
                </PaginationItem>
                <PaginationItem>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    disabled={isBusy || !hasNextPage}
                    onClick={() => handlePageChange(pageIndex + 1)}
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

      {/* 添加候选：右侧抽屉，保留字典列表上下文 */}
      <Sheet open={addPanelOpen} onOpenChange={setAddPanelOpen}>
        <SheetContent side="right" showCloseButton className="gap-0 p-0">
          <SheetHeader className="shrink-0 border-b border-border/80 pr-12">
            <SheetTitle>添加候选</SheetTitle>
            <SheetDescription>
              导入文本字典，或单条 / 多行新增；重复项自动跳过。
            </SheetDescription>
          </SheetHeader>

          <div className="flex min-h-0 flex-1 scroll-fade flex-col gap-4 overflow-y-auto px-6 py-4 pb-24">
            <Card size="sm" className="gap-0 py-0 shadow-none ring-border/60">
              <CardHeader className="flex flex-row items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <CardTitle className="text-sm">批量导入</CardTitle>
                  <CardDescription className="text-xs">
                    每行一条候选 · 不保存文件路径
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
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".txt,.dic,.lst,text/plain"
                  className="sr-only"
                  onChange={(event) => {
                    const file = event.target.files?.[0] ?? null
                    event.target.value = ""
                    handleImportFile(file)
                  }}
                />
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

            <Field>
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
                className="min-h-28 resize-y rounded-xl font-mono text-xs"
              />
              <Button
                variant="outline"
                size="sm"
                disabled={isBusy || pastedCandidates.length === 0}
                onClick={handleAddPasted}
              >
                添加多行
              </Button>
            </Field>
          </div>
        </SheetContent>
      </Sheet>

      {/* 删除确认 */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent size="default">
          <AlertDialogHeader>
            <AlertDialogTitle>删除候选</AlertDialogTitle>
            <AlertDialogDescription>
              确认删除选中的 {selectedIds.size} 个候选？此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                setStatusTone("neutral")
                setStatus("已取消删除。")
              }}
            >
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={isBusy || selectedIds.size === 0}
              onClick={handleDeleteConfirm}
            >
              删除
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
  shownCount: number,
  searchText: string
): string {
  const searchSuffix =
    searchText.length === 0 ? "" : `，当前查询显示 ${shownCount} 条`
  return `${prefix}：全局字典候选共 ${totalCount} 条${searchSuffix}。`
}
