"use client"

import * as React from "react"
import { invoke } from "@tauri-apps/api/core"
import { openRememberingDirectory } from "@/lib/file-dialog"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
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
import { backupDatabase } from "@/lib/logging"
import { isDesktopRuntime, isDictionaryImportRunning } from "@/lib/dictionary"
import { recoveryQueue } from "@/lib/recovery-queue-session"

type RestorePreview = {
  token: string
  candidateCount: number
  historyCount: number
  passwordCount: number
  unreadablePasswordCount: number
}

export function DatabaseRestorePanel({
  onRestored,
}: {
  onRestored: () => void
}) {
  const [preview, setPreview] = React.useState<RestorePreview | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [message, setMessage] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const operation = React.useRef(false)
  const run = async (action: () => Promise<void>) => {
    if (operation.current) return
    operation.current = true
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      await action()
    } catch (reason) {
      setError(String(reason instanceof Error ? reason.message : reason))
    } finally {
      operation.current = false
      setBusy(false)
    }
  }
  const dismiss = () => {
    if (busy) return
    if (preview)
      void invoke("database_restore_discard", { token: preview.token }).catch(
        () => undefined
      )
    setPreview(null)
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-medium">数据库备份与恢复</p>
      <p className="text-xs leading-relaxed text-muted-foreground">
        包含候选字典和恢复历史；不包含应用设置、AI
        密钥或压缩默认密码。历史密码受创建备份的 Windows 账户保护。
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !isDesktopRuntime()}
          onClick={() =>
            void run(async () => {
              const result = await backupDatabase()
              setMessage(`备份已创建：${result.path}`)
            })
          }
        >
          创建备份
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !isDesktopRuntime()}
          onClick={() =>
            void run(async () => {
              const path = await openRememberingDirectory("database-backup", {
                multiple: false,
                directory: false,
                title: "选择 ArcRecall 数据库备份",
                filters: [
                  {
                    name: "SQLite 备份",
                    extensions: ["db", "sqlite", "sqlite3"],
                  },
                ],
              })
              if (typeof path !== "string") return
              const next = await invoke<RestorePreview>(
                "database_restore_preview",
                { path }
              )
              setPreview(next)
            })
          }
        >
          {busy ? "正在处理…" : "从备份恢复"}
        </Button>
      </div>
      {message ? (
        <p role="status" className="text-xs break-all text-muted-foreground">
          {message}
        </p>
      ) : null}
      {error ? (
        <Alert variant="warning">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <AlertDialog
        open={preview !== null}
        onOpenChange={(open) => {
          if (!open) dismiss()
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>恢复这份数据库备份</AlertDialogTitle>
            <AlertDialogDescription>
              备份已通过完整性与结构校验，包含 {preview?.candidateCount ?? 0}{" "}
              条候选、{preview?.historyCount ?? 0} 条历史（
              {preview?.passwordCount ?? 0}{" "}
              条含密码）。恢复将替换当前字典和历史；操作前会自动另存当前数据库，失败时保留原有数据。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {preview && preview.unreadablePasswordCount > 0 ? (
            <p role="alert" className="text-sm text-destructive">
              有 {preview.unreadablePasswordCount} 条密码无法由当前 Windows
              账户解密。为完整保留密码，请在创建备份的账户中恢复。
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy || !preview || preview.unreadablePasswordCount > 0}
              onClick={() =>
                void run(async () => {
                  if (!preview) return
                  if (
                    isDictionaryImportRunning() ||
                    recoveryQueue.getSnapshot().running
                  )
                    throw new Error(
                      "请先完成或停止字典导入与批次任务，再恢复数据库。"
                    )
                  const result = await invoke<{ safetyBackupPath: string }>(
                    "database_restore_apply",
                    { token: preview.token }
                  )
                  setPreview(null)
                  setMessage(
                    `恢复完成。恢复前的数据备份：${result.safetyBackupPath}`
                  )
                  onRestored()
                })
              }
            >
              {busy ? "正在恢复…" : "备份当前数据并恢复"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
