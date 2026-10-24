import {
  startCompression,
  getCompressionStatus,
  cancelCompression,
} from "@/lib/compression"
import { createCompressionQueue } from "@/lib/compression-queue"

export const compressionQueue = createCompressionQueue({
  start: startCompression,
  status: getCompressionStatus,
  cancel: cancelCompression,
  wait: () => new Promise((resolve) => setTimeout(resolve, 650)),
})
