"use client"

import * as React from "react"
import { Button } from "@/components/ui/button"
import { isDesktopRuntime } from "@/lib/dictionary"
import { recoveryQueueJournal } from "@/lib/recovery-queue-session"

export function QueueMemoryPanel({ disabled }: { disabled: boolean }) {
  const journal = React.useSyncExternalStore(
    recoveryQueueJournal.subscribe,
    recoveryQueueJournal.getSnapshot,
    recoveryQueueJournal.getSnapshot
  )
  return (
    <section
      aria-label="任务记忆"
      className="mt-3 rounded-xl border bg-card p-3 text-xs"
    >
      <label className="flex items-center gap-2 font-medium">
        <input
          type="checkbox"
          checked={journal.enabled}
          disabled={
            disabled || !journal.ready || journal.saving || !isDesktopRuntime()
          }
          onChange={(event) => {
            void recoveryQueueJournal
              .setEnabled(event.target.checked)
              .catch(() => {})
          }}
        />
        记住任务队列
        {journal.saving ? (
          <span className="font-normal text-muted-foreground">正在保存…</span>
        ) : null}
      </label>
      <p className="mt-1 leading-relaxed text-muted-foreground">
        默认关闭。启用后保存文件路径、选项和状态，不保存密码。重启后手动重新运行未完成项，计算进度不恢复。关闭会删除记录。
      </p>
      {journal.restored > 0 ? (
        <p className="mt-1">
          已找回 {journal.restored}{" "}
          项；需要时请重新输入密码。缺失或发生变化的文件需移除后重新添加。
        </p>
      ) : null}
      {journal.error ? (
        <div role="alert" className="mt-2 space-y-2 text-destructive">
          <p>任务记录读写失败：{journal.error}</p>
          <Button
            size="xs"
            variant="outline"
            disabled={disabled || journal.saving}
            onClick={() => {
              void recoveryQueueJournal.setEnabled(false).catch(() => {})
            }}
          >
            关闭记忆并删除记录
          </Button>
        </div>
      ) : null}
    </section>
  )
}
