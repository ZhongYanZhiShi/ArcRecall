import type {
  CompressionStartRequest,
  CompressionTaskStatus,
} from "./compression"

type Credentials = Pick<
  CompressionStartRequest,
  "password" | "usePermanentPassword"
>
type Request = Omit<CompressionStartRequest, keyof Credentials>
export type CompressionQueueItem = {
  id: string
  request: Request
  passwordRequired: boolean
  state: "waiting" | "running" | "success" | "failed" | "cancelled"
  taskId?: string
  result?: CompressionTaskStatus
  error?: string
}
type Snapshot = {
  items: CompressionQueueItem[]
  running: boolean
  pauseAfterCurrent: boolean
  error: string | null
}
type Dependencies = {
  ready?: () => boolean
  checkpoint?: () => Promise<unknown>
  start: (request: CompressionStartRequest) => Promise<CompressionTaskStatus>
  status: (id: string) => Promise<CompressionTaskStatus | null>
  cancel: (id: string) => Promise<unknown>
  wait: () => Promise<void>
}

// Credentials live only in the active run's closure and are
// never exposed through snapshots, records, presets, or backups.
export function createCompressionQueue(deps: Dependencies) {
  let snapshot: Snapshot = {
    items: [],
    running: false,
    pauseAfterCurrent: false,
    error: null,
  }
  const listeners = new Set<() => void>()
  let sequence = 0
  let stopRequested = false
  const publish = (patch: Partial<Snapshot>) => {
    snapshot = { ...snapshot, ...patch }
    for (const listener of listeners) listener()
  }
  const patchItem = (id: string, patch: Partial<CompressionQueueItem>) =>
    publish({
      items: snapshot.items.map((item) =>
        item.id === id ? { ...item, ...patch } : item
      ),
    })
  const queue = {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    restore(items: CompressionQueueItem[]) {
      if (snapshot.running || snapshot.items.length)
        throw new Error("当前压缩队列非空，不能覆盖。")
      publish({
        items: items.map((item) => ({
          ...item,
          id: `compression-queue-${++sequence}`,
          taskId: undefined,
          result: undefined,
          state: item.state === "running" ? "cancelled" : item.state,
          error:
            item.state === "failed"
              ? "来源或输出目录已失效，请检查后重新排队。"
              : item.state === "cancelled"
                ? "上次任务已中断，请查看任务记录后决定是否重试。"
                : undefined,
        })),
      })
    },
    add(requests: Request[], passwordRequired: boolean) {
      if (deps.ready && !deps.ready())
        throw new Error("正在恢复压缩队列，请稍后重试。")
      if (snapshot.running) throw new Error("请先暂停压缩队列。")
      if (!requests.length || snapshot.items.length + requests.length > 200)
        throw new Error("压缩队列最多保留 200 项，请先清理已完成项。")
      const items = requests.map((request) => {
        if (!request.sources.length || !request.baseName.trim())
          throw new Error("每项需要来源和归档名称。")
        // Explicit allowlist: runtime callers cannot smuggle credentials in.
        return {
          id: `compression-queue-${++sequence}`,
          request: {
            volumeSizeMib: request.volumeSizeMib,
            sources: [...request.sources],
            baseName: request.baseName,
            outputDirectory: request.outputDirectory,
            format: request.format,
            level: request.level,
            encryptFileNames: request.encryptFileNames,
            verifyAfterCompression: request.verifyAfterCompression,
          },
          passwordRequired,
          state: "waiting" as const,
        }
      })
      publish({ items: [...snapshot.items, ...items], error: null })
    },
    move(id: string, offset: -1 | 1) {
      if (snapshot.running) return
      const items = [...snapshot.items]
      const index = items.findIndex((item) => item.id === id)
      const other = index + offset
      if (
        index < 0 ||
        other < 0 ||
        other >= items.length ||
        items[index].state !== "waiting" ||
        items[other].state !== "waiting"
      )
        return
      ;[items[index], items[other]] = [items[other], items[index]]
      publish({ items })
    },
    remove(id: string) {
      if (snapshot.running) return
      publish({
        items: snapshot.items.filter(
          (item) => item.id !== id || item.state === "running"
        ),
      })
    },
    clearFinished() {
      if (snapshot.running) return
      publish({
        items: snapshot.items.filter(
          (item) => item.state === "waiting" || item.state === "running"
        ),
      })
    },
    retryFailed() {
      if (snapshot.running) return
      publish({
        items: snapshot.items.map((item) =>
          item.state === "failed" || item.state === "cancelled"
            ? {
                ...item,
                state: "waiting",
                taskId: undefined,
                result: undefined,
                error: undefined,
              }
            : item
        ),
      })
    },
    pauseAfterCurrent(value: boolean) {
      publish({ pauseAfterCurrent: value })
    },
    async stop() {
      stopRequested = true
      publish({ pauseAfterCurrent: true })
      const active = snapshot.items.find((item) => item.state === "running")
      if (active?.taskId) await deps.cancel(active.taskId)
    },
    async run(credentials: Credentials = {}) {
      if (snapshot.running) return
      if (deps.ready && !deps.ready())
        throw new Error("正在恢复压缩队列，请稍后重试。")
      if (
        snapshot.items.some(
          (item) =>
            (item.state === "waiting" || item.state === "running") &&
            item.passwordRequired
        ) &&
        !credentials.password &&
        !credentials.usePermanentPassword
      )
        throw new Error("队列包含加密任务，请先重新输入密码或选择永久密码。")
      stopRequested = false
      publish({ running: true, pauseAfterCurrent: false, error: null })
      try {
        while (!stopRequested && !snapshot.pauseAfterCurrent) {
          const item =
            snapshot.items.find((item) => item.state === "running") ??
            snapshot.items.find((item) => item.state === "waiting")
          if (!item) break
          let taskId = item.taskId
          if (!taskId) {
            patchItem(item.id, { state: "running", error: undefined })
            await deps.checkpoint?.()
            try {
              const task = await deps.start({
                ...item.request,
                ...(item.passwordRequired ? credentials : {}),
              })
              taskId = task.taskId
              patchItem(item.id, { taskId })
            } catch (error) {
              patchItem(item.id, {
                state: stopRequested ? "cancelled" : "failed",
                error: String(error),
              })
              continue
            }
            await deps.checkpoint?.()
            if (stopRequested) await deps.cancel(taskId)
          }
          // A polling failure preserves the native task ID. Resuming observes
          // that same task rather than starting duplicate compression work.
          while (true) {
            const result = await deps.status(taskId)
            if (!result) {
              patchItem(item.id, {
                state: "failed",
                error:
                  "任务状态已不存在，请先查看任务记录，再决定是否重新排队。",
              })
              throw new Error(
                "无法找到当前压缩任务，队列已暂停，请检查任务记录。"
              )
            }
            patchItem(item.id, { result })
            if (!result.running) {
              patchItem(item.id, {
                state: result.success
                  ? "success"
                  : result.cancelled
                    ? "cancelled"
                    : "failed",
                error: result.success ? undefined : result.message,
              })
              break
            }
            await deps.wait()
          }
        }
      } catch (error) {
        publish({ error: String(error), pauseAfterCurrent: true })
      } finally {
        credentials = {}
        publish({ running: false })
      }
    },
  }
  return queue
}

export type CompressionQueue = ReturnType<typeof createCompressionQueue>
