import assert from "node:assert/strict"
import test from "node:test"

import { createRecoveryQueue } from "../src/lib/recovery-queue.ts"
import type { RecoveryTaskStatus } from "../src/lib/recovery.ts"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function queueFixture(
  cancel: () => Promise<boolean>,
  beforeStatus?: () => void
) {
  let started = 0
  let running = true
  const polls: Array<() => void> = []
  const task = (taskId: string) =>
    ({
      taskId,
      running,
      completed: !running,
      success: !running,
      cancelled: false,
      outputDirectory: `/output/${taskId}`,
      message: running ? "正在解压" : "已完成",
    }) as RecoveryTaskStatus
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
    start: async () => task(`task-${++started}`),
    status: async (id) => {
      beforeStatus?.()
      return task(id)
    },
    cancel,
    wait: () => new Promise<void>((resolve) => polls.push(resolve)),
    openOutput: async () => undefined,
  })
  queue.enqueue(["first.zip", "second.zip"])
  return {
    queue,
    startedCount: () => started,
    poll: async () => {
      polls.shift()!()
      await new Promise((resolve) => setImmediate(resolve))
    },
    completeTask: () => {
      running = false
    },
  }
}

test("停止请求失败后可以重试，等待项继续保持停止且不会重复提交取消", async () => {
  const firstCancel = deferred<boolean>()
  const secondCancel = deferred<boolean>()
  let cancellationCalls = 0
  const fixture = queueFixture(() => {
    cancellationCalls += 1
    return cancellationCalls === 1 ? firstCancel.promise : secondCancel.promise
  })
  const { queue } = fixture
  const completion = queue.start({})
  await new Promise((resolve) => setImmediate(resolve))

  const firstStop = queue.stop()
  assert.equal(queue.getSnapshot().stopping, true)
  assert.equal(queue.getSnapshot().cancelling, true)
  await queue.stop()
  assert.equal(cancellationCalls, 1)
  firstCancel.reject(new Error("暂时无法连接"))
  await firstStop
  assert.equal(queue.getSnapshot().cancelling, false)
  assert.equal(queue.getSnapshot().stopping, true)
  assert.match(queue.getSnapshot().error ?? "", /可再次请求停止/)

  await fixture.poll()
  assert.match(queue.getSnapshot().error ?? "", /可再次请求停止/)
  const retry = queue.stop()
  assert.equal(queue.getSnapshot().cancelling, true)
  assert.equal(cancellationCalls, 2)
  secondCancel.resolve(true)
  await retry
  fixture.completeTask()
  await fixture.poll()
  await completion
  assert.equal(fixture.startedCount(), 1)
  assert.equal(queue.getSnapshot().items[1].state, "waiting")
  assert.equal(queue.getSnapshot().running, false)
  assert.equal(queue.getSnapshot().cancelling, false)
})

test("未重试失败的停止请求，当前任务完成后仍不会启动等待项", async () => {
  const fixture = queueFixture(async () => {
    throw new Error("无法连接")
  })
  const completion = fixture.queue.start({})
  await new Promise((resolve) => setImmediate(resolve))
  await fixture.queue.stop()
  fixture.completeTask()
  await fixture.poll()
  await completion
  assert.equal(fixture.startedCount(), 1)
  assert.equal(fixture.queue.getSnapshot().items[1].state, "waiting")
})

test("任务已结束后到达的取消错误不会覆盖已结束批次状态", async () => {
  const cancel = deferred<boolean>()
  const fixture = queueFixture(() => cancel.promise)
  const completion = fixture.queue.start({})
  await new Promise((resolve) => setImmediate(resolve))
  const stop = fixture.queue.stop()
  fixture.completeTask()
  await fixture.poll()
  await completion
  cancel.reject(new Error("迟到的取消错误"))
  await stop
  assert.equal(fixture.queue.getSnapshot().error, null)
  assert.equal(fixture.queue.getSnapshot().cancelling, false)
})

test("停止期间重新连通后清除断连提示，只保留仍适用的取消失败提示", async () => {
  for (const cancellationFails of [false, true]) {
    let queries = 0
    const fixture = queueFixture(
      async () => {
        if (cancellationFails) throw new Error("取消提交失败")
        return true
      },
      () => {
        if (++queries === 1) throw new Error("状态暂时断连")
      }
    )
    const completion = fixture.queue.start({})
    await new Promise((resolve) => setImmediate(resolve))
    await fixture.queue.stop()
    await fixture.poll()
    assert.match(fixture.queue.getSnapshot().error ?? "", /正在重新连接/)
    await fixture.poll()
    const connected = fixture.queue.getSnapshot()
    assert.equal(connected.stopping, true)
    assert.equal(connected.cancelling, false)
    if (cancellationFails) {
      assert.match(connected.error ?? "", /取消提交失败/)
    } else {
      assert.equal(connected.error, null)
    }
    fixture.completeTask()
    await fixture.poll()
    await completion
    assert.equal(fixture.startedCount(), 1)
    assert.equal(fixture.queue.getSnapshot().items[1].state, "waiting")
  }
})
