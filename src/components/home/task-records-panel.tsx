"use client"

import * as React from "react"
import { toast } from "sonner"
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
import {
  listTaskRecords,
  deleteTaskRecord,
  type TaskRecord,
} from "@/lib/workflows"
import {
  recoveryQueue,
  recoveryQueueJournal,
} from "@/lib/recovery-queue-session"
import { openOutputDirectory, pickOutputDirectory } from "@/lib/recovery"
import { DictionaryGroupSelect } from "./dictionary-group-select"

const labels: Record<string, string> = {
  running: "运行中",
  success: "完成",
  partial: "部分完成",
  failed: "未完成",
  cancelled: "已取消",
  interrupted: "意外中断",
}
const failures: Record<string, string> = {
  Preparation:
    "启动检查未通过，请检查源文件、分卷、输出位置、字典分组和引擎配置。",
  InvalidArchive: "归档无效或分卷不完整",
  UnsupportedFormat: "格式不支持",
  MissingTool: "引擎未就绪",
  NotFound: "源文件不存在",
  Io: "文件读写失败",
  Process: "引擎执行失败",
  Other: "执行异常",
}

export function TaskRecordsPanel() {
  const [open, setOpen] = React.useState(false)
  const [rows, setRows] = React.useState<TaskRecord[]>([])
  const [failedOnly, setFailedOnly] = React.useState(false)
  const [page, setPage] = React.useState(0)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [selected, setSelected] = React.useState<TaskRecord | null>(null)
  const [password, setPassword] = React.useState("")
  const [output, setOutput] = React.useState<string | null>(null)
  const [group, setGroup] = React.useState<string | null>(null)
  const [revision, setRevision] = React.useState(0)
  const operation = React.useRef(false)
  React.useEffect(() => {
    if (!open) return
    let disposed = false
    void Promise.resolve()
      .then(() => {
        if (disposed) return []
        setBusy(true)
        setError(null)
        return listTaskRecords(page * 100, failedOnly)
      })
      .then((next) => {
        if (!disposed) setRows(next)
      })
      .catch((reason) => {
        if (!disposed) setError(String(reason))
      })
      .finally(() => {
        if (!disposed) setBusy(false)
      })
    return () => {
      disposed = true
    }
  }, [open, page, failedOnly, revision])
  async function retry(paths: string[], root: boolean) {
    if (!selected || operation.current) return
    operation.current = true
    setBusy(true)
    try {
      await recoveryQueueJournal.initialize()
      if (!recoveryQueueJournal.getSnapshot().ready)
        throw new Error("队列设置正在保存，请稍后重试。")
      recoveryQueue.enqueue(paths, {
        recursive: selected.recursive,
        computeMode: selected.computeMode,
        dictionaryGroup: group,
        knownPassword: password || null,
        ...(root && !output && selected.outputDirectory
          ? { exactOutputDirectory: selected.outputDirectory }
          : { outputDirectory: output }),
      })
      await recoveryQueueJournal.flush()
      setPassword("")
      setSelected(null)
      toast.success("已加入解压队列，请到解压页确认并开始。")
    } catch (reason) {
      setError(String(reason))
    } finally {
      operation.current = false
      setBusy(false)
    }
  }
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        任务记录
      </Button>
      <Sheet
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) {
            setPassword("")
            setSelected(null)
          }
        }}
      >
        <SheetContent className="flex w-full flex-col sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>任务记录与重试</SheetTitle>
            <SheetDescription>
              记录恢复任务的路径、选项与结果，不保存密码。重试会重新检查源文件并避免覆盖已有输出；不恢复引擎进度。
            </SheetDescription>
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4">
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setFailedOnly(!failedOnly)
                  setPage(0)
                }}
              >
                {failedOnly ? "显示全部任务" : "只看未完成"}
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setRevision(revision + 1)}
              >
                刷新记录
              </Button>
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            {selected && (
              <div className="space-y-2 rounded-lg border p-3">
                <p className="text-sm break-all">
                  重试：{selected.archivePath}
                </p>
                <Input
                  aria-label="重试已知密码"
                  type="password"
                  autoComplete="off"
                  placeholder="已知密码（可选）"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={busy}
                />
                <DictionaryGroupSelect
                  value={group}
                  onChange={setGroup}
                  disabled={busy}
                />
                <p className="text-xs break-all text-muted-foreground">
                  {output
                    ? `输出父目录：${output}`
                    : `原输出位置（冲突时新建）：${selected.outputDirectory}`}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void pickOutputDirectory()
                        .then((path) => {
                          if (path) setOutput(path)
                        })
                        .catch((e) => setError(String(e)))
                    }
                  >
                    更换输出位置
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() => void retry([selected.archivePath], true)}
                  >
                    整包加入队列
                  </Button>
                  {selected.pendingArchivePaths.length > 0 && (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void retry(selected.pendingArchivePaths, false)
                      }
                    >
                      仅重试未完成归档
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setSelected(null)
                      setPassword("")
                    }}
                  >
                    取消
                  </Button>
                </div>
              </div>
            )}
            <ScrollArea className="min-h-0 flex-1">
              <div className="space-y-3">
                {rows.map((row) => (
                  <div
                    key={row.taskId}
                    className="space-y-2 rounded-lg border p-3"
                  >
                    <p className="text-sm break-all">{row.archivePath}</p>
                    <p className="text-xs text-muted-foreground">
                      {labels[row.state] ?? row.state} ·{" "}
                      {new Date(row.startedAtMs).toLocaleString("zh-CN")} ·{" "}
                      {(row.elapsedMs / 1000).toFixed(1)} 秒
                    </p>
                    {row.state === "failed" && (
                      <p className="text-sm">
                        {row.failureKind
                          ? (failures[row.failureKind] ?? "执行失败")
                          : "当前候选未找到密码，请补充密码或字典后重试。"}
                      </p>
                    )}
                    {row.pendingArchivePaths.length > 0 && (
                      <details className="text-xs">
                        <summary>
                          {row.pendingArchivePaths.length} 个归档未完成
                        </summary>
                        {row.pendingArchivePaths.map((path, index) => (
                          <p className="break-all" key={index}>
                            {path}
                          </p>
                        ))}
                      </details>
                    )}
                    {row.skippedScanDirectories.length > 0 && (
                      <details className="text-xs">
                        <summary>
                          {row.skippedScanDirectories.length} 个目录未扫描
                        </summary>
                        {row.skippedScanDirectories.map((path) => (
                          <p key={path} className="break-all">
                            {path}
                          </p>
                        ))}
                        <p>可到解压设置调整扫描阈值后重新处理原归档。</p>
                      </details>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy || row.state === "running"}
                        onClick={() => {
                          setSelected(row)
                          setPassword("")
                          setOutput(null)
                          setGroup(row.dictionaryGroup)
                          setError(null)
                        }}
                      >
                        准备重试
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!row.outputDirectory}
                        onClick={() =>
                          void openOutputDirectory(row.outputDirectory).catch(
                            (e) => setError(String(e))
                          )
                        }
                      >
                        打开输出
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy || row.state === "running"}
                        onClick={() => {
                          if (operation.current) return
                          operation.current = true
                          setBusy(true)
                          void deleteTaskRecord(row.taskId)
                            .then(() => setRevision((v) => v + 1))
                            .catch((e) => setError(String(e)))
                            .finally(() => {
                              operation.current = false
                              setBusy(false)
                            })
                        }}
                      >
                        删除记录
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
              {!busy && rows.length === 0 && (
                <p className="text-sm text-muted-foreground">暂无任务记录。</p>
              )}
            </ScrollArea>
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={busy || page === 0}
                onClick={() => setPage(page - 1)}
              >
                上一页
              </Button>
              <span className="self-center text-sm">第 {page + 1} 页</span>
              <Button
                variant="outline"
                disabled={busy || rows.length < 100}
                onClick={() => setPage(page + 1)}
              >
                下一页
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
