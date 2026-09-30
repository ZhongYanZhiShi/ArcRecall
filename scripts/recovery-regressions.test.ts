import assert from "node:assert/strict"
import test from "node:test"

import {
  isArchiveContainerFailure,
  recoveryComputeSummary,
  hasIncompleteRecursiveScan,
  recoveryStageLabel,
} from "../src/components/home/recovery-view-utils.ts"
import type { RecoveryTaskStatus } from "../src/lib/recovery.ts"

test("GPU 优先任务在基础校验失败时说明 GPU 尚未开始", () => {
  const failedTask = {
    completed: true,
    running: false,
    success: false,
    phase: "failed",
    computeMode: "gpuPreferred",
    failureKind: "invalidArchive",
    failurePhase: "verifying",
    gpuStarted: false,
  } as RecoveryTaskStatus

  const summary = recoveryComputeSummary(
    failedTask,
    "gpuPreferred",
    null,
    false
  )

  assert.match(summary, /尚未进入 GPU/)
  assert.match(summary, /基础校验失败/)
})

test("已完成任务的计算摘要使用任务快照而不是当前设置", () => {
  const failedTask = {
    completed: true,
    running: false,
    success: false,
    phase: "failed",
    computeMode: "cpuOnly",
    failureKind: "invalidArchive",
    failurePhase: "verifying",
    gpuStarted: false,
    engine: "7-Zip",
  } as RecoveryTaskStatus

  const summary = recoveryComputeSummary(
    failedTask,
    "gpuPreferred",
    null,
    false
  )

  assert.equal(summary, "本次实际使用：7-Zip")
})

test("归档容器失败由结构化字段识别，不依赖错误文案", () => {
  const failedTask = {
    phase: "failed",
    message: "localized message can change",
    failureKind: "invalidArchive",
  } as RecoveryTaskStatus

  assert.equal(isArchiveContainerFailure(failedTask), true)

  failedTask.failureKind = "io"
  failedTask.message = "归档无法继续验密：这段文案不再参与判断"
  assert.equal(isArchiveContainerFailure(failedTask), false)
})

test("解压成功与扫描覆盖分别判断，历史任务缺失新字段仍可显示", () => {
  const completed = { success: true, completed: true } as RecoveryTaskStatus
  assert.equal(hasIncompleteRecursiveScan(completed), false)
  for (const fields of [
    { skippedScanDirectories: ["F:/output/game"] },
    { scanInterrupted: true },
    { depthLimitReached: true },
    { countLimitReached: true },
    { budgetLimitReached: true },
    { pendingArchivePaths: ["F:/output/inner.zip"] },
    { skippedArchivePaths: ["F:/output/bad.zip"] },
  ])
    assert.equal(hasIncompleteRecursiveScan({ ...completed, ...fields }), true)
})

test("阶段标题去重并兼容旧版递归事件", () => {
  assert.equal(recoveryStageLabel("recursive", "递归解密"), "递归处理")
  assert.equal(recoveryStageLabel("recursive", null), "递归处理")
  assert.equal(recoveryStageLabel("hashcat", "Hashcat"), "Hashcat")
  assert.equal(recoveryStageLabel("verifying", "7-Zip"), "检查 · 7-Zip")
})
