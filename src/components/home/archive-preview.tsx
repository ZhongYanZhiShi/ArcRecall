"use client"

import * as React from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import { previewArchive, type ArchivePreview } from "@/lib/workflows"

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
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="flex w-full flex-col sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>归档内容预览</SheetTitle>
            <SheetDescription>
              只读取当前归档目录，不展开嵌套归档。加密目录使用已知密码栏中的密码。
            </SheetDescription>
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4">
            {busy && (
              <p role="status" className="text-sm">
                正在读取目录…
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
                  {result.totalEntries.toLocaleString()} 项 · 声明大小{" "}
                  {result.totalBytes.toLocaleString()} 字节
                </p>
                {result.truncated && (
                  <p className="text-xs text-muted-foreground">
                    仅展示前 5000 项，搜索也仅覆盖这些条目。
                  </p>
                )}
                <Input
                  aria-label="搜索归档内容"
                  placeholder="按路径搜索"
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value)
                    setPage(0)
                  }}
                />
                <ScrollArea className="min-h-0 flex-1">
                  <ul className="space-y-2">
                    {matches
                      .slice(page * 100, (page + 1) * 100)
                      .map((entry, index) => (
                        <li
                          key={index}
                          className="rounded-lg border p-3 text-sm"
                        >
                          <p className="break-all">
                            {entry.directory ? "目录" : "文件"} · {entry.path}
                          </p>
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
              disabled={busy}
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
