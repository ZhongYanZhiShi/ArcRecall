"use client"
import * as React from "react"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import { isDesktopRuntime } from "@/lib/runtime"
import {
  compressionQueue,
  compressionQueueMemory,
} from "@/lib/compression-queue-session"

const labels = {
  waiting: "等待",
  running: "处理中",
  success: "完成",
  failed: "未完成",
  cancelled: "已取消",
}
export function CompressionQueuePanel({
  onRun,
  disabled,
}: {
  onRun: () => Promise<void>
  disabled: boolean
}) {
  const snapshot = React.useSyncExternalStore(
    compressionQueue.subscribe,
    compressionQueue.getSnapshot,
    compressionQueue.getSnapshot
  )
  const memory = React.useSyncExternalStore(
    compressionQueueMemory.subscribe,
    compressionQueueMemory.getSnapshot,
    compressionQueueMemory.getSnapshot
  )
  React.useEffect(() => {
    void compressionQueueMemory.initialize()
  }, [])
  const [open, setOpen] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const invoke = (work: () => Promise<unknown>) => {
    setError(null)
    void work().catch((e) => setError(String(e)))
  }
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        压缩队列（{snapshot.items.length}）
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="overflow-y-auto sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>批量压缩队列</SheetTitle>
            <SheetDescription>
              逐项压缩，失败后继续。可开启队列记忆，重启后手动继续；暂停或停止后保留等待项。每项使用加入时的压缩选项，加密项统一使用本次启动时选择的密码。
            </SheetDescription>
          </SheetHeader>
          <div className="space-y-3 px-4 pb-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={memory.enabled}
                disabled={
                  !isDesktopRuntime() ||
                  !memory.ready ||
                  memory.saving ||
                  snapshot.running ||
                  disabled
                }
                onChange={(e) =>
                  invoke(() =>
                    compressionQueueMemory.setEnabled(e.target.checked)
                  )
                }
              />
              记住压缩队列
            </label>
            <p className="text-xs text-muted-foreground">
              只保存来源、选项和状态，不保存密码。恢复后检查来源与输出位置，中断项需手动重新排队；不会自动开始。
              {memory.restored > 0 ? `已恢复 ${memory.restored} 项。` : ""}
            </p>
            {memory.error && (
              <p role="alert" className="text-sm text-destructive">
                队列保存失败：{memory.error}
              </p>
            )}
            {(error || snapshot.error) && (
              <p role="alert" className="text-sm text-destructive">
                {error || snapshot.error}
              </p>
            )}
            <div className="flex flex-wrap gap-2 [&>button]:shrink-0">
              <Button
                disabled={
                  snapshot.running ||
                  disabled ||
                  !snapshot.items.some(
                    (item) =>
                      item.state === "waiting" || item.state === "running"
                  )
                }
                onClick={() => invoke(onRun)}
              >
                开始／继续队列
              </Button>
              <Button
                variant="outline"
                disabled={!snapshot.running}
                onClick={() =>
                  compressionQueue.pauseAfterCurrent(
                    !snapshot.pauseAfterCurrent
                  )
                }
              >
                {snapshot.pauseAfterCurrent
                  ? "取消暂停安排"
                  : "当前项完成后暂停"}
              </Button>
              <Button
                variant="outline"
                disabled={
                  !snapshot.running &&
                  !snapshot.items.some((item) => item.state === "running")
                }
                onClick={() => invoke(() => compressionQueue.stop())}
              >
                停止压缩队列
              </Button>
              <Button
                variant="outline"
                disabled={
                  snapshot.running ||
                  disabled ||
                  !snapshot.items.some(
                    (item) =>
                      item.state === "failed" || item.state === "cancelled"
                  )
                }
                onClick={() => compressionQueue.retryFailed()}
              >
                将失败项重新排队
              </Button>
              <Button
                variant="ghost"
                disabled={snapshot.running}
                onClick={() => compressionQueue.clearFinished()}
              >
                清理已结束项
              </Button>
            </div>
            {!snapshot.items.length && (
              <p className="text-sm text-muted-foreground">
                选择“每个来源分别压缩”，点击开始压缩即可创建批次。
              </p>
            )}
            {snapshot.items.map((item, index) => (
              <div
                key={item.id}
                className="space-y-2 rounded-md border p-3 text-sm"
              >
                <p className="break-all">
                  {index + 1}. {item.request.baseName} · {labels[item.state]}
                </p>
                <p className="text-xs break-all text-muted-foreground">
                  {item.request.sources.join("；")} ·{" "}
                  {item.request.format === "zip" ? "ZIP" : "7z"} ·{" "}
                  {item.request.verifyAfterCompression
                    ? "完成后校验"
                    : "不自动校验"}
                </p>
                {item.error && (
                  <p className="text-xs text-destructive">{item.error}</p>
                )}
                {item.result?.outputPath && (
                  <p className="text-xs break-all">
                    输出：{item.result.outputPath}
                  </p>
                )}
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={
                      snapshot.running ||
                      item.state !== "waiting" ||
                      index === 0
                    }
                    onClick={() => compressionQueue.move(item.id, -1)}
                  >
                    上移
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={
                      snapshot.running ||
                      item.state !== "waiting" ||
                      index === snapshot.items.length - 1
                    }
                    onClick={() => compressionQueue.move(item.id, 1)}
                  >
                    下移
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={snapshot.running || item.state === "running"}
                    onClick={() => compressionQueue.remove(item.id)}
                  >
                    移除
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
