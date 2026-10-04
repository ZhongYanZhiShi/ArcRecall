import {
  analyzeArchive,
  startRecovery,
  getRecoveryStatus,
  cancelRecovery,
  openOutputDirectory,
} from "@/lib/recovery"
import { createRecoveryQueue } from "@/lib/recovery-queue"
import { createQueueJournal, type Journal } from "@/lib/queue-journal"
import { invoke } from "@tauri-apps/api/core"
import { isDesktopRuntime } from "@/lib/dictionary"

export const recoveryQueue = createRecoveryQueue({
  analyze: analyzeArchive,
  start: startRecovery,
  status: getRecoveryStatus,
  cancel: cancelRecovery,
  openOutput: openOutputDirectory,
  wait: () => new Promise((resolve) => setTimeout(resolve, 700)),
  checkpoint: () => recoveryQueueJournal.flush(),
})

export const recoveryQueueJournal = createQueueJournal(recoveryQueue, {
  load: () =>
    isDesktopRuntime()
      ? invoke<Journal>("recovery_queue_load")
      : Promise.resolve({ version: 1, enabled: false, items: [] }),
  save: (enabled, items) => invoke("recovery_queue_save", { enabled, items }),
})
