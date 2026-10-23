import assert from "node:assert/strict"
import test from "node:test"
import {
  createRecoveryQueue,
  uniqueArchivePaths,
} from "../src/lib/recovery-queue.ts"
import { createQueueJournal } from "../src/lib/queue-journal.ts"

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
const tick = async () => {
  for (let n = 0; n < 20; n++) await Promise.resolve()
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
const api = (overrides = {}) => ({
  analyze: async (path) => analysis(path),
  start: async (request) => finished(request.archivePath),
  status: async (id) => finished(id),
  cancel: async () => true,
  wait: async () => {},
  openOutput: async () => {},
  ...overrides,
})
const preset = {
  name: "资料预设",
  outputDirectory: "D:/输出",
  recursive: false,
  computeMode: "cpuOnly",
  dictionaryGroup: "资料分组",
  openWhenDone: false,
}

test("普通路径和系统返回的 Windows 扩展路径在队列中按同一归档去重", () => {
  assert.deepEqual(
    uniqueArchivePaths([
      "C:/资料/归档.zip",
      "\\\\?\\C:\\资料\\归档.zip",
      "\\\\server\\共享\\归档.zip",
      "\\\\?\\UNC\\SERVER\\共享\\归档.zip",
    ]),
    ["C:/资料/归档.zip", "\\\\server\\共享\\归档.zip"]
  )
})

test("等待项调序保留任务身份和完成项位置，批量移除只影响所选项目", () => {
  const queue = createRecoveryQueue(api())
  queue.restore([
    { id: 1, path: "第一.zip", state: "waiting", task: null, error: null },
    { id: 2, path: "完成.zip", state: "success", task: null, error: null },
    { id: 3, path: "第二.zip", state: "waiting", task: null, error: null },
    {
      id: 4,
      path: "失效.zip",
      state: "waiting",
      task: null,
      error: null,
      blockedReason: "源文件已更改",
    },
  ])
  const original = queue.getSnapshot().items
  queue.moveWaiting(3, "up")
  assert.deepEqual(queue.getSnapshot().items, [
    original[2],
    original[1],
    original[0],
    original[3],
  ])
  queue.moveWaiting(3, "up")
  queue.moveWaiting(2, "down")
  queue.moveWaiting(4, "up")
  assert.deepEqual(
    queue.getSnapshot().items.map((item) => item.id),
    [3, 2, 1, 4]
  )
  queue.moveWaiting(3, "down")
  assert.deepEqual(queue.getSnapshot().items, original)
  queue.removeMany([1, 2, 999])
  assert.deepEqual(queue.getSnapshot().items, [original[2], original[3]])
})

test("选中等待项应用预设会重算输出目录，保留密码与源文件标识并排除预设名称", async () => {
  const requests = []
  const queue = createRecoveryQueue(
    api({
      start: async (request) => {
        requests.push(request)
        return finished(request.archivePath)
      },
    })
  )
  const stamp = [{ path: "C:/资料.zip", bytes: 12, modifiedNanos: "123" }]
  queue.restore([
    {
      id: 1,
      path: "C:/资料.zip",
      state: "waiting",
      task: null,
      error: null,
      stamp,
      options: {
        knownPassword: "session-secret",
        exactOutputDirectory: "C:/旧输出",
        recursive: true,
      },
    },
    { id: 2, path: "C:/完成.zip", state: "success", task: null, error: null },
    {
      id: 3,
      path: "C:/失效.zip",
      state: "waiting",
      task: null,
      error: null,
      blockedReason: "源文件已更改",
    },
    { id: 4, path: "C:/普通.zip", state: "waiting", task: null, error: null },
  ])
  const before = queue.getSnapshot().items
  assert.equal(queue.applyProcessingOptions([1, 2, 3], preset), 1)
  const updated = queue.getSnapshot().items
  assert.equal(updated[0].id, 1)
  assert.equal(updated[0].stamp, stamp)
  assert.equal(updated[0].options.knownPassword, "session-secret")
  assert.equal(Object.hasOwn(updated[0].options, "exactOutputDirectory"), false)
  assert.equal(Object.hasOwn(updated[0].options, "name"), false)
  assert.deepEqual(updated.slice(1), before.slice(1))
  await queue.start({ recursive: true }, 1)
  assert.equal(requests[0].outputDirectory, "D:/输出/资料")
  assert.equal(requests[0].knownPassword, "session-secret")
  assert.equal(requests[0].recursive, false)
  assert.equal(requests[0].dictionaryGroup, "资料分组")
})

for (const stage of ["analyze", "start"]) {
  test(`在${stage === "analyze" ? "识别阶段" : "启动响应前"}安排暂停会完成当前项并保留下一项，继续后按序执行`, async () => {
    const pending = deferred()
    const starts = []
    const cancels = []
    const queue = createRecoveryQueue(
      api({
        analyze: (path) =>
          stage === "analyze" && path === "第一.zip"
            ? pending.promise
            : Promise.resolve(analysis(path)),
        start: (request) => {
          starts.push(request.archivePath)
          return stage === "start" && request.archivePath === "第一.zip"
            ? pending.promise
            : Promise.resolve(finished(request.archivePath))
        },
        cancel: async (id) => {
          cancels.push(id)
          return true
        },
      })
    )
    queue.enqueue(["第一.zip", "第二.zip"])
    const run = queue.start({})
    await tick()
    queue.pauseAfterCurrent()
    assert.equal(queue.getSnapshot().pauseRequested, true)
    pending.resolve(
      stage === "analyze" ? analysis("第一.zip") : finished("第一.zip")
    )
    await run
    assert.deepEqual(starts, ["第一.zip"])
    assert.deepEqual(cancels, [])
    assert.equal(queue.getSnapshot().paused, true)
    assert.equal(queue.getSnapshot().running, false)
    assert.equal(queue.getSnapshot().pauseRequested, false)
    assert.deepEqual(
      queue.getSnapshot().items.map((item) => item.state),
      ["success", "waiting"]
    )
    await queue.start({})
    assert.deepEqual(starts, ["第一.zip", "第二.zip"])
    assert.equal(queue.getSnapshot().paused, false)
  })
}

test("运行中禁止调序移除和改写选项，暂停安排不会调用取消，取消安排后继续下一项", async () => {
  const pending = deferred()
  const requests = []
  let cancels = 0
  const queue = createRecoveryQueue(
    api({
      start: async (request) => {
        requests.push(request)
        return request.archivePath === "第一.zip"
          ? { ...finished("first"), running: true }
          : finished(request.archivePath)
      },
      wait: () => pending.promise,
      cancel: async () => {
        cancels++
        return true
      },
    })
  )
  const ids = queue.enqueue(["第一.zip", "第二.zip", "第三.zip"])
  const run = queue.start({})
  await tick()
  queue.pauseAfterCurrent()
  const before = queue.getSnapshot().items
  queue.moveWaiting(ids[2], "up")
  queue.removeMany(ids)
  assert.throws(() => queue.applyProcessingOptions(ids, preset), /暂停或结束/)
  assert.equal(queue.getSnapshot().items, before)
  assert.equal(cancels, 0)
  queue.cancelPause()
  pending.resolve()
  await run
  assert.equal(requests.length, 3)
  assert.equal(queue.getSnapshot().paused, false)
})

test("当前项识别失败或引擎失败后仍遵守暂停安排", async () => {
  for (const failAnalyze of [true, false]) {
    const pending = deferred()
    const queue = createRecoveryQueue(
      api({
        analyze: () => pending.promise,
        start: async () => finished("first", false),
      })
    )
    queue.enqueue(["第一.zip", "第二.zip"])
    const run = queue.start({})
    queue.pauseAfterCurrent()
    if (failAnalyze) pending.reject(new Error("识别失败"))
    else pending.resolve(analysis("第一.zip"))
    await run
    assert.equal(queue.getSnapshot().paused, true)
    assert.deepEqual(
      queue.getSnapshot().items.map((item) => item.state),
      ["failed", "waiting"]
    )
  }
})

test("立即停止覆盖暂停安排并取消启动中的任务，取消后不会显示为暂停", async () => {
  const pending = deferred()
  const cancels = []
  const queue = createRecoveryQueue(
    api({
      start: () => pending.promise,
      cancel: async (id) => {
        cancels.push(id)
        return true
      },
      status: async (id) => ({ ...finished(id, false), cancelled: true }),
    })
  )
  queue.enqueue(["第一.zip", "第二.zip"])
  const run = queue.start({})
  await tick()
  queue.pauseAfterCurrent()
  await queue.stop()
  assert.equal(queue.getSnapshot().pauseRequested, false)
  pending.resolve({ ...finished("first"), running: true })
  await run
  assert.deepEqual(cancels, ["first"])
  assert.equal(queue.getSnapshot().paused, false)
  assert.deepEqual(
    queue.getSnapshot().items.map((item) => item.state),
    ["cancelled", "waiting"]
  )
})

test("最后一项完成和仅处理指定项完成时不会因暂停安排留下虚假的暂停状态", async () => {
  for (const only of [false, true]) {
    const pending = deferred()
    const queue = createRecoveryQueue(api({ analyze: () => pending.promise }))
    const [id] = queue.enqueue(only ? ["第一.zip", "第二.zip"] : ["第一.zip"])
    const run = queue.start({}, only ? id : undefined)
    queue.pauseAfterCurrent()
    pending.resolve(analysis("第一.zip"))
    await run
    assert.equal(queue.getSnapshot().paused, false)
    assert.equal(queue.getSnapshot().pauseRequested, false)
    assert.deepEqual(
      queue.getSnapshot().items.map((item) => item.state),
      only ? ["success", "waiting"] : ["success"]
    )
  }
})

test("队列记忆按修改后的顺序保存预设选项并恢复，密码不进入持久记录", async () => {
  let stored = { version: 1, enabled: true, items: [] }
  const queue = createRecoveryQueue(api())
  const journalApi = {
    load: async () => structuredClone(stored),
    save: async (enabled, items) => {
      stored = { version: 1, enabled, items: structuredClone(items) }
    },
  }
  const journal = createQueueJournal(queue, journalApi)
  await journal.initialize()
  const ids = queue.enqueue(["第一.zip", "第二.zip", "第三.zip"], {
    knownPassword: "session-secret",
  })
  queue.moveWaiting(ids[2], "up")
  queue.applyProcessingOptions([ids[2]], preset)
  queue.removeMany([ids[0]])
  await journal.flush()
  assert.deepEqual(
    stored.items.map((item) => item.path),
    ["第三.zip", "第二.zip"]
  )
  assert.equal(stored.items[0].options.outputDirectory, "D:/输出")
  assert.equal(stored.items[0].options.dictionaryGroup, "资料分组")
  assert.equal(stored.items[0].options.openWhenDone, false)
  assert.equal(JSON.stringify(stored).includes("session-secret"), false)
  const restored = createRecoveryQueue(api())
  await createQueueJournal(restored, journalApi).initialize()
  assert.deepEqual(
    restored.getSnapshot().items.map((item) => item.id),
    [ids[2], ids[1]]
  )
  assert.equal(restored.getSnapshot().items[0].options.recursive, false)
  assert.equal(restored.getSnapshot().items[0].options.openWhenDone, false)
  queue.applyProcessingOptions([ids[2]], { ...preset, openWhenDone: true })
  await journal.flush()
  const restoredWithOpen = createRecoveryQueue(api())
  await createQueueJournal(restoredWithOpen, journalApi).initialize()
  assert.equal(
    restoredWithOpen.getSnapshot().items[0].options.openWhenDone,
    true
  )
  assert.equal(restored.getSnapshot().running, false)
})

test("选中等待项的完成后打开选项参与执行，而非仅使用批次默认值", async () => {
  const opened = []
  const queue = createRecoveryQueue(
    api({ openOutput: async (path) => opened.push(path) })
  )
  const ids = queue.enqueue(["资料.zip"])
  queue.applyProcessingOptions(ids, { ...preset, openWhenDone: true })
  await queue.start({ openWhenDone: false })
  assert.deepEqual(opened, ["out/资料.zip"])
})
