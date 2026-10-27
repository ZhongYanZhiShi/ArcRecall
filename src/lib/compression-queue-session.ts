import {
  startCompression,
  getCompressionStatus,
  cancelCompression,
} from "@/lib/compression"
import { createCompressionQueue } from "@/lib/compression-queue"

import { invoke } from "@tauri-apps/api/core"
import { isDesktopRuntime } from "@/lib/runtime"
import type { CompressionQueueItem } from "@/lib/compression-queue"
let memory = {
  ready: false,
  enabled: false,
  saving: false,
  error: "",
  restored: 0,
}
const listeners = new Set<() => void>()
const publish = (patch: Partial<typeof memory>) => {
  memory = { ...memory, ...patch }
  listeners.forEach((fn) => fn())
}
let writes = Promise.resolve()
let initialization: Promise<void> | undefined
let previous = ""
export const compressionQueue = createCompressionQueue({
  ready: () => memory.ready,
  checkpoint: async () => {
    if (memory.enabled) await writes
  },
  start: startCompression,
  status: getCompressionStatus,
  cancel: cancelCompression,
  wait: () => new Promise((resolve) => setTimeout(resolve, 650)),
})

function items() {
  return compressionQueue.getSnapshot().items.map((item) => ({
    id: item.id,
    state: item.state,
    taskId: item.taskId ?? null,
    passwordRequired: item.passwordRequired,
    request: {
      sources: item.request.sources,
      baseName: item.request.baseName,
      outputDirectory: item.request.outputDirectory ?? null,
      format: item.request.format,
      level: item.request.level,
      encryptFileNames: item.request.encryptFileNames ?? false,
      verifyAfterCompression: item.request.verifyAfterCompression ?? false,
      volumeSizeMib: item.request.volumeSizeMib ?? null,
    },
  }))
}
function save(enabled: boolean) {
  const snapshot = items()
  previous = JSON.stringify(snapshot)
  publish({ saving: true })
  const next = writes
    .catch(() => {})
    .then(() =>
      invoke<void>("compression_queue_save", { enabled, items: snapshot })
    )
  writes = next
  void next.then(
    () => {
      if (writes === next) publish({ saving: false, error: "" })
    },
    (e) => {
      if (writes === next) publish({ saving: false, error: String(e) })
    }
  )
  return next
}
compressionQueue.subscribe(() => {
  if (memory.ready && memory.enabled && previous !== JSON.stringify(items()))
    void save(true).catch(() => {})
})
export const compressionQueueMemory = {
  getSnapshot: () => memory,
  subscribe(fn: () => void) {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  },
  initialize() {
    initialization ??= (
      isDesktopRuntime()
        ? invoke<{ enabled: boolean; items: CompressionQueueItem[] }>(
            "compression_queue_load"
          )
        : Promise.resolve({ enabled: false, items: [] })
    )
      .then((journal) => {
        if (journal.enabled) compressionQueue.restore(journal.items)
        previous = JSON.stringify(items())
        publish({
          ready: true,
          enabled: journal.enabled,
          restored: journal.items.length,
        })
      })
      .catch((e) => publish({ ready: true, error: String(e) }))
    return initialization
  },
  async setEnabled(enabled: boolean) {
    publish({ ready: false })
    try {
      await save(enabled)
      publish({ enabled, error: "" })
    } finally {
      publish({ ready: true })
    }
  },
}
