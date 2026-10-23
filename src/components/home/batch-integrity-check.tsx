"use client"

import * as React from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  exportBatchCheck,
  getBatchCheck,
  runBatchCheck,
  type BatchCheckStatus,
  type IntegrityState,
} from "@/lib/batch-integrity"
import { cancelArchiveAction } from "@/lib/workflows"
import { openOutputDirectory } from "@/lib/recovery"

const LABELS: Record<IntegrityState, string> = {
  waiting: "等待检查",
  checking: "检查中",
  passed: "通过",
  failed: "未通过",
  cancelled: "已取消",
}

export function BatchIntegrityCheck({
  paths,
  disabled,
  onSelectPassed,
  onBusyChange,
}: {
  paths: string[]
  disabled: boolean
  onSelectPassed?: (paths: string[]) => void
  onBusyChange?: (busy: boolean) => void
}) {
  const [open, setOpen] = React.useState(false)
  const [batchPaths, setBatchPaths] = React.useState<string[]>([])
  const [status, setStatus] = React.useState<BatchCheckStatus | null>(null)
  const [password, setPassword] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [cancelling, setCancelling] = React.useState(false)
  const [exporting, setExporting] = React.useState(false)
  const [includePaths, setIncludePaths] = React.useState(false)
  const [savedPath, setSavedPath] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [pollError, setPollError] = React.useState(false)
  const operation = React.useRef(false)
  const active = React.useRef<string | null>(null)
  const mounted = React.useRef(true)
  const passwordId = React.useId()
  React.useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  async function run(retryFailed = false) {
    if (operation.current || disabled) return
    operation.current = true
    onBusyChange?.(true)
    const id = retryFailed && status ? status.id : crypto.randomUUID()
    active.current = id
    setBusy(true)
    setCancelling(false)
    setError(null)
    setPollError(false)
    setSavedPath(null)
    if (!retryFailed) setStatus(null)
    let timer: ReturnType<typeof setTimeout> | undefined
    let finished = false
    const poll = async () => {
      try {
        const next = await getBatchCheck(id)
        if (!finished && mounted.current) {
          if (next?.id === id) setStatus(next)
          setPollError(false)
        }
      } catch {
        if (!finished && mounted.current) setPollError(true)
      }
      if (!finished && mounted.current)
        timer = setTimeout(() => void poll(), 400)
    }
    // The long-running command owns completion; a stale status response must not unlock controls.
    const request = runBatchCheck(
      id,
      retryFailed && status
        ? status.items.map((item) => item.path)
        : batchPaths,
      password,
      retryFailed
    )
    timer = setTimeout(() => void poll(), 150)
    try {
      const next = await request
      if (mounted.current) setStatus(next)
    } catch (reason) {
      finished = true
      clearTimeout(timer)
      if (mounted.current) setError(String(reason))
      // Startup failures also finish the server-side batch. Recover that final
      // snapshot so failed entries can be retried and reported.
      try {
        const next = await getBatchCheck(id)
        if (mounted.current && next?.id === id) setStatus(next)
      } catch {
        if (mounted.current) setStatus(null)
      }
    } finally {
      finished = true
      clearTimeout(timer)
      active.current = null
      operation.current = false
      onBusyChange?.(false)
      if (mounted.current) {
        setBusy(false)
        setCancelling(false)
        setPassword("")
        setPollError(false)
      }
    }
  }

  async function exportReport(format: "json" | "csv") {
    if (operation.current || !status) return
    operation.current = true
    onBusyChange?.(true)
    setExporting(true)
    setError(null)
    try {
      setSavedPath(await exportBatchCheck(status.id, format, includePaths))
    } catch (reason) {
      setError(String(reason))
    } finally {
      operation.current = false
      onBusyChange?.(false)
      setExporting(false)
    }
  }

  const rows =
    status?.items ??
    batchPaths.map((path) => ({
      path,
      sourcePaths: [path],
      state: "waiting" as const,
      message: "",
      elapsedMs: 0,
      checkedAtMs: null,
    }))
  const passed = rows.filter((item) => item.state === "passed")
  const failed = rows.filter((item) => item.state === "failed")
  const completed = rows.filter(
    (item) => item.state === "passed" || item.state === "failed"
  ).length
  const locked = busy || exporting
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={disabled || !paths.length || paths.length > 200}
        onClick={() => {
          if (JSON.stringify(paths) !== JSON.stringify(batchPaths)) {
            setStatus(null)
            setSavedPath(null)
          }
          setBatchPaths([...paths])
          setError(null)
          setPassword("")
          setOpen(true)
        }}
      >
        批量检查完整性
      </Button>
      <Sheet
        open={open}
        onOpenChange={(next) => {
          if (!locked) {
            setOpen(next)
            setPassword("")
          }
        }}
      >
        <SheetContent className="flex w-full flex-col sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>批量完整性检查</SheetTitle>
            <SheetDescription>
              逐项检查所选归档，最多 200
              项；不解压到输出目录，不尝试字典。结果仅代表检查时的文件，内部嵌套归档不单独校验。
            </SheetDescription>
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4">
            <div className="space-y-1">
              <Label htmlFor={passwordId}>本次检查密码</Label>
              <Input
                id={passwordId}
                type="password"
                autoComplete="off"
                value={password}
                disabled={locked}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="加密归档需要正确密码；本次结束后清空"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={locked || disabled || !batchPaths.length}
                onClick={() => void run()}
              >
                {status ? "重新检查全部" : "开始检查"}
              </Button>
              <Button
                variant="outline"
                disabled={locked || disabled || !failed.length}
                onClick={() => void run(true)}
              >
                仅重查未通过项
              </Button>
              {busy && (
                <Button
                  variant="outline"
                  disabled={cancelling}
                  onClick={() => {
                    const id = active.current
                    if (!id) return
                    setCancelling(true)
                    void cancelArchiveAction(id).catch((reason) => {
                      setError(String(reason))
                      setCancelling(false)
                    })
                  }}
                >
                  {cancelling ? "正在取消…" : "取消检查"}
                </Button>
              )}
            </div>
            <p role="status" className="text-sm">
              {busy
                ? "正在检查"
                : status?.cancelled
                  ? "检查已取消"
                  : status
                    ? "检查结束"
                    : "待开始"}{" "}
              · 已检查 {completed}/{rows.length} · 通过 {passed.length} · 未通过{" "}
              {failed.length}
            </p>
            {pollError && (
              <p className="text-xs text-muted-foreground">
                正在重新获取进度，请等待检查完成。
              </p>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <ScrollArea className="min-h-24 flex-1">
              <ol className="space-y-2">
                {rows.map((item) => (
                  <li
                    key={item.path}
                    className="space-y-1 rounded-lg border p-3 text-sm"
                  >
                    <p className="break-all">{item.path}</p>
                    <p
                      className={
                        item.state === "failed"
                          ? "text-destructive"
                          : "text-muted-foreground"
                      }
                    >
                      {LABELS[item.state]}
                      {item.checkedAtMs !== null
                        ? ` · ${(item.elapsedMs / 1000).toFixed(1)} 秒 · ${new Date(item.checkedAtMs).toLocaleString()}`
                        : ""}
                    </p>
                    {item.message && (
                      <p className="text-xs break-all text-muted-foreground">
                        {item.message}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            </ScrollArea>
            {onSelectPassed && (
              <Button
                variant="outline"
                disabled={locked || !passed.length}
                onClick={() => {
                  onSelectPassed(
                    passed.flatMap((item) => item.sourcePaths ?? [item.path])
                  )
                  setOpen(false)
                }}
              >
                仅选择通过项（{passed.length}）
              </Button>
            )}
            {status && !busy && (
              <div className="space-y-2 border-t pt-3">
                <p className="text-xs text-muted-foreground">
                  导出本批次各项结果、检查时间与耗时，不包含密码。结果保留到下一批检查或退出应用。
                </p>
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2 text-xs">
                    <Checkbox
                      checked={includePaths}
                      disabled={locked}
                      onCheckedChange={setIncludePaths}
                    />
                    报告包含文件路径
                  </label>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={locked || status.running}
                    onClick={() => void exportReport("json")}
                  >
                    导出 JSON
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={locked || status.running}
                    onClick={() => void exportReport("csv")}
                  >
                    导出 CSV
                  </Button>
                </div>
                {savedPath && (
                  <div role="status" className="space-y-1 text-xs">
                    <p className="break-all">报告文件：{savedPath}</p>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() =>
                        void openOutputDirectory(
                          savedPath.replace(/[\\/][^\\/]+$/, "")
                        ).catch((reason) => setError(String(reason)))
                      }
                    >
                      打开报告目录
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
