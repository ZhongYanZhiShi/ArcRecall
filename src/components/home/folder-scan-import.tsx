"use client"
import * as React from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import {
  pickScanFolder,
  scanFolder,
  type FolderScanResult,
  type ProcessingOptions,
} from "@/lib/planning"
import { cancelArchiveAction } from "@/lib/workflows"
import { newScannedArchivePaths } from "@/lib/recovery-queue"
import {
  recoveryQueue,
  recoveryQueueJournal,
} from "@/lib/recovery-queue-session"

export function FolderScanImport({
  options,
  disabled,
}: {
  options: ProcessingOptions
  disabled: boolean
}) {
  const [open, setOpen] = React.useState(false)
  const [root, setRoot] = React.useState<string | null>(null)
  const [recursive, setRecursive] = React.useState(true)
  const [result, setResult] = React.useState<FolderScanResult | null>(null)
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [query, setQuery] = React.useState("")
  const [page, setPage] = React.useState(0)
  const [busy, setBusy] = React.useState(false)
  const [cancelling, setCancelling] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const operation = React.useRef(false)
  const scanId = React.useRef<string | null>(null)
  const queue = React.useSyncExternalStore(
    recoveryQueue.subscribe,
    recoveryQueue.getSnapshot,
    recoveryQueue.getSnapshot
  )
  const paths = queue.items.map((item) => item.path)
  const fresh = new Set(newScannedArchivePaths(paths, result?.entries ?? []))
  const matches =
    result?.entries.filter((entry) =>
      entry.path.toLocaleLowerCase().includes(query.toLocaleLowerCase())
    ) ?? []
  async function start() {
    if (operation.current || disabled) return
    operation.current = true
    setBusy(true)
    setError(null)
    try {
      const directory = await pickScanFolder()
      if (!directory) return
      setRoot(directory)
      setResult(null)
      setSelected(new Set())
      setQuery("")
      setPage(0)
      const id = crypto.randomUUID()
      scanId.current = id
      setResult(await scanFolder(id, directory, recursive))
    } catch (e) {
      setError(String(e))
    } finally {
      scanId.current = null
      operation.current = false
      setBusy(false)
      setCancelling(false)
    }
  }
  async function confirm() {
    if (operation.current || disabled) return
    operation.current = true
    setBusy(true)
    setError(null)
    try {
      await recoveryQueueJournal.initialize()
      if (options.outputDirectory === "")
        throw new Error("请先在解压选项中选择自定义输出目录。")
      if (!recoveryQueueJournal.getSnapshot().ready)
        throw new Error("队列尚未就绪，请稍后重试。")
      const current = recoveryQueue.getSnapshot().items.map((item) => item.path)
      const additions = newScannedArchivePaths(
        current,
        result?.entries.filter((entry) => selected.has(entry.path)) ?? []
      )
      if (!additions.length) throw new Error("所选归档均已在队列中。")
      recoveryQueue.enqueue(additions, options)
      setSelected(new Set())
      await recoveryQueueJournal.flush()
      toast.success(`已加入 ${additions.length} 个归档，请确认队列后开始。`)
      setOpen(false)
    } catch (e) {
      setError(String(e))
    } finally {
      operation.current = false
      setBusy(false)
    }
  }
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        扫描文件夹
      </Button>
      <Sheet
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next)
        }}
      >
        <SheetContent className="flex w-full flex-col sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>扫描文件夹并导入</SheetTitle>
            <SheetDescription>
              按内容识别归档，同一分卷组只加入一次。跳过链接；扫描不解压、不校验完整性，也不自动执行队列。
            </SheetDescription>
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={recursive}
                disabled={busy || disabled}
                onCheckedChange={setRecursive}
              />
              扫描子文件夹
            </label>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={busy || disabled}
                onClick={() => void start()}
              >
                选择文件夹并扫描
              </Button>
              {busy && (
                <Button
                  variant="outline"
                  disabled={cancelling}
                  onClick={() => {
                    const id = scanId.current
                    if (!id) return
                    setCancelling(true)
                    void cancelArchiveAction(id).catch((e) => {
                      setError(String(e))
                      setCancelling(false)
                    })
                  }}
                >
                  {cancelling ? "正在停止…" : "停止扫描"}
                </Button>
              )}
            </div>
            {root && (
              <p className="text-xs break-all text-muted-foreground">{root}</p>
            )}
            {busy && (
              <p role="status" className="text-sm">
                正在处理，请稍候…
              </p>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            {result && (
              <>
                <p className="text-sm">
                  找到 {result.entries.length} 个归档 · 检查{" "}
                  {result.visitedEntries} 项 · 跳过 {result.skippedLinks} 个链接
                </p>
                {(result.cancelled || result.truncated) && (
                  <p role="status" className="text-sm">
                    {result.cancelled ? "扫描已停止" : "扫描达到上限"}
                    ，以下为部分结果，仍可确认导入。上限为 20000 项、1000
                    个归档和 32 层子目录。
                  </p>
                )}
                {!!result.warnings.length && (
                  <details className="text-xs">
                    <summary>
                      {result.warnings.length} 项未能识别或访问（最多显示 100
                      项）
                    </summary>
                    <div className="max-h-32 overflow-auto">
                      {result.warnings.map((warning, i) => (
                        <p key={i} className="break-all">
                          {warning.path}：{warning.message}
                        </p>
                      ))}
                    </div>
                  </details>
                )}
                <Input
                  aria-label="筛选扫描结果"
                  placeholder="按路径筛选"
                  value={query}
                  disabled={busy}
                  onChange={(e) => {
                    setQuery(e.target.value)
                    setPage(0)
                  }}
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || disabled}
                    onClick={() => {
                      const next = new Set([
                        ...selected,
                        ...matches
                          .filter((e) => fresh.has(e.path))
                          .map((e) => e.path),
                      ])
                      if (next.size + paths.length > 200) {
                        setError(
                          "队列最多 200 个归档，请缩小筛选范围或分批选择。"
                        )
                        return
                      }
                      setSelected(next)
                      setError(null)
                    }}
                  >
                    选择筛选结果
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setSelected(new Set())}
                  >
                    清空选择
                  </Button>
                </div>
                <ScrollArea className="min-h-0 flex-1">
                  <div className="space-y-2">
                    {matches.slice(page * 50, (page + 1) * 50).map((entry) => (
                      <label
                        key={entry.path}
                        className="flex items-start gap-3 rounded-lg border p-3 text-sm"
                      >
                        <Checkbox
                          aria-label={`导入 ${entry.path}`}
                          checked={selected.has(entry.path)}
                          disabled={busy || disabled || !fresh.has(entry.path)}
                          onCheckedChange={(checked) => {
                            const next = new Set(selected)
                            if (checked) next.add(entry.path)
                            else next.delete(entry.path)
                            setSelected(next)
                          }}
                        />
                        <span className="min-w-0 break-all">
                          {entry.path}
                          <span className="block text-xs text-muted-foreground">
                            {entry.format} · {entry.fileSize.toLocaleString()}{" "}
                            字节 · {entry.volumeCount} 卷
                            {!fresh.has(entry.path) ? " · 已在队列" : ""}
                          </span>
                        </span>
                      </label>
                    ))}
                    {!matches.length && (
                      <p className="text-sm">没有匹配的归档。</p>
                    )}
                  </div>
                </ScrollArea>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || page === 0}
                    onClick={() => setPage(page - 1)}
                  >
                    上一页
                  </Button>
                  <span className="text-sm">
                    {page + 1} / {Math.max(1, Math.ceil(matches.length / 50))}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || (page + 1) * 50 >= matches.length}
                    onClick={() => setPage(page + 1)}
                  >
                    下一页
                  </Button>
                </div>
                <p className="text-xs break-all text-muted-foreground">
                  加入时使用当前选项：{options.dictionaryGroup ?? "全部字典"} ·{" "}
                  {options.recursive ? "递归解压" : "仅当前归档"} ·{" "}
                  {options.computeMode === "cpuOnly" ? "仅 CPU" : "GPU 优先"} ·
                  输出：{options.outputDirectory ?? "归档同级"}。单批最多 200
                  个，已有 {paths.length} 个。
                </p>
                <Button
                  disabled={
                    busy ||
                    disabled ||
                    !selected.size ||
                    selected.size + paths.length > 200
                  }
                  onClick={() => void confirm()}
                >
                  确认加入队列（{selected.size}）
                </Button>
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
