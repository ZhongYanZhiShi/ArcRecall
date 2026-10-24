import assert from "node:assert/strict"
import { mkdir, writeFile, access } from "node:fs/promises"
import { join } from "node:path"
import { expect } from "@playwright/test"

export async function verifyBatchCompression({ invoke, page, data, evidence }) {
  const directory = join(data, "[测试批次] 压缩来源")
  await mkdir(directory, { recursive: true })
  const sources = [
    join(directory, "资料.txt"),
    join(directory, "缺失.txt"),
    join(directory, "照片.txt"),
  ]
  await writeFile(sources[0], "batch first source")
  await writeFile(sources[2], "batch second source")
  await page.getByRole("button", { name: "压缩", exact: true }).click()
  await page
    .getByRole("button", { name: "每个来源分别压缩", exact: true })
    .click()
  await page.getByRole("switch", { name: "完成后校验", exact: true }).check()
  await page.getByRole("switch", { name: "完成后打开", exact: true }).uncheck()
  await page.getByLabel("批量压缩命名规则", { exact: true }).fill("批次-{name}")
  await expect
    .poll(async () => {
      await invoke("plugin:event|emit_to", {
        target: { kind: "Webview", label: "main" },
        event: "tauri://drag-drop",
        payload: { paths: sources, position: { x: 0, y: 0 } },
      })
      return page
        .getByTestId("compress-source-scroll")
        .getByText("照片.txt", { exact: true })
        .count()
    })
    .toBe(1)
  await page
    .getByRole("button", { name: "加入压缩队列，稍后开始", exact: true })
    .click()
  await page.getByRole("button", { name: "压缩队列（3）", exact: true }).click()
  const panel = page.getByRole("dialog", { name: "批量压缩队列", exact: true })
  await panel.getByRole("button", { name: "上移", exact: true }).nth(2).click()
  await panel
    .getByRole("button", { name: "开始／继续队列", exact: true })
    .click()
  await expect(
    panel.getByText(/来源不存在|无法访问|找不到|不存在/).first()
  ).toBeVisible({ timeout: 60000 })
  await expect(
    panel.getByRole("button", { name: "开始／继续队列", exact: true })
  ).toBeDisabled()
  const records = await invoke("task_records_list", {
    skip: 0,
    failedOnly: false,
    operation: "compression",
  })
  assert.equal(records.length, 3)
  const successes = records.filter((record) => record.state === "success")
  assert.equal(successes.length, 2)
  for (const record of successes) {
    assert.equal(record.compressionSucceeded, true)
    assert.equal(record.compressionVerification, "passed")
    assert.equal(record.compression.options.verifyAfterCompression, true)
    assert.ok(record.compression.baseName.startsWith("批次-"))
    await access(record.outputPath)
  }
  await writeFile(sources[1], "repaired missing source")
  await panel
    .getByRole("button", { name: "将失败项重新排队", exact: true })
    .click()
  await panel
    .getByRole("button", { name: "开始／继续队列", exact: true })
    .click()
  await expect
    .poll(
      async () =>
        (
          await invoke("task_records_search", {
            query: { operation: "compression", state: "success" },
            skip: 0,
          })
        ).length,
      { timeout: 60000 }
    )
    .toBe(3)
  await expect(
    panel.getByRole("button", { name: "将失败项重新排队", exact: true })
  ).toBeDisabled()
  // Queue polling must also observe the terminal task, not only its database row.
  await expect(
    panel.getByRole("button", { name: "停止压缩队列", exact: true })
  ).toBeDisabled()
  await page.screenshot({
    path: join(evidence, "batch-compression.png"),
    animations: "disabled",
  })
  await page.keyboard.press("Escape")
  await page.getByRole("button", { name: "历史", exact: true }).click()
  await page.getByRole("button", { name: "任务记录", exact: true }).click()
  const history = page.getByRole("dialog", { name: "任务记录与重试" })
  await history
    .getByRole("button", { name: "单独校验输出归档", exact: true })
    .first()
    .click()
  await history.getByRole("button", { name: "重新执行", exact: true }).click()
  await expect
    .poll(
      async () =>
        (
          await invoke("task_records_list", {
            skip: 0,
            failedOnly: false,
            operation: "integrityCheck",
          })
        ).filter((record) => record.state === "success").length
    )
    .toBe(1)
  await expect(
    history.getByRole("button", { name: "正在执行…", exact: true })
  ).toHaveCount(0)
  const zip = await invoke("compression_start", {
    request: {
      sources: [sources[0], sources[2]],
      baseName: "合并校验",
      outputDirectory: directory,
      format: "zip",
      level: 5,
      password: "test-zip-password",
      verifyAfterCompression: true,
    },
  })
  await expect
    .poll(
      async () =>
        (await invoke("compression_status", { taskId: zip.taskId }))?.completed,
      { timeout: 60000 }
    )
    .toBe(true)
  const checkedZip = await invoke("compression_status", { taskId: zip.taskId })
  assert.equal(checkedZip.success, true, checkedZip.message)
  assert.equal(checkedZip.compressionSucceeded, true)
  assert.equal(checkedZip.verification, "passed")
}
