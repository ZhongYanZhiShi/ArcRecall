"use client"

import * as React from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { QueuePresetApply } from "@/components/home/queue-preset-apply"
import { BatchIntegrityCheck } from "@/components/home/batch-integrity-check"
import {
  archiveNameFromPath,
  hasIncompleteRecursiveScan,
} from "@/components/home/recovery-view-utils"
import { archivePathKey, type QueueSnapshot } from "@/lib/recovery-queue"
import { recoveryQueue } from "@/lib/recovery-queue-session"

const LABELS = {
  waiting: "等待",
  analyzing: "识别中",
  running: "处理中",
  success: "已完成",
  failed: "失败",
  cancelled: "已取消",
}

export function RecoveryQueuePanel({
  queue,
  disabled,
  onStart,
  onView,
  onOpenOutput,
  knownPassword,
  onPasswordChange,
}: {
  queue: QueueSnapshot
  disabled: boolean
  onStart: () => void
  onView: (id: number) => void
  onOpenOutput: (path: string) => void
  knownPassword: string
  onPasswordChange: (value: string) => void
}) {
  const [selected, setSelected] = React.useState<Set<number>>(new Set())
  const [presetBusy, setPresetBusy] = React.useState(false)
  const [integrityBusy, setIntegrityBusy] = React.useState(false)
  if (queue.items.length === 0) return null
  const waiting = queue.items.filter(
    (item) => item.state === "waiting" && !item.blockedReason
  )
  const pending = waiting.length
  const selectedIds = queue.items
    .filter((item) => selected.has(item.id))
    .map((item) => item.id)
  const selectedWaitingIds = waiting
    .filter((item) => selected.has(item.id))
    .map((item) => item.id)
  const editingDisabled =
    disabled || queue.running || presetBusy || integrityBusy
  const failed = queue.items.some(
    (item) =>
      !item.blockedReason &&
      (item.state === "failed" || item.state === "cancelled")
  )
  const currentTask = queue.items.find(
    (item) => item.id === queue.currentItemId
  )?.task
  return (
    <section
      aria-label="批次队列"
      className="mt-3 shrink-0 rounded-2xl border bg-card p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">
          批次队列 · {queue.items.length} 项
        </p>
        <div className="flex flex-wrap gap-2">
          {queue.running ? (
            <>
              <Button
                size="xs"
                variant="outline"
                disabled={queue.stopping}
                onClick={() =>
                  queue.pauseRequested
                    ? recoveryQueue.cancelPause()
                    : recoveryQueue.pauseAfterCurrent()
                }
              >
                {queue.pauseRequested ? "取消暂停安排" : "当前项完成后暂停"}
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={
                  queue.cancelling || (queue.stopping && !currentTask?.running)
                }
                aria-busy={queue.cancelling}
                onClick={() => void recoveryQueue.stop()}
              >
                {queue.cancelling
                  ? "正在停止"
                  : queue.stopping && currentTask?.running
                    ? "再次请求停止"
                    : queue.stopping
                      ? "正在停止"
                      : "停止批次"}
              </Button>
            </>
          ) : (
            <>
              {failed ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={editingDisabled}
                  onClick={() => recoveryQueue.retryFailed()}
                >
                  将失败与取消项重新排队
                </Button>
              ) : null}
              <Button
                size="xs"
                variant="ghost"
                disabled={editingDisabled}
                onClick={() => recoveryQueue.clear()}
              >
                清空队列
              </Button>
              <Button
                size="xs"
                disabled={editingDisabled || pending === 0}
                onClick={onStart}
              >
                {pending > 0
                  ? `${queue.paused ? "继续处理" : "按顺序处理"} ${pending} 项`
                  : "暂无待处理任务"}
              </Button>
            </>
          )}
        </div>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        新任务按当前选项逐项处理，重试项保留原选项；失败后继续，停止会保留等待项。未启用任务记忆时，退出应用后队列清空。
      </p>
      {queue.pauseRequested || queue.paused ? (
        <p role="status" className="mt-2 text-xs text-primary">
          {queue.pauseRequested
            ? "已安排暂停：当前归档仍会完成处理，随后保留等待项。"
            : "队列已暂停，可调整等待项后继续处理。"}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          size="xs"
          variant="outline"
          disabled={editingDisabled || !pending}
          onClick={() => setSelected(new Set(waiting.map((item) => item.id)))}
        >
          选择等待项
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={editingDisabled || !selectedIds.length}
          onClick={() => setSelected(new Set())}
        >
          清除选择
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={editingDisabled || !selectedIds.length}
          onClick={() => {
            recoveryQueue.removeMany(selectedIds)
            setSelected(new Set())
          }}
        >
          移除所选 {selectedIds.length} 项
        </Button>
        <QueuePresetApply
          ids={selectedWaitingIds}
          disabled={disabled || queue.running || integrityBusy}
          onBusyChange={setPresetBusy}
        />
        <BatchIntegrityCheck
          paths={queue.items
            .filter((item) => selected.has(item.id))
            .map((item) => item.path)}
          disabled={disabled || queue.running || presetBusy}
          onBusyChange={setIntegrityBusy}
          onSelectPassed={(paths) =>
            setSelected(
              new Set(
                queue.items
                  .filter((item) =>
                    paths.some(
                      (path) =>
                        archivePathKey(path) === archivePathKey(item.path)
                    )
                  )
                  .map((item) => item.id)
              )
            )
          }
        />
      </div>
      <div className="mt-3 grid items-center gap-2 sm:grid-cols-[auto_1fr]">
        <Label htmlFor="batch-known-password" className="text-xs">
          本批次优先密码（可选）
        </Label>
        <Input
          id="batch-known-password"
          type="password"
          autoComplete="off"
          value={knownPassword}
          onChange={(event) => onPasswordChange(event.target.value)}
          disabled={editingDisabled}
          placeholder="留空使用历史密码和字典"
        />
      </div>
      {queue.error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {queue.error}
        </p>
      ) : null}
      <ol className="mt-2 max-h-52 space-y-1 overflow-y-auto p-1">
        {queue.items.map((item) => (
          <li
            key={item.id}
            className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg bg-muted/30 p-2 text-xs"
          >
            <Checkbox
              aria-label={`选择队列项 ${archiveNameFromPath(item.path)}`}
              checked={selected.has(item.id)}
              disabled={editingDisabled}
              onCheckedChange={(checked) =>
                setSelected((current) => {
                  const next = new Set(current)
                  if (checked) next.add(item.id)
                  else next.delete(item.id)
                  return next
                })
              }
            />
            <div className="min-w-0 flex-1 basis-32">
              <p className="truncate" title={item.path}>
                {archiveNameFromPath(item.path)}
              </p>
              {item.options?.computeMode ? (
                <p className="mt-1 text-muted-foreground">
                  {item.options.computeMode === "cpuOnly"
                    ? "仅 CPU"
                    : "GPU 优先"}
                  {item.options.recursive === undefined
                    ? ""
                    : item.options.recursive
                      ? " · 递归扫描"
                      : " · 不递归"}
                </p>
              ) : null}
              {item.error ? (
                <p className="mt-1 break-words text-destructive">
                  {item.error}
                </p>
              ) : null}
              {item.blockedReason ? (
                <p className="mt-1 text-destructive">{item.blockedReason}</p>
              ) : null}
            </div>
            <Badge
              variant={
                item.state === "success" &&
                item.task &&
                hasIncompleteRecursiveScan(item.task)
                  ? "warning"
                  : "secondary"
              }
            >
              {item.state === "success" &&
              item.task &&
              hasIncompleteRecursiveScan(item.task)
                ? item.task.skippedScanDirectories?.length
                  ? "待补扫"
                  : "部分完成"
                : LABELS[item.state]}
            </Badge>
            {item.task ? (
              <Button size="xs" variant="ghost" onClick={() => onView(item.id)}>
                详情
              </Button>
            ) : null}
            {item.task?.rootExtractionCompleted ? (
              <Button
                size="xs"
                variant="ghost"
                onClick={() => onOpenOutput(item.task!.outputDirectory)}
              >
                打开输出目录
              </Button>
            ) : null}
            {!queue.running ? (
              <>
                {item.state === "waiting" && !item.blockedReason ? (
                  <>
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label={`上移 ${archiveNameFromPath(item.path)}`}
                      disabled={editingDisabled || waiting[0]?.id === item.id}
                      onClick={() => recoveryQueue.moveWaiting(item.id, "up")}
                    >
                      上移
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label={`下移 ${archiveNameFromPath(item.path)}`}
                      disabled={
                        editingDisabled || waiting.at(-1)?.id === item.id
                      }
                      onClick={() => recoveryQueue.moveWaiting(item.id, "down")}
                    >
                      下移
                    </Button>
                  </>
                ) : null}
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={editingDisabled}
                  aria-label={`移除 ${archiveNameFromPath(item.path)}`}
                  onClick={() => recoveryQueue.remove(item.id)}
                >
                  移除
                </Button>
              </>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  )
}
