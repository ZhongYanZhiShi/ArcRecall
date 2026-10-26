"use client"

import * as React from "react"
import { toast } from "sonner"
import {
  previewDatabaseRestore,
  discardDatabaseRestore,
  applyDatabaseRestore,
  type RestorePreview,
} from "@/lib/backup"
import { openRememberingDirectory } from "@/lib/file-dialog"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
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
import { isDictionaryImportRunning } from "@/lib/dictionary"
import { isDesktopRuntime } from "@/lib/runtime"
import { recoveryQueue } from "@/lib/recovery-queue-session"
import { BackupManagementPanel } from "./backup-management-panel"

export function DatabaseRestorePanel({
  onRestored,
}: {
  onRestored: () => void
}) {
  const [preview, setPreview] = React.useState<RestorePreview | null>(null)
  const [pendingAction, setPendingAction] = React.useState<
    "backup" | "preview" | "restore" | null
  >(null)
  const busy = pendingAction !== null
  const [message, setMessage] = React.useState<string | null>(null)
  const operation = React.useRef(false)
  const run = async (
    kind: "backup" | "preview" | "restore",
    action: () => Promise<void>
  ) => {
    if (operation.current) return
    operation.current = true
    setPendingAction(kind)
    setMessage(null)
    try {
      await action()
    } catch (reason) {
      toast.error(String(reason instanceof Error ? reason.message : reason), {
        id: "database-action",
        duration: 6_000,
      })
    } finally {
      operation.current = false
      setPendingAction(null)
    }
  }
  const dismiss = () => {
    if (busy) return
    if (preview)
      void discardDatabaseRestore(preview.token).catch(() => undefined)
    setPreview(null)
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-medium">统一数据备份与恢复</p>
      <p className="text-xs leading-relaxed text-muted-foreground">
        包含候选字典、分组、恢复历史、处理预设、压缩预设、任务记录，以及更新、日志和解压设置。
        不包含待处理队列、引擎路径、AI
        配置与密钥或压缩默认密码。历史密码受创建备份的 Windows 账户保护。
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !isDesktopRuntime()}
          onClick={() =>
            void run("backup", async () => {
              const result = await backupDatabase()
              setMessage(`备份位置：${result.path}`)
              toast.success("统一数据备份已创建", { id: "database-action" })
            })
          }
        >
          {pendingAction === "backup" ? (
            <Spinner aria-hidden="true" data-icon="inline-start" />
          ) : null}
          {pendingAction === "backup" ? "正在备份…" : "创建备份"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !isDesktopRuntime()}
          onClick={() =>
            void run("preview", async () => {
              const path = await openRememberingDirectory("database-backup", {
                multiple: false,
                directory: false,
                title: "选择 ArcRecall 数据备份",
                filters: [
                  {
                    name: "ArcRecall 与旧版数据库备份",
                    extensions: ["arcrecall", "db", "sqlite", "sqlite3"],
                  },
                ],
              })
              if (typeof path !== "string") return
              const next = await previewDatabaseRestore(path)
              setPreview(next)
            })
          }
        >
          {pendingAction === "preview" ? (
            <Spinner aria-hidden="true" data-icon="inline-start" />
          ) : null}
          {pendingAction === "preview" ? "正在读取备份…" : "从备份恢复"}
        </Button>
      </div>
      {message ? (
        <p role="status" className="text-xs break-all text-muted-foreground">
          {message}
        </p>
      ) : null}
      <BackupManagementPanel
        disabled={busy}
        onPreview={(path) =>
          run("preview", async () => {
            setPreview(await previewDatabaseRestore(path))
          })
        }
      />
      <AlertDialog
        open={preview !== null}
        onOpenChange={(open) => {
          if (!open) dismiss()
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>恢复这份数据备份</AlertDialogTitle>
            <AlertDialogDescription>
              备份已通过完整性与结构校验，包含 {preview?.candidateCount ?? 0}{" "}
              条候选、{preview?.historyCount ?? 0} 条历史（
              {preview?.passwordCount ?? 0} 条含密码）。
              {preview?.unified
                ? `另含 ${preview.presetCount} 个处理预设、${preview.taskRecordCount} 条任务记录及通用设置，将一并替换当前对应数据。${preview.compressionPresetCount == null ? "旧版备份不含压缩预设，将保留当前压缩预设。" : `包含 ${preview.compressionPresetCount} 个压缩预设，将替换当前压缩预设。`}`
                : "这是旧版数据库备份，仅替换字典和历史；预设、任务记录与设置保持当前值。"}
              操作前自动创建完整安全备份；失败时回滚，恢复过程中退出应用将在下次启动时回滚。运行中的历史记录恢复后标记为中断。
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
                void run("restore", async () => {
                  if (!preview) return
                  if (
                    isDictionaryImportRunning() ||
                    recoveryQueue.getSnapshot().running
                  )
                    throw new Error(
                      "请先完成或停止字典导入与批次任务，再恢复数据。"
                    )
                  const result = await applyDatabaseRestore(preview.token)
                  setPreview(null)
                  setMessage(`恢复前的数据备份：${result.safetyBackupPath}`)
                  toast.success("数据恢复完成", { id: "database-action" })
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
