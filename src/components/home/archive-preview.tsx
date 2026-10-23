"use client"

import * as React from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { pickOutputDirectory, openOutputDirectory } from "@/lib/recovery"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import { previewArchive, type ArchivePreview } from "@/lib/workflows"
import {
  runArchiveAction,
  cancelArchiveAction,
  type ArchiveActionResult,
} from "@/lib/workflows"

export function ArchivePreviewButton({
  path,
  password,
  disabled,
}: {
  path: string
  password: string
  disabled: boolean
}) {
  const [open, setOpen] = React.useState(false)
  const [result, setResult] = React.useState<ArchivePreview | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [search, setSearch] = React.useState("")
  const [page, setPage] = React.useState(0)
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [action, setAction] = React.useState<"check" | "extract" | null>(null)
  const [outcome, setOutcome] = React.useState<ArchiveActionResult | null>(null)
  const [cancelling, setCancelling] = React.useState(false)
  const actionId = React.useRef<string | null>(null)
  const working = React.useRef(false)
  const version = React.useRef(0)
  React.useEffect(
    () => () => {
      version.current++
    },
    []
  )
  async function load() {
    if (working.current) return
    working.current = true
    const request = ++version.current
    setOpen(true)
    setBusy(true)
    setError(null)
    setResult(null)
    setSelected(new Set())
    setOutcome(null)
    setSearch("")
    setPage(0)
    try {
      const next = await previewArchive(path, password)
      if (request === version.current) setResult(next)
    } catch (reason) {
      if (request === version.current) setError(String(reason))
    } finally {
      working.current = false
      if (request === version.current) setBusy(false)
    }
  }
  async function execute(kind: "check" | "extract") {
    if (working.current) return
    working.current = true
    setAction(kind)
    setError(null)
    setOutcome(null)
    try {
      const output = kind === "extract" ? await pickOutputDirectory() : null
      if (kind === "extract" && !output) return
      const id = crypto.randomUUID()
      actionId.current = id
      setBusy(true)
      const next = await runArchiveAction(
        id,
        path,
        password,
        kind === "extract" ? [...selected] : null,
        output
      )
      setOutcome(next)
    } catch (reason) {
      setError(String(reason))
    } finally {
      actionId.current = null
      working.current = false
      setAction(null)
      setBusy(false)
      setCancelling(false)
    }
  }
  const matches =
    result?.entries.filter((entry) =>
      entry.path.toLocaleLowerCase().includes(search.toLocaleLowerCase())
    ) ?? []
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={disabled || busy}
        onClick={() => void load()}
      >
        预览内容
      </Button>
      <Sheet
        open={open}
        onOpenChange={(next) => {
          if (!action) setOpen(next)
        }}
      >
        <SheetContent className="flex w-full flex-col sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>归档内容预览</SheetTitle>
            <SheetDescription>
              勾选文件或目录可提取到新建文件夹。完整性检查读取整包数据但不解压。均使用已知密码，不展开嵌套归档。
            </SheetDescription>
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4">
            {busy && (
              <p role="status" className="text-sm">
                {action === "check"
                  ? "正在检查整包数据…"
                  : action === "extract"
                    ? "正在提取所选条目…"
                    : "正在读取目录…"}
              </p>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={busy || !!action}
                onClick={() => void execute("check")}
              >
                检查完整性
              </Button>
              <Button
                disabled={
                  busy || !!action || !selected.size || !!result?.truncated
                }
                onClick={() => void execute("extract")}
              >
                提取所选（{selected.size}）
              </Button>
              {action && (
                <Button
                  variant="outline"
                  disabled={!busy || cancelling}
                  onClick={() => {
                    const id = actionId.current
                    if (!id) return
                    setCancelling(true)
                    void cancelArchiveAction(id).catch((e) => {
                      setError(String(e))
                      setCancelling(false)
                    })
                  }}
                >
                  {cancelling ? "正在取消…" : "取消操作"}
                </Button>
              )}
            </div>
            {outcome && (
              <div role="status" className="space-y-2 text-sm">
                <p>{outcome.message}</p>
                {outcome.outputDirectory && (
                  <>
                    <p className="break-all">{outcome.outputDirectory}</p>
                    <Button
                      variant="outline"
                      onClick={() =>
                        void openOutputDirectory(
                          outcome.outputDirectory!
                        ).catch((e) => setError(String(e)))
                      }
                    >
                      打开提取目录
                    </Button>
                  </>
                )}
              </div>
            )}
            {result && (
              <>
                <p className="text-sm">
                  {result.totalEntries.toLocaleString()} 项 · 声明大小{" "}
                  {result.totalBytes.toLocaleString()} 字节
                </p>
                {result.truncated && (
                  <p className="text-xs text-muted-foreground">
                    仅展示前 5000
                    项，搜索也仅覆盖这些条目。选择性解压不可用，可使用整包解压。
                  </p>
                )}
                <Input
                  disabled={!!action}
                  aria-label="搜索归档内容"
                  placeholder="按路径搜索"
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value)
                    setPage(0)
                  }}
                />
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!!action || !!result.truncated}
                    onClick={() =>
                      setSelected(
                        new Set([
                          ...selected,
                          ...matches.filter((e) => !e.link).map((e) => e.path),
                        ])
                      )
                    }
                  >
                    选择筛选结果
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!!action || !selected.size}
                    onClick={() => setSelected(new Set())}
                  >
                    清空选择
                  </Button>
                </div>
                <ScrollArea className="min-h-0 flex-1">
                  <ul className="space-y-2">
                    {matches
                      .slice(page * 100, (page + 1) * 100)
                      .map((entry, index) => (
                        <li
                          key={index}
                          className="rounded-lg border p-3 text-sm"
                        >
                          <div className="flex items-start gap-3">
                            <Checkbox
                              aria-label={`选择 ${entry.path}`}
                              checked={selected.has(entry.path)}
                              disabled={
                                !!action || !!result.truncated || entry.link
                              }
                              onCheckedChange={(checked) =>
                                setSelected((previous) => {
                                  const next = new Set(previous)
                                  if (checked) next.add(entry.path)
                                  else next.delete(entry.path)
                                  return next
                                })
                              }
                            />
                            <p className="break-all">
                              {entry.directory ? "目录" : "文件"} · {entry.path}
                            </p>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {entry.size.toLocaleString()} 字节
                            {entry.encrypted ? " · 已加密" : ""}
                          </p>
                        </li>
                      ))}
                  </ul>
                  {matches.length === 0 && (
                    <p className="text-sm">没有匹配的条目。</p>
                  )}
                </ScrollArea>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    disabled={page === 0}
                    onClick={() => setPage(page - 1)}
                  >
                    上一页
                  </Button>
                  <span className="text-sm">
                    {page + 1} / {Math.max(1, Math.ceil(matches.length / 100))}
                  </span>
                  <Button
                    variant="outline"
                    disabled={(page + 1) * 100 >= matches.length}
                    onClick={() => setPage(page + 1)}
                  >
                    下一页
                  </Button>
                </div>
              </>
            )}
            <Button
              variant="outline"
              disabled={busy || !!action}
              onClick={() => void load()}
            >
              重新读取
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
