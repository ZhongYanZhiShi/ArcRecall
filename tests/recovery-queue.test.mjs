import assert from "node:assert/strict"
import test from "node:test"
import {
  createRecoveryQueue,
  uniqueArchivePaths,
} from "../src/lib/recovery-queue.ts"

const deferred = () => {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const analysis = (path) => ({
  archivePath: path,
  suggestedOutputDirectory: path.replace(/\.[^.]+$/, ""),
})
const finished = (id, success = true) => ({
  taskId: id,
  running: false,
  completed: true,
  success,
  cancelled: false,
  message: success ? "done" : "failed",
  outputDirectory: `out/${id}`,
})
const tick = async () => {
  for (let n = 0; n < 12; n++) await Promise.resolve()
}
const api = (overrides = {}) => ({
  analyze: async (path) => analysis(path),
  start: async (request) => finished(request.archivePath),
  status: async (id) => finished(id),
  cancel: async () => true,
  wait: async () => {},
  openOutput: async () => {},
  ...overrides,
})

test("批次按顺序执行、失败继续、独立输出且只重排失败项", async () => {
  const requests = []
  let first = true
  const queue = createRecoveryQueue(
    api({
      start: async (request) => {
        requests.push(request)
        const ok = !first || request.archivePath !== "C:/b.zip"
        return finished(request.archivePath, ok)
      },
    })
  )
  queue.enqueue(["C:/a.zip", "C:/b.zip", "c:\\A.zip"])
  await queue.start({
    outputDirectory: "D:\\output",
    knownPassword: " password ",
  })
  assert.deepEqual(
    queue.getSnapshot().items.map((item) => item.state),
    ["success", "failed"]
  )
  assert.deepEqual(
    requests.map((request) => request.outputDirectory),
    ["D:\\output\\a", "D:\\output\\b"]
  )
  assert.ok(
    requests.every(
      (request) =>
        request.avoidOutputCollision && request.knownPassword === " password "
    )
  )
  queue.retryFailed()
  first = false
  await queue.start({})
  assert.equal(requests.length, 3)
  assert.equal(requests[2].archivePath, "C:/b.zip")
  assert.ok(queue.getSnapshot().items.every((item) => item.state === "success"))
})

test("停止发生在启动响应返回前也会取消当前任务并保留等待项", async () => {
  const start = deferred()
  const cancels = []
  const queue = createRecoveryQueue(
    api({
      start: () => start.promise,
      cancel: async (id) => {
        cancels.push(id)
        return true
      },
      status: async (id) => ({ ...finished(id, false), cancelled: true }),
    })
  )
  queue.enqueue(["a.zip", "b.zip"])
  const run = queue.start({})
  await tick()
  await queue.stop()
  start.resolve({ ...finished("a"), running: true, completed: false })
  await run
  assert.deepEqual(cancels, ["a"])
  assert.deepEqual(
    queue.getSnapshot().items.map((item) => item.state),
    ["cancelled", "waiting"]
  )
})

test("状态查询失败不启动下一项，订阅离开后仍完成队列", async () => {
  let queries = 0
  let starts = 0
  const queue = createRecoveryQueue(
    api({
      start: async (request) => {
        starts++
        return { ...finished(request.archivePath), running: true }
      },
      status: async (id) => {
        queries++
        if (queries === 1) {
          assert.equal(starts, 1)
          throw new Error("IPC transient")
        }
        return finished(id)
      },
    })
  )
  const unsubscribe = queue.subscribe(() => {})
  queue.enqueue(["a.zip", "b.zip"])
  const run = queue.start({})
  unsubscribe()
  await queue.start({}) // Duplicate start is ignored synchronously.
  await run
  assert.equal(starts, 2)
  assert.equal(queries, 3)
  assert.equal(queue.getSnapshot().running, false)
})

test("输入去重保持 Unix 大小写，批次上限不会部分加入", () => {
  assert.deepEqual(
    uniqueArchivePaths(['  "C:/A.zip" ', "c:\\a.zip", "/a", "/A", ""]),
    ["C:/A.zip", "/a", "/A"]
  )
  const queue = createRecoveryQueue(api())
  assert.throws(
    () => queue.enqueue(Array.from({ length: 201 }, (_, n) => `${n}.zip`)),
    /200/
  )
  assert.equal(queue.getSnapshot().items.length, 0)
})

test("无变化的队列操作保留快照引用且不通知订阅者", () => {
  const queue = createRecoveryQueue(api())
  let notifications = 0
  queue.subscribe(() => notifications++)
  const empty = queue.getSnapshot()
  queue.clear()
  queue.enqueue([])
  queue.remove(999)
  queue.retryFailed()
  assert.equal(queue.getSnapshot(), empty)
  assert.equal(notifications, 0)

  queue.enqueue(["C:/a.zip"])
  const populated = queue.getSnapshot()
  queue.enqueue(["c:\\A.zip"])
  queue.remove(999)
  queue.retryFailed()
  assert.equal(queue.getSnapshot(), populated)
  assert.equal(notifications, 1)
})

test("重复轮询不刷新，重连与终态在一次通知中发布一致状态", async () => {
  const running = { ...finished("a"), running: true, completed: false }
  const completed = finished("a")
  const responses = [
    running,
    new Error("offline"),
    new Error("offline"),
    running,
    completed,
  ]
  const waits = []
  const queue = createRecoveryQueue(
    api({
      start: async () => running,
      wait: () => {
        const next = deferred()
        waits.push(next)
        return next.promise
      },
      status: async () => {
        const response = responses.shift()
        if (response instanceof Error) throw response
        return response
      },
    })
  )
  queue.enqueue(["a.zip"])
  const run = queue.start({})
  await tick()
  const initial = queue.getSnapshot()
  const snapshots = []
  queue.subscribe(() => snapshots.push(queue.getSnapshot()))
  const poll = async () => {
    waits.shift().resolve()
    await tick()
  }

  await poll()
  assert.equal(queue.getSnapshot(), initial)
  assert.equal(snapshots.length, 0)
  await poll()
  assert.match(queue.getSnapshot().error, /offline/)
  assert.equal(snapshots.length, 1)
  const disconnected = queue.getSnapshot()
  await poll()
  assert.equal(queue.getSnapshot(), disconnected)
  assert.equal(snapshots.length, 1)
  await poll()
  assert.equal(queue.getSnapshot().error, null)
  assert.equal(queue.getSnapshot().items, initial.items)
  assert.equal(snapshots.length, 2)

  await poll()
  await run
  assert.equal(queue.getSnapshot().items[0].state, "success")
  assert.equal(
    snapshots.filter((snapshot) => snapshot.items[0].task === completed).length,
    2
  )
  assert.ok(
    snapshots.every(
      (snapshot) =>
        snapshot.items[0].task !== completed ||
        snapshot.items[0].state === "success"
    )
  )
})
