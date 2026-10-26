import assert from "node:assert/strict"
import { mkdir, writeFile, readFile, unlink, access } from "node:fs/promises"
import { join } from "node:path"
import { expect } from "@playwright/test"

export async function verifyCompressionPresets({
  invoke,
  page,
  data,
  evidence,
  password,
}) {
  const directory = join(data, "[测试分组] 压缩资料")
  await mkdir(directory, { recursive: true })
  const source = join(directory, "资料.txt")
  await writeFile(source, "compression preset and retry fixture")
  const preset = {
    name: "加密资料",
    nameTemplate: "{name}-{date}",
    openWhenDone: false,
    options: {
      verifyAfterCompression: true,
      format: "sevenZip",
      level: 1,
      encryptFileNames: true,
      outputDirectory: directory,
    },
  }
  await invoke("compression_preset_save", { preset, overwrite: false })
  await assert.rejects(
    invoke("compression_preset_save", { preset, overwrite: false })
  )
  await assert.rejects(
    invoke("compression_preset_save", {
      preset: { ...preset, password },
      overwrite: true,
    })
  )
  await invoke("compression_preset_save", {
    preset: { ...preset, name: "待删除预设" },
    overwrite: false,
  })
  await invoke("compression_preset_delete", { name: "待删除预设" })
  assert.deepEqual(await invoke("compression_presets_list"), [preset])
  await page.getByRole("button", { name: "压缩", exact: true }).click()
  await page.locator("#archive-name").fill("测试归档")
  await page.getByRole("button", { name: "压缩预设", exact: true }).click()
  const presets = page.getByRole("dialog", { name: "压缩预设", exact: true })
  await presets.getByLabel("压缩预设名称", { exact: true }).fill("界面保存")
  await presets
    .getByLabel("压缩命名规则", { exact: true })
    .fill("{name}-{date}")
  await presets
    .getByRole("button", { name: "保存压缩预设", exact: true })
    .click()
  await expect
    .poll(async () => (await invoke("compression_presets_list")).length)
    .toBe(2)
  await expect(
    presets.getByRole("button", { name: "保存压缩预设", exact: true })
  ).toBeDisabled()
  await presets
    .getByRole("checkbox", { name: "确认覆盖同名压缩预设", exact: true })
    .check()
  await presets.getByLabel("压缩命名规则", { exact: true }).fill("界面-{name}")
  await presets
    .getByRole("button", { name: "保存压缩预设", exact: true })
    .click()
  await expect
    .poll(
      async () =>
        (await invoke("compression_presets_list")).find(
          (p) => p.name === "界面保存"
        )?.nameTemplate
    )
    .toBe("界面-{name}")
  await presets
    .getByRole("button", { name: "删除压缩预设", exact: true })
    .click()
  await presets
    .getByRole("button", { name: "确认删除压缩预设", exact: true })
    .click()
  await expect
    .poll(async () => (await invoke("compression_presets_list")).length)
    .toBe(1)
  await presets.getByLabel("已保存压缩预设").click()
  await page.getByRole("option", { name: preset.name, exact: true }).click()
  await page.screenshot({
    path: join(evidence, "compression-presets.png"),
    animations: "disabled",
  })
  await presets
    .getByRole("button", { name: "应用压缩预设", exact: true })
    .click()
  await expect(presets).not.toBeVisible()
  await expect(page.locator("#archive-name")).toHaveValue(
    /^测试归档-\d{4}-\d{2}-\d{2}$/
  )
  await expect
    .poll(async () => {
      await invoke("plugin:event|emit_to", {
        target: { kind: "Webview", label: "main" },
        event: "tauri://drag-drop",
        payload: { paths: [source], position: { x: 0, y: 0 } },
      })
      return page
        .getByTestId("compress-source-scroll")
        .getByText("资料.txt", { exact: true })
        .count()
    })
    .toBe(1)
  await page.locator("#compression-password").fill(password)
  await page.locator("#compression-password-confirmation").fill(password)
  await page.getByRole("button", { name: "开始压缩", exact: true }).click()
  await expect
    .poll(
      async () =>
        (await invoke("compression_status", { taskId: null }))?.completed,
      { timeout: 60000 }
    )
    .toBe(true)
  const first = await invoke("compression_status", { taskId: null })
  assert.equal(first.success, true, first.message)
  const records = await invoke("task_records_list", {
    skip: 0,
    failedOnly: false,
    operation: "compression",
  })
  assert.equal(records.length, 1)
  assert.equal(records[0].compression.passwordRequired, true)
  assert.equal(records[0].compressionVerification, "passed")
  assert.equal(records[0].compressionSucceeded, true)
  assert.deepEqual(records[0].compression.options, preset.options)
  assert.ok(!JSON.stringify(records).includes(password))
  const exported = await invoke("task_records_export", {
    query: { operation: "compression" },
    format: "json",
    includePaths: false,
  })
  const report = await readFile(exported, "utf8")
  assert.ok(!report.includes(directory) && !report.includes(password))
  assert.equal(JSON.parse(report).records[0].compression.baseName, "")
  await page.getByRole("button", { name: "历史", exact: true }).click()
  await invoke("settings_update", {
    update: {
      kind: "compressionNaming",
      value: {
        ...(await invoke("settings_get")).compressionNaming,
        useAiRename: true,
        useAiFileReference: true,
      },
    },
  })
  await page.getByRole("button", { name: "任务记录", exact: true }).click()
  const panel = page.getByRole("dialog", { name: "任务记录与重试" })
  await panel.getByRole("button", { name: "准备重新压缩", exact: true }).click()
  await panel
    .getByRole("button", { name: "确认替换草稿并打开压缩页", exact: true })
    .click()
  await expect(panel).not.toBeVisible()
  await expect(page.locator("#archive-name")).toHaveValue(
    records[0].compression.baseName
  )
  await expect(page.locator("#compression-password")).toHaveValue("")
  await page
    .getByRole("button", { name: "AI 命名 · 未开启", exact: true })
    .click()
  await expect(
    page.getByRole("switch", { name: "使用 AI 优化名称", exact: true })
  ).not.toBeChecked()
  // Stored defaults remain enabled; only this historical retry overrides them.
  assert.equal(
    (await invoke("settings_get")).compressionNaming.useAiRename,
    true
  )
  await page.keyboard.press("Escape")
  await page.getByRole("button", { name: "开始压缩", exact: true }).click()
  await expect(
    page.getByText("原任务使用了密码，请重新输入密码并确认后再压缩。", {
      exact: true,
    })
  ).toBeVisible()
  assert.equal(
    (await invoke("compression_status", { taskId: null })).taskId,
    first.taskId
  )
  await page.locator("#compression-password").fill(password)
  await page.locator("#compression-password-confirmation").fill("different")
  await page.getByRole("button", { name: "开始压缩", exact: true }).click()
  await expect(
    page.getByText("两次输入的密码不一致，请重新确认。", { exact: true })
  ).toBeVisible()
  await page.locator("#compression-password-confirmation").fill(password)
  await page.getByRole("switch", { name: "完成后打开", exact: true }).uncheck()
  await page.getByRole("button", { name: "开始压缩", exact: true }).click()
  await expect
    .poll(
      async () => {
        const task = await invoke("compression_status", { taskId: null })
        return task?.taskId !== first.taskId && task?.completed
      },
      { timeout: 60000 }
    )
    .toBe(true)
  const second = await invoke("compression_status", { taskId: null })
  assert.equal(second.success, true, second.message)
  assert.notEqual(first.outputPath, second.outputPath)
  await access(first.outputPath)
  await invoke("archive_action_run", {
    id: "verify-recompressed",
    request: { path: second.outputPath, password },
  })
  await page.screenshot({
    path: join(evidence, "compression-retry.png"),
    animations: "disabled",
  })
  const backup = await invoke("data_backup")
  const preview = await invoke("database_restore_preview", {
    path: backup.path,
  })
  assert.equal(preview.compressionPresetCount, 1)
  await invoke("compression_preset_delete", { name: preset.name })
  await invoke("database_restore_apply", { token: preview.token })
  assert.deepEqual(await invoke("compression_presets_list"), [preset])
  await unlink(source)
  const prepared = await invoke("compression_retry_prepare", {
    id: first.taskId,
  })
  assert.deepEqual(prepared.missingSources, [source])
  const missingOutput = join(directory, "失效输出目录")
  await invoke("compression_preset_save", {
    preset: {
      ...preset,
      name: "失效目录预设",
      options: { ...preset.options, outputDirectory: missingOutput },
    },
    overwrite: false,
  })
  await assert.rejects(
    invoke("compression_preset_apply", { name: "失效目录预设" })
  )
  await invoke("compression_preset_delete", { name: "失效目录预设" })
  await assert.rejects(
    invoke("compression_start", {
      request: {
        sources: [source],
        outputDirectory: missingOutput,
        baseName: "缺失来源",
        format: "zip",
        level: 5,
      },
    })
  )
  const failed = (
    await invoke("task_records_search", {
      query: { operation: "compression", state: "failed" },
      skip: 0,
    })
  )[0]
  const missing = await invoke("compression_retry_prepare", {
    id: failed.taskId,
  })
  assert.equal(missing.outputMissing, true)
  assert.deepEqual(missing.missingSources, [source])
  await assert.rejects(
    invoke("compression_retry_prepare", { id: "不存在的记录" })
  )
  return preset
}
