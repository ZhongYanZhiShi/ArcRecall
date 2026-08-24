import assert from "node:assert/strict"
import test from "node:test"

import { recoveryTaskAttachmentId } from "../src/lib/recovery-task-attachment.ts"

test("离开页面期间完成的恢复任务仍会重新连接到结果", () => {
  assert.equal(
    recoveryTaskAttachmentId({ taskId: "recovery-completed" }),
    "recovery-completed"
  )
})

test("没有桌面任务时不创建重新连接状态", () => {
  assert.equal(recoveryTaskAttachmentId(null), null)
})
