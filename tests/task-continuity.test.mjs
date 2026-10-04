import assert from "node:assert/strict"
import test from "node:test"
import { createRecoveryQueue } from "../src/lib/recovery-queue.ts"
import { createQueueJournal, journalItems } from "../src/lib/queue-journal.ts"
import { buildRecoveryReport } from "../src/lib/recovery-report.ts"

const task = {
  taskId: "example",
  archivePath: "C:/private/source.zip",
  outputDirectory: "C:/private/output",
  recoveredPassword: "$HEX[616263]",
  message: "secret message",
  events: [{ message: "secret event" }],
  success: true,
  completed: true,
  running: false,
  cancelled: false,
  archiveFormat: "zip",
  computeMode: "cpuOnly",
  recursiveEnabled: true,
  rootExtractionCompleted: true,
  candidateCount: 5,
  attemptedCount: 2,
  elapsedMs: 50,
  scannedFileCount: 3,
  depthLimitReached: false,
  countLimitReached: false,
  completedArchivePaths: ["C:/private/source.zip"],
  skippedArchivePaths: ["C:/private/nested.zip"],
  timings: [{ operation: "scan", durationMs: 5, secret: "must not export" }],
}
function queueApi(overrides = {}) {
  return {
    analyze: async (path) => ({
      archivePath: path,
      suggestedOutputDirectory: path + "-out",
    }),
    start: async () => task,
    status: async () => task,
    wait: async () => {},
    cancel: async () => true,
    openOutput: async () => {},
    ...overrides,
  }
}

test("报告仅导出白名单，默认不含路径，显式开启也不含密码和日志", () => {
  const report = buildRecoveryReport(task)
  assert.equal(report.summary.skippedArchives, 1)
  for (const includePaths of [false, true]) {
    const serialized = JSON.stringify(buildRecoveryReport(task, includePaths))
    for (const secret of [
      task.recoveredPassword,
      task.message,
      "secret event",
      "must not export",
    ])
      assert.ok(!serialized.includes(secret))
    assert.equal(serialized.includes("C:/private"), includePaths)
  }
})

test("任务记忆默认关闭，开启后串行写入并阻止密码和事件进入记录", async () => {
  const writes = []
  const queue = createRecoveryQueue(queueApi())
  const journal = createQueueJournal(queue, {
    load: async () => ({ version: 1, enabled: false, items: [] }),
    save: async (enabled, items) => writes.push({ enabled, items }),
  })
  await journal.initialize()
  queue.enqueue([task.archivePath], {
    knownPassword: task.recoveredPassword,
    computeMode: "cpuOnly",
  })
  assert.equal(writes.length, 0)
  await journal.setEnabled(true)
  await queue.start({})
  await journal.flush()
  assert.equal(writes.at(-1).items[0].state, "success")
  assert.ok(!JSON.stringify(writes).includes(task.recoveredPassword))
  assert.ok(
    !JSON.stringify(journalItems(queue.getSnapshot())).includes("events")
  )
  await journal.setEnabled(false)
  assert.equal(writes.at(-1).enabled, false)
})

test("恢复不会自动启动，丢失源文件不可执行，重试保留选项", async () => {
  const starts = []
  const queue = createRecoveryQueue(
    queueApi({
      start: async (request) => {
        starts.push(request)
        return task
      },
    })
  )
  const journal = createQueueJournal(queue, {
    load: async () => ({
      version: 1,
      enabled: true,
      items: [
        {
          id: 7,
          path: "a.zip",
          state: "running",
          options: { computeMode: "cpuOnly", recursive: false },
        },
        {
          id: 8,
          path: "missing.zip",
          state: "waiting",
          options: {},
          blockedReason: "missing",
        },
      ],
    }),
    save: async () => {},
  })
  await journal.initialize()
  assert.equal(starts.length, 0)
  assert.equal(queue.getSnapshot().items[0].state, "waiting")
  await queue.start({
    computeMode: "gpuPreferred",
    recursive: true,
    knownPassword: "reentered",
  })
  assert.equal(starts.length, 1)
  assert.equal(starts[0].computeMode, "cpuOnly")
  assert.equal(starts[0].recursive, false)
  assert.equal(starts[0].knownPassword, "reentered")
})

test("记录写入失败时不得启动原生任务，关闭记录后仍可执行", async () => {
  let fail = false
  let starts = 0
  let journal
  const queue = createRecoveryQueue(
    queueApi({
      checkpoint: () => journal.flush(),
      start: async () => {
        starts++
        return task
      },
    })
  )
  journal = createQueueJournal(queue, {
    load: async () => ({ version: 1, enabled: false, items: [] }),
    save: async () => {
      if (fail) throw new Error("disk full")
    },
  })
  await journal.initialize()
  await journal.setEnabled(true)
  fail = true
  queue.enqueue(["a.zip"])
  await queue.start({})
  assert.equal(starts, 0)
  assert.match(journal.getSnapshot().error, /disk full/)
  fail = false
  await journal.setEnabled(false)
  queue.retryFailed()
  await queue.start({})
  assert.equal(starts, 1)
})

test("单项恢复不会启动队列内其他等待项，重试已在队列中的归档只执行一次", async () => {
  const starts = []
  const queue = createRecoveryQueue(
    queueApi({
      start: async (request) => {
        starts.push(request)
        return task
      },
    })
  )
  queue.enqueue(["a.zip", "b.zip"])
  queue.enqueue(["a.zip"], { recursive: false, exactOutputDirectory: "C:/out" })
  const selected = queue.getSnapshot().items[0]
  await queue.start({}, selected.id)
  assert.equal(starts.length, 1)
  assert.equal(starts[0].outputDirectory, "C:/out")
  assert.equal(queue.getSnapshot().items[1].state, "waiting")
})

test("关闭记忆期间的队列变化不会重新创建记录，启用期间的变化会补写", async () => {
  const queue = createRecoveryQueue(queueApi())
  const writes = []
  let release
  let block = false
  const journal = createQueueJournal(queue, {
    load: async () => ({ version: 1, enabled: false, items: [] }),
    save: async (enabled, items) => {
      writes.push({ enabled, items })
      if (block) {
        block = false
        await new Promise((done) => {
          release = done
        })
      }
    },
  })
  await journal.initialize()
  block = true
  const enabling = journal.setEnabled(true)
  await new Promise((done) => setImmediate(done))
  queue.enqueue(["a.zip"])
  release()
  await enabling
  assert.equal(writes.at(-1).items.length, 1)
  block = true
  const disabling = journal.setEnabled(false)
  await new Promise((done) => setImmediate(done))
  queue.enqueue(["b.zip"])
  release()
  await disabling
  await journal.flush()
  assert.equal(writes.at(-1).enabled, false)
})

test("Windows 路径大小写和分隔符不同仍只启动选中项，允许输入新密码重试", async () => {
  const starts = []
  const queue = createRecoveryQueue(
    queueApi({
      start: async (request) => {
        starts.push(request)
        return task
      },
    })
  )
  queue.enqueue(["c:/files/demo.zip", "c:/files/other.zip"])
  const [id] = queue.enqueue(["C:\\FILES\\demo.zip"], {
    knownPassword: "old",
    computeMode: "cpuOnly",
  })
  assert.equal(typeof id, "number")
  await queue.start({ knownPassword: "new" }, id)
  assert.equal(starts.length, 1)
  assert.equal(starts[0].knownPassword, "new")
  assert.equal(queue.getSnapshot().items[1].state, "waiting")
})
