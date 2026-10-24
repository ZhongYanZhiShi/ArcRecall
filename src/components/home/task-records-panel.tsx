"use client"

import * as React from "react"
import { invoke } from "@tauri-apps/api/core"
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
  type TaskOperation,
  type TaskRecordQuery,
  runArchiveAction,
  cancelArchiveAction,
} from "@/lib/workflows"
import {
  recoveryQueue,
  recoveryQueueJournal,
} from "@/lib/recovery-queue-session"
import { openOutputDirectory, pickOutputDirectory } from "@/lib/recovery"
import { buildRecordDateRange } from "@/lib/task-record-search"
import { DictionaryGroupSelect } from "./dictionary-group-select"

const operations: Record<TaskOperation, string> = {
  recovery: "解压恢复",
  compression: "压缩",
  selectiveExtraction: "选择性解压",
  integrityCheck: "完整性检查",
  batchIntegrityCheck: "批量完整性检查",
}
const labels: Record<string, string> = {
  passed: "检查通过",
  waiting: "未检查",
  checking: "检查中",
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
  const [operationFilter, setOperationFilter] = React.useState<
    TaskOperation | ""
  >("")
  const [text, setText] = React.useState("")
  const [fromDate, setFromDate] = React.useState("")
  const [toDate, setToDate] = React.useState("")
  const [stateFilter, setStateFilter] = React.useState("")
  const [filters, setFilters] = React.useState<TaskRecordQuery>({})
  const [checked, setChecked] = React.useState<string[]>([])
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const [includePaths, setIncludePaths] = React.useState(false)
  const [exportPath, setExportPath] = React.useState<string | null>(null)
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
  const [activeAction, setActiveAction] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (!open) return
    let disposed = false
    void Promise.resolve()
      .then(() => {
        if (disposed) return []
        setBusy(true)
        setError(null)
        return listTaskRecords(
          page * 100,
          failedOnly,
          operationFilter || null,
          filters
        )
      })
      .then((next) => {
        if (!disposed) {
          setRows(next)
          setChecked([])
          setConfirmDelete(false)
        }
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
  }, [open, page, failedOnly, revision, operationFilter, filters])
  const query = { ...filters, failedOnly, operation: operationFilter || null }
  async function manage(action: () => Promise<void>) {
    if (operation.current) return
    operation.current = true
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (reason) {
      setError(String(reason))
    } finally {
      operation.current = false
      setBusy(false)
    }
  }
  async function retry(paths: string[], root: boolean) {
    if (!selected || operation.current) return
    operation.current = true
    setBusy(true)
    try {
      if (selected.operation && selected.operation !== "recovery") {
        const id = crypto.randomUUID()
        setActiveAction(id)
        if (selected.operation === "batchIntegrityCheck") {
          await invoke("archive_batch_check_run", {
            id,
            paths,
            password: password || null,
            retryFailed: false,
          })
        } else {
          await runArchiveAction(
            id,
            selected.archivePath,
            password,
            selected.operation === "selectiveExtraction"
              ? (selected.selectedPaths ?? [])
              : null,
            output
          )
        }
        setPassword("")
        setSelected(null)
        setRevision((v) => v + 1)
        toast.success("操作已结束，请查看最新任务记录。")
        return
      }
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
      setActiveAction(null)
      setRevision((v) => v + 1)
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
          if (operation.current) return
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
              统一保存解压、压缩与检查结果，不保存密码。检查结论仅代表记录中的检查时间，未展开检查嵌套归档。重试会重新验证文件。
            </SheetDescription>
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4">
            <div className="flex flex-wrap gap-2">
              <select
                aria-label="任务类型"
                className="h-9 rounded-md border bg-background px-2 text-sm"
                value={operationFilter}
                disabled={busy}
                onChange={(e) => {
                  setOperationFilter(e.target.value as TaskOperation | "")
                  setPage(0)
                }}
              >
                <option value="">全部类型</option>
                {Object.entries(operations).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
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
            <form
              className="grid grid-cols-2 gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                if (busy) return
                try {
                  const range = buildRecordDateRange(fromDate, toDate)
                  setFilters({ text, state: stateFilter || null, ...range })
                  setPage(0)
                  setError(null)
                } catch (reason) {
                  setError(String(reason))
                }
              }}
            >
              <Input
                className="col-span-2"
                aria-label="记录关键词"
                placeholder="搜索文件名或路径"
                maxLength={500}
                value={text}
                disabled={busy}
                onChange={(e) => setText(e.target.value)}
              />
              <label className="text-xs">
                开始日期
                <Input
                  aria-label="记录开始日期"
                  type="date"
                  value={fromDate}
                  disabled={busy}
                  onChange={(e) => setFromDate(e.target.value)}
                />
              </label>
              <label className="text-xs">
                结束日期
                <Input
                  aria-label="记录结束日期"
                  type="date"
                  value={toDate}
                  disabled={busy}
                  onChange={(e) => setToDate(e.target.value)}
                />
              </label>
              <select
                aria-label="记录状态"
                className="h-9 rounded-md border bg-background px-2 text-sm"
                disabled={busy}
                value={stateFilter}
                onChange={(e) => setStateFilter(e.target.value)}
              >
                <option value="">全部状态</option>
                {[
                  "running",
                  "success",
                  "partial",
                  "failed",
                  "cancelled",
                  "interrupted",
                ].map((state) => (
                  <option key={state} value={state}>
                    {labels[state]}
                  </option>
                ))}
              </select>
              <Button type="submit" variant="outline" disabled={busy}>
                查询记录
              </Button>
            </form>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  checked={includePaths}
                  disabled={busy}
                  onChange={(e) => setIncludePaths(e.target.checked)}
                />
                导出包含路径
              </label>
              {["json", "csv"].map((format) => (
                <Button
                  key={format}
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void manage(async () => {
                      const path = await invoke<string>("task_records_export", {
                        query,
                        format,
                        includePaths,
                      })
                      setExportPath(path)
                      toast.success("已导出全部匹配记录。")
                    })
                  }
                >
                  导出 {format.toUpperCase()}
                </Button>
              ))}
              <Button
                variant="outline"
                size="sm"
                disabled={busy || !rows.some((r) => r.state !== "running")}
                onClick={() => {
                  setChecked(
                    rows
                      .filter((r) => r.state !== "running")
                      .map((r) => r.taskId)
                  )
                  setConfirmDelete(false)
                }}
              >
                选择本页
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy || checked.length === 0}
                onClick={() => {
                  setChecked([])
                  setConfirmDelete(false)
                }}
              >
                清空选择
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || checked.length === 0}
                onClick={() => setConfirmDelete(true)}
              >
                删除所选（{checked.length}）
              </Button>
            </div>
            {confirmDelete && (
              <div className="space-y-2 rounded-lg border p-3">
                <p className="text-sm">
                  确认删除所选 {checked.length}{" "}
                  条任务记录？只删除记录，不删除源文件和输出文件；运行中的任务会保留。
                </p>
                <Button
                  disabled={busy}
                  onClick={() =>
                    void manage(async () => {
                      const count = await invoke<number>(
                        "task_records_delete",
                        { ids: checked }
                      )
                      setChecked([])
                      setConfirmDelete(false)
                      setSelected(null)
                      setPassword("")
                      setRevision((v) => v + 1)
                      toast.success(`已删除 ${count} 条任务记录。`)
                    })
                  }
                >
                  确认删除所选记录
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setConfirmDelete(false)}
                >
                  保留记录
                </Button>
              </div>
            )}
            {exportPath && (
              <p role="status" className="text-xs break-all">
                报告：{exportPath}
                <Button
                  variant="link"
                  size="sm"
                  onClick={() =>
                    void invoke("open_path", { path: exportPath }).catch((e) =>
                      setError(String(e))
                    )
                  }
                >
                  定位报告
                </Button>
              </p>
            )}
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
                {!selected.operation || selected.operation === "recovery" ? (
                  <>
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
                    </div>
                  </>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {selected.operation === "batchIntegrityCheck" &&
                      selected.checkItems?.some(
                        (item) => item.state !== "passed"
                      ) && (
                        <Button
                          variant="outline"
                          disabled={busy}
                          onClick={() =>
                            void retry(
                              selected
                                .checkItems!.filter(
                                  (item) => item.state !== "passed"
                                )
                                .map((item) => item.path),
                              true
                            )
                          }
                        >
                          仅重查未通过项
                        </Button>
                      )}
                    {selected.operation === "selectiveExtraction" && (
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
                        {output ? "已选择新输出位置" : "选择输出位置"}
                      </Button>
                    )}
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void retry(
                          selected.sourcePaths?.length
                            ? selected.sourcePaths
                            : [selected.archivePath],
                          true
                        )
                      }
                    >
                      {busy ? "正在执行…" : "重新执行"}
                    </Button>
                  </div>
                )}
                <div className="flex gap-2">
                  {activeAction && (
                    <Button
                      variant="outline"
                      onClick={() =>
                        void cancelArchiveAction(activeAction).catch((e) =>
                          setError(String(e))
                        )
                      }
                    >
                      停止当前操作
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
                    <label className="flex items-start gap-2 text-sm break-all">
                      <input
                        type="checkbox"
                        aria-label={`选择记录 ${row.taskId}`}
                        checked={checked.includes(row.taskId)}
                        disabled={busy || row.state === "running"}
                        onChange={(e) => {
                          setChecked((ids) =>
                            e.target.checked
                              ? [...ids, row.taskId]
                              : ids.filter((id) => id !== row.taskId)
                          )
                          setConfirmDelete(false)
                        }}
                      />
                      {row.archivePath}
                    </label>
                    <p className="text-xs text-muted-foreground">
                      {operations[row.operation ?? "recovery"]} ·{" "}
                      {labels[row.state] ?? row.state} ·{" "}
                      {new Date(row.startedAtMs).toLocaleString("zh-CN")} ·{" "}
                      {(row.elapsedMs / 1000).toFixed(1)} 秒
                    </p>
                    {row.state === "failed" && (
                      <p className="text-sm">
                        {row.failureKind
                          ? (failures[row.failureKind] ?? "执行失败")
                          : !row.operation || row.operation === "recovery"
                            ? "当前候选未找到密码，请补充密码或字典后重试。"
                            : "操作未完成，请检查源文件、密码和访问权限。"}
                      </p>
                    )}
                    {row.outputPath && (
                      <p className="text-xs break-all">
                        输出文件：{row.outputPath}
                      </p>
                    )}
                    {!!row.sourcePaths?.length && (
                      <details className="text-xs">
                        <summary>{row.sourcePaths.length} 个来源</summary>
                        {row.sourcePaths.map((path) => (
                          <p key={path} className="break-all">
                            {path}
                          </p>
                        ))}
                      </details>
                    )}
                    {!!row.selectedPaths?.length && (
                      <details className="text-xs">
                        <summary>
                          {row.selectedPaths.length} 个选择的条目
                        </summary>
                        {row.selectedPaths.map((path) => (
                          <p key={path} className="break-all">
                            {path}
                          </p>
                        ))}
                      </details>
                    )}
                    {!!row.checkItems?.length && (
                      <details className="text-xs">
                        <summary>
                          逐项检查结果（
                          {
                            row.checkItems.filter(
                              (item) => item.state === "passed"
                            ).length
                          }{" "}
                          / {row.checkItems.length} 通过）
                        </summary>
                        {row.checkItems.map((item, index) => (
                          <p key={index} className="break-all">
                            {item.path} · {labels[item.state] ?? item.state} ·{" "}
                            {item.checkedAtMs
                              ? new Date(item.checkedAtMs).toLocaleString(
                                  "zh-CN"
                                )
                              : "未完成检查"}
                          </p>
                        ))}
                      </details>
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
                      {row.operation !== "compression" && (
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
                      )}
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
