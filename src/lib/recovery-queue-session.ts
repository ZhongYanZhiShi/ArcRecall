import {
  analyzeArchive,
  startRecovery,
  getRecoveryStatus,
  cancelRecovery,
  openOutputDirectory,
} from "@/lib/recovery"
import { createRecoveryQueue } from "@/lib/recovery-queue"

export const recoveryQueue = createRecoveryQueue({
  analyze: analyzeArchive,
  start: startRecovery,
  status: getRecoveryStatus,
  cancel: cancelRecovery,
  openOutput: openOutputDirectory,
  wait: () => new Promise((resolve) => setTimeout(resolve, 700)),
})
