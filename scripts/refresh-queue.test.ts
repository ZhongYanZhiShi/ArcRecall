import assert from "node:assert/strict"
import test from "node:test"

import { createRefreshQueue } from "../src/lib/refresh-queue.ts"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test("刷新串行执行，并将等待中的筛选请求合并为最新一次", async () => {
  const queue = createRefreshQueue()
  const pending = deferred()
  const calls: string[] = []
  let active = 0
  let maxActive = 0
  const run = (query: string, wait = Promise.resolve()) =>
    queue.run(async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      calls.push(query)
      await wait
      active -= 1
    })
  const first = run("first", pending.promise)
  const replaced = run("outdated")
  const latest = run("latest")
  assert.deepEqual(calls, ["first"])
  assert.equal(queue.isRunning(), true)
  pending.resolve()
  await Promise.all([first, replaced, latest])
  assert.deepEqual(calls, ["first", "latest"])
  assert.equal(maxActive, 1)
  assert.equal(queue.isRunning(), false)
})

test("隐藏页面可取消尚未执行的刷新，失败后仍能继续工作", async () => {
  const queue = createRefreshQueue()
  const pending = deferred()
  const first = queue.run(() => pending.promise)
  let cancelledCalled = false
  const cancelled = queue.run(async () => {
    cancelledCalled = true
  })
  queue.clearPending()
  pending.resolve()
  await Promise.all([first, cancelled])
  assert.equal(cancelledCalled, false)
  await assert.rejects(
    queue.run(async () => {
      throw new Error("temporary")
    }),
    /temporary/
  )
  let recovered = false
  await queue.run(async () => {
    recovered = true
  })
  assert.equal(recovered, true)
})
