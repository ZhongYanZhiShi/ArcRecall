import type {
  ArchiveAnalysis,
  RecoveryStartRequest,
  RecoveryTaskStatus,
} from "./recovery"

export type QueueItem = {
  id: number
  path: string
  state:
    | "waiting"
    | "analyzing"
    | "running"
    | "success"
    | "failed"
    | "cancelled"
  task: RecoveryTaskStatus | null
  error: string | null
  options?: QueueOptions
  stamp?: SourceStamp[] | null
  blockedReason?: string | null
}
export type SourceStamp = { path: string; bytes: number; modifiedNanos: string }
export type QueueSnapshot = {
  currentItemId?: number
  items: QueueItem[]
  running: boolean
  stopping: boolean
  cancelling: boolean
  error: string | null
}
export type QueueOptions = Omit<
  RecoveryStartRequest,
  "archivePath" | "avoidOutputCollision" | "rescanTaskId" | "queueEntryId"
> & { openWhenDone?: boolean; exactOutputDirectory?: string | null }
type QueueApi = {
  analyze: (path: string) => Promise<ArchiveAnalysis>
  start: (request: RecoveryStartRequest) => Promise<RecoveryTaskStatus>
  status: (id: string) => Promise<RecoveryTaskStatus | null>
  cancel: (id: string) => Promise<boolean>
  wait: () => Promise<void>
  openOutput: (path: string) => Promise<void>
  checkpoint?: () => Promise<boolean>
}

function mergeChanged<T extends object>(current: T, update: Partial<T>): T {
  return (Object.keys(update) as (keyof T)[]).every((key) =>
    Object.is(current[key], update[key])
  )
    ? current
    : { ...current, ...update }
}

function archivePathKey(path: string) {
  return /^[a-z]:|^\\\\/i.test(path)
    ? path.replaceAll("/", "\\").toLowerCase()
    : path
}

export function uniqueArchivePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>()
  return paths
    .map((path) => path.trim().replace(/^"(.*)"$/, "$1"))
    .filter((path) => {
      if (!path) return false
      const key = archivePathKey(path)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

/** In-memory session queue. Scheduling outlives view subscriptions, while no
 * source path or password is written to browser storage. */
export function createRecoveryQueue(api: QueueApi) {
  let snapshot: QueueSnapshot = {
    items: [],
    running: false,
    stopping: false,
    cancelling: false,
    error: null,
  }
  let sequence = 0
  let activeTaskId: string | null = null
  let stopError: string | null = null
  const listeners = new Set<() => void>()
  const publish = (update: Partial<QueueSnapshot>) => {
    if (
      update.items &&
      update.items.length === snapshot.items.length &&
      update.items.every((item, index) => item === snapshot.items[index])
    ) {
      update = { ...update, items: snapshot.items }
    }
    const next = mergeChanged(snapshot, update)
    if (next === snapshot) return
    snapshot = next
    listeners.forEach((listener) => listener())
  }
  const patch = (
    id: number,
    update: Partial<QueueItem>,
    queueUpdate: Partial<Omit<QueueSnapshot, "items">> = {}
  ) =>
    publish({
      ...queueUpdate,
      items: snapshot.items.map((item) =>
        item.id === id ? mergeChanged(item, update) : item
      ),
    })
  const message = (error: unknown) =>
    error instanceof Error ? error.message : String(error)
  const stop = async () => {
    if (!snapshot.running || snapshot.cancelling) return
    const cancellingTaskId = activeTaskId
    if (!cancellingTaskId) {
      publish({ stopping: true })
      return
    }
    stopError = null
    publish({ stopping: true, cancelling: true, error: null })
    try {
      await api.cancel(cancellingTaskId)
    } catch (error) {
      if (activeTaskId === cancellingTaskId) {
        stopError = `停止请求失败，可再次请求停止：${message(error)}`
        publish({ error: stopError })
      }
    } finally {
      if (activeTaskId === cancellingTaskId) {
        publish({ cancelling: false })
      }
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    restore(items: QueueItem[]) {
      if (snapshot.running || snapshot.items.length)
        throw new Error("当前队列非空，不能覆盖。")
      sequence = Math.max(sequence, ...items.map((item) => item.id))
      publish({
        items: items.map((item) => ({
          ...item,
          task: null,
          error: null,
          state:
            item.state === "running" || item.state === "analyzing"
              ? "waiting"
              : item.state,
        })),
      })
    },
    enqueue(paths: readonly string[], options?: QueueOptions) {
      if (snapshot.running) throw new Error("请先停止批次后再添加文件。")
      const all = uniqueArchivePaths([
        ...snapshot.items.map((item) => item.path),
        ...paths,
      ])
      if (all.length > 200)
        throw new Error("单个批次最多 200 个归档，请分批添加。")
      const additions = all.slice(snapshot.items.length)
      const requestedKeys = uniqueArchivePaths(paths).map(archivePathKey)
      const retryKeys = options ? requestedKeys : []
      publish({
        items: [
          ...snapshot.items.map(
            (item): QueueItem =>
              retryKeys.includes(archivePathKey(item.path))
                ? {
                    id: ++sequence,
                    path: item.path,
                    state: "waiting",
                    options,
                    task: null,
                    error: null,
                  }
                : item
          ),
          ...additions.map(
            (path): QueueItem => ({
              id: ++sequence,
              path,
              state: "waiting",
              task: null,
              error: null,
              options,
            })
          ),
        ],
        error: null,
      })
      return snapshot.items
        .filter((item) => requestedKeys.includes(archivePathKey(item.path)))
        .map((item) => item.id)
    },
    remove(id: number) {
      if (!snapshot.running)
        publish({ items: snapshot.items.filter((item) => item.id !== id) })
    },
    clear() {
      if (!snapshot.running)
        publish({ items: [], error: null, currentItemId: undefined })
    },
    retryFailed() {
      if (!snapshot.running)
        publish({
          items: snapshot.items.map((item) =>
            !item.blockedReason &&
            (item.state === "failed" || item.state === "cancelled")
              ? { ...item, id: ++sequence, state: "waiting", error: null }
              : item
          ),
          error: null,
        })
    },
    stop,
    async start(options: QueueOptions, onlyItemId?: number) {
      if (
        snapshot.running ||
        !snapshot.items.some(
          (item) =>
            item.state === "waiting" &&
            !item.blockedReason &&
            (onlyItemId === undefined || item.id === onlyItemId)
        )
      )
        return
      publish({
        running: true,
        stopping: false,
        cancelling: false,
        error: null,
      })
      let lastOutput: string | null = null
      try {
        while (!snapshot.stopping) {
          const item = snapshot.items.find(
            (candidate) =>
              candidate.state === "waiting" &&
              !candidate.blockedReason &&
              (onlyItemId === undefined || candidate.id === onlyItemId)
          )
          if (!item) break
          const itemOptions = {
            ...options,
            ...item.options,
            knownPassword:
              options.knownPassword || item.options?.knownPassword || null,
          }
          patch(
            item.id,
            {
              state: "analyzing",
              task: null,
              error: null,
              options: itemOptions,
            },
            { currentItemId: item.id }
          )
          try {
            const analysis = await api.analyze(item.path)
            if (snapshot.stopping) {
              patch(item.id, { state: "waiting" })
              break
            }
            // Every item owns a unique output folder, including custom roots.
            const separator = itemOptions.outputDirectory?.includes("\\")
              ? "\\"
              : "/"
            const name =
              analysis.suggestedOutputDirectory.split(/[\\/]/).pop() ||
              "archive"
            const remembered = await api.checkpoint?.()
            if (snapshot.stopping) {
              patch(item.id, { state: "waiting" })
              break
            }
            let task = await api.start({
              ...(remembered ? { queueEntryId: item.id } : {}),
              archivePath: analysis.archivePath,
              outputDirectory:
                itemOptions.exactOutputDirectory ??
                (itemOptions.outputDirectory
                  ? `${itemOptions.outputDirectory.replace(/[\\/]+$/, "")}${separator}${name}`
                  : analysis.suggestedOutputDirectory),
              knownPassword: itemOptions.knownPassword,
              recursive: itemOptions.recursive,
              computeMode: itemOptions.computeMode,
              avoidOutputCollision: true,
            })
            activeTaskId = task.taskId
            patch(item.id, { state: "running", task })
            if (snapshot.stopping) await stop()
            while (task.running) {
              await api.wait()
              try {
                const next = await api.status(task.taskId)
                if (!next || next.taskId !== task.taskId)
                  throw new Error("无法确认当前任务状态")
                task = next
                if (task.running) {
                  patch(item.id, { task }, { error: stopError })
                }
              } catch (error) {
                // An uncertain IPC response must not start a second job.
                publish({ error: `正在重新连接当前任务：${message(error)}` })
              }
            }
            activeTaskId = null
            patch(
              item.id,
              {
                state: task.cancelled
                  ? "cancelled"
                  : task.success
                    ? "success"
                    : "failed",
                task,
                error: task.success ? null : task.message,
              },
              { error: null }
            )
            if (task.success) lastOutput = task.outputDirectory
          } catch (error) {
            patch(item.id, { state: "failed", error: message(error) })
          }
        }
        if (lastOutput && options.openWhenDone && !snapshot.stopping) {
          try {
            await api.openOutput(lastOutput)
          } catch (error) {
            publish({ error: message(error) })
          }
        }
      } finally {
        activeTaskId = null
        stopError = null
        publish({ running: false, stopping: false, cancelling: false })
        try {
          await api.checkpoint?.()
        } catch (error) {
          publish({ error: `任务记录保存失败：${message(error)}` })
        }
      }
    },
  }
}
