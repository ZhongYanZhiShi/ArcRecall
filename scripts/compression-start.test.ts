import assert from "node:assert/strict"
import test from "node:test"

import {
  CompressionRenameError,
  startCompressionWithRename,
} from "../src/lib/compression-start.ts"

test("AI 命名失败保留原草稿，使用原名称时跳过 AI", async () => {
  let draftName = "用户原名称"
  let starts = 0
  const start = async (name: string) => {
    starts += 1
    return name
  }
  const onRenamed = (name: string) => {
    draftName = name
  }
  await assert.rejects(
    startCompressionWithRename(draftName, {
      rename: async () => {
        throw new Error("模型不可用")
      },
      onRenamed,
      start,
    }),
    (error: unknown) =>
      error instanceof CompressionRenameError && error.message === "模型不可用"
  )
  assert.equal(draftName, "用户原名称")
  assert.equal(starts, 0)

  draftName = "用户重新编辑的名称"
  assert.equal(
    await startCompressionWithRename(draftName, { onRenamed, start }),
    "用户重新编辑的名称"
  )
  assert.equal(starts, 1)
})

test("AI 命名成功后的压缩启动失败保留真实错误归因", async () => {
  const failure = new Error("输出目录不可写")
  let draftName = "原名称"
  await assert.rejects(
    startCompressionWithRename(draftName, {
      rename: async () => "生成的名称",
      onRenamed: (name) => {
        draftName = name
      },
      start: async (name) => {
        assert.equal(name, "生成的名称")
        throw failure
      },
    }),
    (error: unknown) => error === failure
  )
  assert.equal(draftName, "生成的名称")
})

test("命名成功后使用生成名称启动并返回任务", async () => {
  const task = { taskId: "compression-1", running: true }
  const calls: string[] = []
  assert.equal(
    await startCompressionWithRename("原名称", {
      rename: async (name) => {
        calls.push(`rename:${name}`)
        return "生成的名称"
      },
      onRenamed: (name) => calls.push(`draft:${name}`),
      start: async (name) => {
        calls.push(`start:${name}`)
        return task
      },
    }),
    task
  )
  assert.deepEqual(calls, [
    "rename:原名称",
    "draft:生成的名称",
    "start:生成的名称",
  ])
})
