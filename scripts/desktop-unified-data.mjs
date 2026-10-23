import assert from "node:assert/strict"
import { join } from "node:path"
import { writeFile, readFile, mkdir } from "node:fs/promises"
import { expect } from "@playwright/test"

// Runs in an isolated, real Tauri/WebView2 session. No IPC or SQLite mocks.
export async function verifyUnifiedData({
  invoke,
  page,
  data,
  evidence,
  password,
}) {
  const directory = join(data, "统一数据测试")
  await mkdir(directory, { recursive: true })
  const source = join(directory, "压缩资料.txt")
  await writeFile(source, "durable compression record")
  const task = await invoke("compression_start", {
    request: {
      sources: [source],
      outputDirectory: directory,
      baseName: "记录归档",
      format: "sevenZip",
      level: 1,
      password,
      encryptFileNames: true,
    },
  })
  await expect
    .poll(
      async () =>
        (await invoke("compression_status", { taskId: task.taskId })).running,
      { timeout: 60000 }
    )
    .toBe(false)
  assert.equal(
    (await invoke("compression_status", { taskId: task.taskId })).success,
    true
  )
  await assert.rejects(
    invoke("compression_start", {
      request: {
        sources: [join(directory, "不存在.txt")],
        baseName: "失败归档",
        password,
      },
    })
  )
  const list = (operation = null) =>
    invoke("task_records_list", { skip: 0, failedOnly: false, operation })
  const records = await list()
  for (const operation of [
    "recovery",
    "compression",
    "selectiveExtraction",
    "integrityCheck",
    "batchIntegrityCheck",
  ]) {
    const rows = await list(operation)
    assert.ok(rows.length > 0, `missing ${operation} records`)
    assert.ok(rows.every((row) => row.operation === operation))
  }
  assert.ok(
    (await list("compression")).some(
      (row) => row.state === "failed" && row.failureKind === "Preparation"
    )
  )
  assert.ok(
    (await list("compression")).some(
      (row) => row.state === "success" && row.outputPath.endsWith(".7z")
    )
  )
  assert.ok(
    (await list("batchIntegrityCheck")).some((row) =>
      row.checkItems.some((item) => item.checkedAtMs)
    )
  )
  assert.ok(!JSON.stringify(records).includes(password))
  assert.ok(
    !(await readFile(join(data, "task-records.db"))).includes(
      Buffer.from(password)
    )
  )

  await page.getByRole("button", { name: "历史", exact: true }).click()
  await page.getByRole("button", { name: "任务记录", exact: true }).click()
  const panel = page.getByRole("dialog", { name: "任务记录与重试" })
  await panel.getByLabel("任务类型").selectOption("compression")
  await expect(panel.getByText("输出文件：", { exact: false })).toBeVisible()
  await expect(
    panel.getByRole("button", { name: "准备重试", exact: true })
  ).toHaveCount(0)
  await panel.getByLabel("任务类型").selectOption("batchIntegrityCheck")
  await expect(
    panel.getByText("逐项检查结果", { exact: false }).first()
  ).toBeVisible()
  await page.screenshot({
    path: join(evidence, "unified-task-records.png"),
    animations: "disabled",
  })
  await page.keyboard.press("Escape")

  const settings = await invoke("settings_get")
  const presets = await invoke("processing_presets_list")
  assert.ok(presets.length > 0)
  const dictionaryCount = await invoke("dictionary_count")
  const backup = await invoke("data_backup")
  const preview = await invoke("database_restore_preview", {
    path: backup.path,
  })
  assert.equal(preview.unified, true)
  assert.equal(preview.presetCount, presets.length)
  assert.equal(preview.taskRecordCount, records.length)
  assert.equal(preview.includesSettings, true)
  assert.equal(preview.unreadablePasswordCount, 0)
  // The apply operation must use the validated snapshot even after its source changes.
  const backupBytes = await readFile(backup.path)
  await writeFile(backup.path, "source changed after preview")
  await invoke("processing_preset_delete", { name: presets[0].name })
  await invoke("task_record_delete", { id: records[0].taskId })
  await invoke("settings_update", {
    update: { kind: "autoUpdate", value: !settings.autoUpdate },
  })
  await invoke("dictionary_add", { candidates: ["after-backup-candidate"] })
  const result = await invoke("database_restore_apply", {
    token: preview.token,
  })
  assert.deepEqual(await invoke("processing_presets_list"), presets)
  assert.deepEqual(await list(), records)
  assert.deepEqual(await invoke("settings_get"), settings)
  assert.equal(await invoke("dictionary_count"), dictionaryCount)
  const safety = await invoke("database_restore_preview", {
    path: result.safetyBackupPath,
  })
  assert.equal(safety.unified, true)
  assert.equal(safety.presetCount, presets.length - 1)
  assert.equal(safety.taskRecordCount, records.length - 1)
  await invoke("database_restore_discard", { token: safety.token })
  await writeFile(backup.path, backupBytes)
  await assert.rejects(
    invoke("database_restore_apply", { token: preview.token })
  )

  const legacy = await invoke("database_backup")
  const oldPreview = await invoke("database_restore_preview", {
    path: legacy.path,
  })
  assert.equal(oldPreview.unified, false)
  await invoke("database_restore_apply", { token: oldPreview.token })
  assert.deepEqual(await list(), records)
  assert.deepEqual(await invoke("settings_get"), settings)
  assert.deepEqual(await invoke("processing_presets_list"), presets)
  console.log(
    "PASS: real unified backup, exact preview snapshot, safety backup, legacy restore, all five record types and password-free records"
  )
  await page.getByRole("button", { name: "解压", exact: true }).click()
}

export async function stageInterruptedRestore({ invoke, data }) {
  const backup = await invoke("data_backup")
  const settings = await invoke("settings_get")
  const records = await invoke("task_records_list", {
    skip: 0,
    failedOnly: false,
  })
  await invoke("task_record_delete", { id: records[0].taskId })
  await invoke("settings_update", {
    update: { kind: "autoUpdate", value: !settings.autoUpdate },
  })
  await writeFile(
    join(data, "data-restore-pending.json"),
    JSON.stringify(backup.path)
  )
  return settings
}
