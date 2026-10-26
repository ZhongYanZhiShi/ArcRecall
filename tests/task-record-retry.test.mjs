import assert from "node:assert/strict"
import test from "node:test"
import { buildRecordRetryPlan } from "../src/lib/task-record-retry.ts"

test("根归档重试沿用原输出，重试剩余项与新输出不复用根目录", () => {
  const record = {
    recursive: true,
    computeMode: "cpuOnly",
    outputDirectory: "C:/原输出",
  }
  const options = { password: "", output: null, group: "测试分组" }
  assert.equal(
    buildRecordRetryPlan(record, ["C:/归档.zip"], true, options).options
      .exactOutputDirectory,
    "C:/原输出"
  )
  assert.equal(
    buildRecordRetryPlan(record, ["C:/内包.zip"], false, options).options
      .outputDirectory,
    null
  )
  assert.equal(
    buildRecordRetryPlan(record, [], true, { ...options, output: "D:/新输出" })
      .options.outputDirectory,
    "D:/新输出"
  )
})

test("重试计划区分批检查、选择解压和完整性检查，不借用记录中的旧密码", () => {
  const record = { archivePath: "C:/归档.zip", selectedPaths: ["资料.txt"] }
  const options = { password: "新密码", output: null, group: null }
  const batch = buildRecordRetryPlan(
    { ...record, operation: "batchIntegrityCheck" },
    ["C:/剩余.zip"],
    false,
    options
  )
  assert.deepEqual(batch, {
    kind: "batch",
    paths: ["C:/剩余.zip"],
    password: "新密码",
  })
  const selective = buildRecordRetryPlan(
    { ...record, operation: "selectiveExtraction" },
    [],
    true,
    options
  )
  assert.deepEqual(selective.selectedPaths, ["资料.txt"])
  const integrity = buildRecordRetryPlan(
    { ...record, operation: "integrityCheck" },
    [],
    true,
    options
  )
  assert.equal(integrity.selectedPaths, null)
  assert.throws(
    () =>
      buildRecordRetryPlan(
        { ...record, operation: "compression" },
        [],
        true,
        options
      ),
    /压缩页/
  )
})
