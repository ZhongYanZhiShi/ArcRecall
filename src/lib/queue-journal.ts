import type { QueueItem, QueueSnapshot } from "./recovery-queue"

export type JournalItem = Pick<
  QueueItem,
  "id" | "path" | "state" | "stamp" | "blockedReason"
> & {
  options?: {
    outputDirectory?: string | null
    exactOutputDirectory?: string | null
    recursive?: boolean
    computeMode?: "gpuPreferred" | "cpuOnly"
  }
}
export type Journal = { version: 1; enabled: boolean; items: JournalItem[] }

/** An allowlist: never spread a task/options object into a persisted record. */
export function journalItems(snapshot: QueueSnapshot): JournalItem[] {
  return snapshot.items.map(
    ({ id, path, state, options, stamp, blockedReason }) => ({
      id,
      path,
      state,
      stamp,
      blockedReason,
      options: options
        ? {
            outputDirectory: options.outputDirectory,
            exactOutputDirectory: options.exactOutputDirectory,
            recursive: options.recursive,
            computeMode: options.computeMode,
          }
        : undefined,
    })
  )
}

export function createQueueJournal(
  queue: {
    getSnapshot: () => QueueSnapshot
    restore: (items: QueueItem[]) => void
    subscribe: (listener: () => void) => () => void
  },
  api: {
    load: () => Promise<Journal>
    save: (enabled: boolean, items: JournalItem[]) => Promise<void>
  }
) {
  let state = {
    ready: false,
    enabled: false,
    saving: false,
    restored: 0,
    error: null as string | null,
  }
  let initialization: Promise<void> | undefined
  let writes = Promise.resolve()
  let previous = ""
  const listeners = new Set<() => void>()
  const publish = (update: Partial<typeof state>) => {
    state = { ...state, ...update }
    listeners.forEach((listener) => listener())
  }
  const save = (enabled: boolean) => {
    const items = journalItems(queue.getSnapshot())
    const serialized = JSON.stringify(items)
    previous = serialized
    publish({ saving: true })
    const next = writes.catch(() => {}).then(() => api.save(enabled, items))
    writes = next
    void next.then(
      () => {
        if (writes === next) publish({ saving: false, error: null })
      },
      (error: unknown) => {
        if (writes === next) publish({ saving: false, error: String(error) })
      }
    )
    return next
  }
  queue.subscribe(() => {
    if (
      state.ready &&
      state.enabled &&
      previous !== JSON.stringify(journalItems(queue.getSnapshot()))
    )
      void save(true).catch(() => {})
  })
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    initialize() {
      initialization ??= api
        .load()
        .then((journal) => {
          if (journal.enabled)
            queue.restore(
              journal.items.map((item) => ({
                ...item,
                task: null,
                error: null,
              }))
            )
          previous = JSON.stringify(journalItems(queue.getSnapshot()))
          publish({
            enabled: journal.enabled,
            restored: journal.items.length,
            ready: true,
          })
        })
        .catch((error: unknown) => {
          publish({ ready: true, error: String(error) })
        })
      return initialization
    },
    async setEnabled(enabled: boolean) {
      if (!state.ready) return
      // Serialize the preference transition with checkpoints. While it is in flight,
      // a queue notification must not re-create a file that is being disabled.
      publish({ ready: false })
      try {
        await save(enabled)
        publish({
          enabled,
          error: null,
          restored: enabled ? state.restored : 0,
        })
        if (
          enabled &&
          previous !== JSON.stringify(journalItems(queue.getSnapshot()))
        )
          await save(true)
      } finally {
        publish({ ready: true })
      }
    },
    async flush() {
      await initialization
      if (!state.enabled) return false
      await writes
      return true
    },
  }
}
