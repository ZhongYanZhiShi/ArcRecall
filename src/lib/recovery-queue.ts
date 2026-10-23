import type {
  ArchiveAnalysis,
  RecoveryStartRequest,
  RecoveryTaskStatus,
} from "./recovery"
import type { ProcessingOptions } from "./planning"

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
  pauseRequested: boolean
  paused: boolean
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

export function archivePathKey(path: string) {
  path = path.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "")
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

/** Skip an entire scanned volume group if any member already belongs to the queue. */
export function newScannedArchivePaths(
  existing: readonly string[],
  candidates: readonly { path: string; volumePaths?: readonly string[] }[]
): string[] {
  const seen = new Set(existing.map(archivePathKey))
  const additions: string[] = []
  for (const entry of candidates) {
    const members = [entry.path, ...(entry.volumePaths ?? [])].map(
      archivePathKey
    )
    if (members.some((path) => seen.has(path))) continue
    members.forEach((path) => seen.add(path))
    additions.push(entry.path)
  }
  return additions
}

/** In-memory session queue. Scheduling outlives view subscriptions, while no
 * source path or password is written to browser storage. */
export function createRecoveryQueue(api: QueueApi) {
  let snapshot: QueueSnapshot = {
    items: [],
    running: false,
    stopping: false,
    cancelling: false,
    pauseRequested: false,
    paused: false,
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
  const eligible = (item: QueueItem, onlyItemId?: number) =>
    item.state === "waiting" &&
    !item.blockedReason &&
    (onlyItemId === undefined || item.id === onlyItemId)
  const removeMany = (ids: readonly number[]) => {
    if (snapshot.running) return
    const removed = new Set(ids)
    const items = snapshot.items.filter((item) => !removed.has(item.id))
    publish({
      items,
      paused: snapshot.paused && items.some((item) => eligible(item)),
    })
  }
  const stop = async () => {
    if (!snapshot.running || snapshot.cancelling) return
    const cancellingTaskId = activeTaskId
    if (!cancellingTaskId) {
      publish({ stopping: true, pauseRequested: false })
      return
    }
    stopError = null
    publish({
      stopping: true,
      cancelling: true,
      pauseRequested: false,
      error: null,
    })
    try {
      await api.cancel(cancellingTaskId)
    } catch (error) {
      if (activeTaskId === cancellingTaskId) {
        stopError = `停止请求失败，可再次请求停止：${message(error)}`
        publish({ error: stopError, cancelling: false })
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
          ...snapshot.items.map((item): QueueItem =>
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
          ...additions.map((path): QueueItem => ({
            id: ++sequence,
            path,
            state: "waiting",
            task: null,
            error: null,
            options,
          })),
        ],
        error: null,
      })
      return snapshot.items
        .filter((item) => requestedKeys.includes(archivePathKey(item.path)))
        .map((item) => item.id)
    },
    remove(id: number) {
      removeMany([id])
    },
    removeMany,
    moveWaiting(id: number, direction: "up" | "down") {
      if (snapshot.running) return
      const positions = snapshot.items.flatMap((item, index) =>
        eligible(item) ? [index] : []
      )
      const position = positions.findIndex(
        (index) => snapshot.items[index].id === id
      )
      const neighbor = position + (direction === "up" ? -1 : 1)
      if (position < 0 || neighbor < 0 || neighbor >= positions.length) return
      const items = [...snapshot.items]
      const source = positions[position]
      const destination = positions[neighbor]
      ;[items[source], items[destination]] = [items[destination], items[source]]
      publish({ items })
    },
    applyProcessingOptions(ids: readonly number[], options: ProcessingOptions) {
      if (snapshot.running)
        throw new Error("请等待批次暂停或结束后再应用预设。")
      const selected = new Set(ids)
      let applied = 0
      publish({
        items: snapshot.items.map((item) => {
          if (!selected.has(item.id) || !eligible(item)) return item
          applied++
          const nextOptions = { ...item.options }
          delete nextOptions.exactOutputDirectory
          // Copy only processing fields, preserving a session-only password and
          // source identity. Preset names must never enter recovery requests.
          return {
            ...item,
            options: {
              ...nextOptions,
              outputDirectory: options.outputDirectory,
              recursive: options.recursive,
              computeMode: options.computeMode,
              dictionaryGroup: options.dictionaryGroup,
              openWhenDone: options.openWhenDone,
            },
          }
        }),
      })
      return applied
    },
    clear() {
      if (!snapshot.running)
        publish({
          items: [],
          error: null,
          currentItemId: undefined,
          paused: false,
        })
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
    pauseAfterCurrent() {
      if (snapshot.running && !snapshot.stopping)
        publish({ pauseRequested: true })
    },
    cancelPause() {
      if (snapshot.running) publish({ pauseRequested: false })
    },
    async start(options: QueueOptions, onlyItemId?: number) {
      if (
        snapshot.running ||
        !snapshot.items.some((item) => eligible(item, onlyItemId))
      )
        return
      publish({
        running: true,
        stopping: false,
        cancelling: false,
        paused: false,
        pauseRequested: false,
        error: null,
      })
      let lastOutput: string | null = null
      let openLastOutput = false
      let paused = false
      try {
        while (!snapshot.stopping) {
          const item = snapshot.items.find((candidate) =>
            eligible(candidate, onlyItemId)
          )
          if (!item) break
          if (snapshot.pauseRequested) {
            paused = true
            break
          }
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
              dictionaryGroup: itemOptions.dictionaryGroup,
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
            if (task.success) {
              lastOutput = task.outputDirectory
              openLastOutput = !!itemOptions.openWhenDone
            }
          } catch (error) {
            patch(item.id, { state: "failed", error: message(error) })
          }
        }
        if (lastOutput && openLastOutput && !snapshot.stopping) {
          try {
            await api.openOutput(lastOutput)
          } catch (error) {
            publish({ error: message(error) })
          }
        }
      } finally {
        activeTaskId = null
        stopError = null
        publish({
          running: false,
          stopping: false,
          cancelling: false,
          pauseRequested: false,
          paused: paused && !snapshot.stopping,
        })
        try {
          await api.checkpoint?.()
        } catch (error) {
          publish({ error: `任务记录保存失败：${message(error)}` })
        }
      }
    },
  }
}
