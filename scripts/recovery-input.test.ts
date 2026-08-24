import assert from "node:assert/strict"
import test from "node:test"

import { resolveDroppedArchivePath } from "../src/lib/recovery-input.ts"

test("单个拖入路径会进入归档分析", () => {
  assert.deepEqual(resolveDroppedArchivePath(["C:\\archives\\sample.7z"]), {
    path: "C:\\archives\\sample.7z",
    error: null,
  })
})

test("多个拖入路径不会静默忽略后续文件", () => {
  const resolution = resolveDroppedArchivePath([
    "C:\\archives\\first.7z",
    "C:\\archives\\second.zip",
  ])

  assert.equal(resolution.path, null)
  assert.match(resolution.error ?? "", /2 项/)
  assert.match(resolution.error ?? "", /未处理任何文件/)
})

test("空拖入事件不会制造错误状态", () => {
  assert.deepEqual(resolveDroppedArchivePath(["", "   "]), {
    path: null,
    error: null,
  })
})
