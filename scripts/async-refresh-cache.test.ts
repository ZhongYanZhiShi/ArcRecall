import assert from "node:assert/strict"
import test from "node:test"

import { createAsyncRefreshCache } from "../src/lib/async-refresh-cache.ts"

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

test("并发读取只执行一次探测，并复用成功结果", async () => {
  const pending = deferred<{ gpuAvailable: boolean }>()
  let calls = 0
  const cache = createAsyncRefreshCache(() => {
    calls += 1
    return pending.promise
  })

  const first = cache.get()
  const second = cache.get()

  assert.equal(calls, 1)
  pending.resolve({ gpuAvailable: true })
  assert.deepEqual(await Promise.all([first, second]), [
    { gpuAvailable: true },
    { gpuAvailable: true },
  ])

  assert.deepEqual(await cache.get(), { gpuAvailable: true })
  assert.equal(calls, 1)
})

test("手动刷新等待当前探测结束，刷新期间的读取获得新结果", async () => {
  const pending: Deferred<{ gpuAvailable: boolean }>[] = []
  let active = 0
  let maxActive = 0
  const cache = createAsyncRefreshCache(() => {
    const next = deferred<{ gpuAvailable: boolean }>()
    pending.push(next)
    active += 1
    maxActive = Math.max(maxActive, active)
    return next.promise.finally(() => {
      active -= 1
    })
  })

  const initial = cache.get()
  const refresh = cache.refresh()

  assert.equal(pending.length, 1)
  assert.equal(maxActive, 1)

  pending[0].resolve({ gpuAvailable: false })
  assert.deepEqual(await initial, { gpuAvailable: false })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(pending.length, 2)
  const duringRefresh = cache.get()
  pending[1].resolve({ gpuAvailable: true })

  assert.deepEqual(await Promise.all([refresh, duringRefresh]), [
    { gpuAvailable: true },
    { gpuAvailable: true },
  ])
  assert.equal(maxActive, 1)
  assert.deepEqual(await cache.get(), { gpuAvailable: true })
  assert.equal(pending.length, 2)
})
