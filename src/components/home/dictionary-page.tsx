"use client"

import { FileUp, Library, Plus, RefreshCw, Search, Trash2 } from "lucide-react"
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
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
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
import { cn } from "@/lib/utils"

type StatusTone = "neutral" | "busy" | "ok" | "warn"

export function DictionaryPage() {
  const [entries, setEntries] = React.useState<DictionaryCandidateEntry[]>([])
  const [totalCount, setTotalCount] = React.useState(0)
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

  const loadEntries = React.useCallback(async (searchText: string) => {
    const result = await listDictionary({
      searchText,
      skip: 0,
      take: DICTIONARY_PAGE_SIZE,
    })
    setEntries(result.entries)
    setTotalCount(result.totalCount)
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
    return result
  }, [])

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
        setStatusTone("warn")
        setStatus(`操作失败：${message}`)
      } finally {
        setIsBusy(false)
      }
    },
    [isBusy]
  )

  React.useEffect(() => {
    void (async () => {
      setIsBusy(true)
      setStatusTone("busy")
      setStatus("正在加载候选…")
      try {
        const result = await loadEntries("")
        setStatusTone("ok")
        setStatus(formatLoadStatus("已就绪", result.totalCount, 0, ""))
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error ?? "未知错误")
        if (!isDesktopRuntime()) {
          setStatusTone("neutral")
          setStatus(
            "浏览器预览使用内存字典（刷新即清空）；桌面端写入本机 SQLite。"
          )
        } else {
          setStatusTone("warn")
          setStatus(`加载失败：${message}`)
        }
      } finally {
        setIsBusy(false)
      }
    })()
  }, [loadEntries])

  const handleRefresh = () => {
    void runBusy("正在刷新候选…", async () => {
      const result = await loadEntries(appliedSearch)
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
      const result = await loadEntries(searchInput)
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
      const result = await loadEntries(appliedSearch)
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
        const result = await loadEntries(appliedSearch)
        setStatusTone("ok")
        setStatus(
          `${formatAddStatus("导入完成", summary)} 全局共 ${result.totalCount} 条。`
        )
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error ?? "未知错误")
        setStatusTone("warn")
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
      const result = await loadEntries(appliedSearch)
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
      const result = await loadEntries(appliedSearch)
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

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="mx-auto flex h-full min-h-0 w-full max-w-[720px] flex-col gap-2 px-5 pt-6 pb-2">
        <header className="shrink-0">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] font-medium tracking-[0.16em] text-muted-foreground uppercase">
                Candidates
              </p>
              <h1 className="mt-1 text-lg font-semibold tracking-tight">
                字典
              </h1>
              <p className="mt-0.5 text-xs text-muted-foreground">
                管理本机全局密码候选集 · 解压验密直接读取此处
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
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
            </div>
          </div>
        </header>

        <Card
          size="sm"
          className="shrink-0 gap-0 py-0 shadow-sm ring-border/60"
        >
          <CardContent className="flex items-center gap-2 py-2.5">
            <div className="relative min-w-0 flex-1">
              <Search
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground"
                strokeWidth={1.9}
              />
              <Input
                type="search"
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
                className="h-8 rounded-xl pl-9 text-xs"
              />
            </div>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0"
              disabled={isBusy}
              onClick={handleSearch}
            >
              查询
            </Button>
          </CardContent>
        </Card>

        <Card
          size="sm"
          className="flex min-h-0 flex-1 flex-col gap-0 overflow-hidden py-0 shadow-sm ring-border/60"
        >
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 border-b border-border/80 py-2.5">
            <div className="flex min-w-0 items-center gap-2">
              <Checkbox
                checked={allVisibleSelected}
                indeterminate={someVisibleSelected}
                disabled={isEmpty || isBusy}
                onCheckedChange={(checked) =>
                  toggleSelectAllVisible(checked === true)
                }
                aria-label="全选当前列表"
              />
              <CardDescription className="text-xs">
                {selectedIds.size > 0
                  ? `已选 ${selectedIds.size}`
                  : `显示 ${entries.length} 条`}
              </CardDescription>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Badge variant="secondary" className="font-normal">
                全局 {totalCount}
              </Badge>
              {appliedSearch ? (
                <Badge variant="outline" className="max-w-[10rem] font-normal">
                  <span className="truncate">筛选 · {appliedSearch}</span>
                </Badge>
              ) : null}
            </div>
          </CardHeader>

          <CardContent className="min-h-0 flex-1 p-0">
            {isEmpty ? (
              <div className="flex h-full min-h-[220px] flex-col items-center justify-center px-6 py-10 text-center">
                <div className="mb-3 flex size-11 items-center justify-center rounded-2xl bg-muted">
                  <Library
                    className="size-5 text-muted-foreground"
                    strokeWidth={1.75}
                  />
                </div>
                <p className="text-sm font-medium">没有可显示的候选</p>
                <p className="mt-1 max-w-xs text-xs text-muted-foreground">
                  导入字典文件，或直接添加候选；重复项会自动跳过。
                </p>
                <Button
                  size="sm"
                  className="mt-4"
                  disabled={isBusy}
                  onClick={() => setAddPanelOpen(true)}
                >
                  <Plus data-icon="inline-start" />
                  添加候选
                </Button>
              </div>
            ) : (
              <ScrollArea className="h-full max-h-full">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="h-9 w-10 px-3" />
                      <TableHead className="h-9 px-3 text-xs">
                        候选明文
                      </TableHead>
                      <TableHead className="h-9 w-20 px-3 text-right text-xs">
                        字节
                      </TableHead>
                      <TableHead className="h-9 w-16 px-3 text-right text-xs">
                        命中
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {entries.map((entry) => {
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
                              <p className="mt-0.5 text-[10px] text-muted-foreground">
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
                    })}
                  </TableBody>
                </Table>
              </ScrollArea>
            )}
          </CardContent>
        </Card>

        <Card
          size="sm"
          className={cn(
            "shrink-0 gap-0 py-0 shadow-sm",
            statusTone === "busy" && "bg-muted/40 ring-border/60",
            statusTone === "ok" && "ring-border/60",
            statusTone === "warn" &&
              "bg-destructive/5 ring-destructive/25 dark:bg-destructive/10",
            statusTone === "neutral" && "ring-border/60"
          )}
        >
          <CardFooter className="py-2.5">
            <p
              className={cn(
                "line-clamp-2 text-xs leading-relaxed",
                statusTone === "warn"
                  ? "text-destructive"
                  : statusTone === "busy" || statusTone === "neutral"
                    ? "text-muted-foreground"
                    : "text-foreground"
              )}
            >
              {status}
            </p>
          </CardFooter>
        </Card>
      </div>

      {/* 添加候选：右侧抽屉，保留字典列表上下文 */}
      <Sheet open={addPanelOpen} onOpenChange={setAddPanelOpen}>
        <SheetContent
          side="right"
          showCloseButton
          className="w-full gap-0 p-0 sm:max-w-md"
        >
          <SheetHeader className="shrink-0 border-b border-border/80 pr-12">
            <p className="text-[11px] font-medium tracking-[0.16em] text-muted-foreground uppercase">
              Add Candidates
            </p>
            <SheetTitle>添加候选</SheetTitle>
            <SheetDescription>
              导入文本字典，或单条 / 多行新增；重复项自动跳过。
            </SheetDescription>
          </SheetHeader>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4 pb-24">
            <Card size="sm" className="gap-0 py-0 shadow-none ring-border/60">
              <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 py-3">
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

            <div className="space-y-2">
              <Label
                htmlFor="dict-single"
                className="text-xs text-muted-foreground"
              >
                新增单条
              </Label>
              <div className="flex gap-2">
                <Input
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
                  className="h-9 rounded-xl"
                />
                <Button
                  className="shrink-0"
                  disabled={isBusy || singleCandidate.length === 0}
                  onClick={handleAddSingle}
                >
                  添加
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <Label
                htmlFor="dict-paste"
                className="text-xs text-muted-foreground"
              >
                粘贴多行
              </Label>
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
            </div>
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
    </div>
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
