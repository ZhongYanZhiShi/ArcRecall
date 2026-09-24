import assert from "node:assert/strict"
import test from "node:test"

import { createRecoveryTaskSubscription } from "../src/lib/recovery-task-attachment.ts"
import { createRecoveryQueue } from "../src/lib/recovery-queue.ts"
import type { RecoveryTaskStatus } from "../src/lib/recovery.ts"

function task(taskId: string, running: boolean): RecoveryTaskStatus {
  return {
    taskId,
    running,
    completed: !running,
    success: !running,
    cancelled: false,
    archivePath: `${taskId}.zip`,
    outputDirectory: `/output/${taskId}`,
    message: running ? "正在解压" : "已完成",
  } as RecoveryTaskStatus
}

test("隐藏页面期间批次换任务并完成，重新订阅立即获得最后的结果", async () => {
  const resumePoll: Array<() => void> = []
  let sequence = 0
  const queue = createRecoveryQueue({
    analyze: async (path) => ({
      archivePath: path,
      fileName: path,
      format: "zip",
      formatLabel: "ZIP",
      fileSize: 1,
      volumeCount: 1,
      suggestedOutputDirectory: `/output/${path}`,
    }),
    start: async () => task(`task-${++sequence}`, true),
    status: async (id) => task(id, false),
    cancel: async () => true,
    wait: () => new Promise<void>((resolve) => resumePoll.push(resolve)),
    openOutput: async () => undefined,
  })
  const received: RecoveryTaskStatus[] = []
  const subscribe = createRecoveryTaskSubscription(queue, (next) => {
    received.push(next)
  })
  let unsubscribe = subscribe()
  queue.enqueue(["first.zip", "second.zip"])
  const completion = queue.start({})
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(received.at(-1)?.taskId, "task-1")
  assert.equal(received.at(-1)?.running, true)

  // Activity destroys the effects and preserves this subscription's identity.
  unsubscribe()
  resumePoll.shift()!()
  await new Promise((resolve) => setImmediate(resolve))
  resumePoll.shift()!()
  await completion
  assert.equal(queue.getSnapshot().running, false)
  assert.equal(received.length, 1)

  unsubscribe = subscribe()
  assert.equal(received.length, 2)
  assert.equal(received.at(-1)?.taskId, "task-2")
  assert.equal(received.at(-1)?.completed, true)
  unsubscribe()

  // Navigating after selecting another archive must not replay an old result.
  unsubscribe = subscribe()
  assert.equal(received.length, 2)
  unsubscribe()
})
