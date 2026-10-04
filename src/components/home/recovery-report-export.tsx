"use client"

import * as React from "react"
import { invoke } from "@tauri-apps/api/core"
import { Button } from "@/components/ui/button"
import { buildRecoveryReport } from "@/lib/recovery-report"
import type { RecoveryTaskStatus } from "@/lib/recovery"

export function RecoveryReportExport({
  task,
  onOpenDirectory,
}: {
  task: RecoveryTaskStatus
  onOpenDirectory: (path: string) => void
}) {
  const [includePaths, setIncludePaths] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [savedPath, setSavedPath] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const exporting = React.useRef(false)
  const exportReport = async (format: "json" | "csv") => {
    if (exporting.current) return
    exporting.current = true
    setBusy(true)
    setError(null)
    setSavedPath(null)
    try {
      setSavedPath(
        await invoke<string>("recovery_report_export", {
          report: buildRecoveryReport(task, includePaths),
          format,
        })
      )
    } catch (reason) {
      setError(String(reason))
    } finally {
      exporting.current = false
      setBusy(false)
    }
  }
  return (
    <div
      className="mt-3 space-y-2 rounded-lg border p-2.5 text-xs"
      aria-label="导出任务报告"
    >
      <p className="font-medium">导出任务报告</p>
      <p className="text-muted-foreground">
        包含状态、计数和耗时；不包含密码、日志或事件原文。
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={includePaths}
            disabled={busy}
            onChange={(event) => setIncludePaths(event.target.checked)}
          />
          包含文件路径
        </label>
        <Button
          size="xs"
          variant="outline"
          disabled={busy}
          onClick={() => void exportReport("json")}
        >
          导出 JSON
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={busy}
          onClick={() => void exportReport("csv")}
        >
          导出 CSV
        </Button>
      </div>
      {savedPath ? (
        <div role="status" className="space-y-1">
          <p className="break-all">已导出：{savedPath}</p>
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              onOpenDirectory(savedPath.replace(/[\\/][^\\/]+$/, ""))
            }
          >
            打开报告目录
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive">
          导出失败：{error}
        </p>
      ) : null}
    </div>
  )
}
