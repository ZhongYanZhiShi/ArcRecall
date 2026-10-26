import assert from "node:assert/strict"
import test from "node:test"
import { createCompressionQueue } from "../src/lib/compression-queue.ts"

const request = (name) => ({
  sources: [`C:/资料/${name}`],
  baseName: name,
  format: "zip",
  level: 5,
  verifyAfterCompression: true,
})
const finished = (taskId) => ({
  taskId,
  running: false,
  completed: true,
  success: true,
})
const deferred = () => {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test("批量压缩顺序可调整，启动失败继续后续项，快照排除密码", async () => {
  const starts = []
  const queue = createCompressionQueue({
    start: async (r) => {
      starts.push(r.baseName)
      if (r.baseName === "失败") throw new Error("来源不存在")
      assert.equal(r.password, "session-only")
      return finished(r.baseName)
    },
    status: async (id) => finished(id),
    cancel: async () => {},
    wait: async () => {},
  })
  queue.add(
    [
      { ...request("资料"), password: "must-not-store" },
      request("失败"),
      request("照片"),
    ],
    true
  )
  assert.ok(!JSON.stringify(queue.getSnapshot()).includes("must-not-store"))
  queue.move(queue.getSnapshot().items[2].id, -1)
  await queue.run({ password: "session-only" })
  assert.deepEqual(starts, ["资料", "照片", "失败"])
  assert.deepEqual(
    queue.getSnapshot().items.map((item) => item.state),
    ["success", "success", "failed"]
  )
  assert.ok(!JSON.stringify(queue.getSnapshot()).includes("session-only"))
  queue.retryFailed()
  assert.deepEqual(
    queue.getSnapshot().items.map((item) => item.state),
    ["success", "success", "waiting"]
  )
  await assert.rejects(queue.run(), /加密任务/)
})

test("当前项完成后暂停保留等待项，停止在启动响应前仍取消正确任务", async () => {
  const started = deferred()
  const cancellations = []
  const queue = createCompressionQueue({
    start: () => started.promise,
    status: async (id) => finished(id),
    cancel: async (id) => {
      cancellations.push(id)
    },
    wait: async () => {},
  })
  queue.add([request("资料"), request("照片")], false)
  const run = queue.run()
  queue.pauseAfterCurrent(true)
  started.resolve(finished("first"))
  await run
  assert.deepEqual(
    queue.getSnapshot().items.map((item) => item.state),
    ["success", "waiting"]
  )
  const pending = deferred()
  const stopped = createCompressionQueue({
    start: () => pending.promise,
    status: async (id) => ({
      ...finished(id),
      success: false,
      cancelled: true,
    }),
    cancel: async (id) => {
      cancellations.push(id)
    },
    wait: async () => {},
  })
  stopped.add([request("资料"), request("照片")], false)
  const stopping = stopped.run()
  await stopped.stop()
  pending.resolve(finished("cancel-me"))
  await stopping
  assert.deepEqual(cancellations, ["cancel-me"])
  assert.deepEqual(
    stopped.getSnapshot().items.map((item) => item.state),
    ["cancelled", "waiting"]
  )
})

test("状态读取失败暂停并保留任务 ID，继续不会重复启动", async () => {
  let starts = 0
  let failed = true
  const queue = createCompressionQueue({
    start: async () => {
      starts++
      return finished("native")
    },
    status: async (id) => {
      if (failed) throw new Error("暂时不可读取")
      return finished(id)
    },
    cancel: async () => {},
    wait: async () => {},
  })
  queue.add([request("资料")], false)
  await queue.run()
  assert.equal(queue.getSnapshot().items[0].state, "running")
  failed = false
  await queue.run()
  assert.equal(starts, 1)
  assert.equal(queue.getSnapshot().items[0].state, "success")
})

test("队列容量和无效批次不会部分加入，完成项可清理后重新导入", async () => {
  const queue = createCompressionQueue({
    start: async () => finished("unused"),
    status: async (id) => finished(id),
    cancel: async () => {},
    wait: async () => {},
  })
  assert.throws(() =>
    queue.add([request("资料"), { ...request("照片"), baseName: "" }], false)
  )
  assert.equal(queue.getSnapshot().items.length, 0)
  queue.add(
    Array.from({ length: 200 }, (_, index) => request(`资料-${index}`)),
    false
  )
  assert.throws(() => queue.add([request("额外")], false), /200/)
  assert.equal(queue.getSnapshot().items.length, 200)
  await queue.run()
  assert.ok(queue.getSnapshot().items.every((item) => item.state === "success"))
  queue.clearFinished()
  assert.equal(queue.getSnapshot().items.length, 0)
  queue.add([request("资料-0")], false)
  await queue.run()
  assert.equal(queue.getSnapshot().items[0].state, "success")
})

test("原生任务确认不存在时暂停剩余队列，允许明确重新排队而不自动重复", async () => {
  let starts = 0
  const queue = createCompressionQueue({
    start: async () => {
      starts++
      return finished("missing")
    },
    status: async () => null,
    cancel: async () => {},
    wait: async () => {},
  })
  queue.add([request("资料"), request("照片")], false)
  await queue.run()
  assert.equal(starts, 1)
  assert.deepEqual(
    queue.getSnapshot().items.map((item) => item.state),
    ["failed", "waiting"]
  )
  queue.retryFailed()
  assert.deepEqual(
    queue.getSnapshot().items.map((item) => item.state),
    ["waiting", "waiting"]
  )
})
