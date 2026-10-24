import assert from "node:assert/strict"
import { access, readFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { expect } from "@playwright/test"

export async function verifyDataManagement({
  invoke,
  page,
  archive,
  password,
  data,
  evidence,
}) {
  await invoke("archive_action_run", {
    id: "record-success",
    request: { path: archive, password },
  })
  await assert.rejects(
    invoke("archive_action_run", {
      id: "record-failure",
      request: { path: archive, password: "wrong-password" },
    })
  )
  const query = {
    text: basename(archive),
    state: "failed",
    fromMs: 1,
    beforeMs: Date.now() + 1000,
  }
  const records = await invoke("task_records_search", { query, skip: 0 })
  assert.equal(records.length, 1)
  for (const format of ["json", "csv"]) {
    const path = await invoke("task_records_export", {
      query,
      format,
      includePaths: false,
    })
    const content = await readFile(path, "utf8")
    assert.ok(!content.includes(archive) && !content.includes(password))
    if (format === "json") assert.equal(JSON.parse(content).records.length, 1)
  }
  await page.getByRole("button", { name: "历史", exact: true }).click()
  await page.getByRole("button", { name: "任务记录", exact: true }).click()
  const panel = page.getByRole("dialog", { name: "任务记录与重试" })
  await panel.getByLabel("记录关键词").fill(basename(archive))
  await panel.getByLabel("记录状态", { exact: true }).selectOption("failed")
  await panel.getByRole("button", { name: "查询记录", exact: true }).click()
  await expect(panel.getByRole("checkbox", { name: /^选择记录 / })).toHaveCount(
    1
  )
  await panel.getByRole("button", { name: "导出 JSON", exact: true }).click()
  await expect(panel.getByRole("status")).toContainText("报告：")
  await page.screenshot({
    path: join(evidence, "record-search-export.png"),
    animations: "disabled",
  })
  await panel.getByRole("button", { name: "选择本页", exact: true }).click()
  await panel
    .getByRole("button", { name: "删除所选（1）", exact: true })
    .click()
  await expect(panel.getByText(/只删除记录，不删除源文件/)).toBeVisible()
  await panel
    .getByRole("button", { name: "确认删除所选记录", exact: true })
    .click()
  await expect(panel.getByText("暂无任务记录。", { exact: true })).toBeVisible()
  assert.equal(
    (await invoke("task_records_search", { query, skip: 0 })).length,
    0
  )
  await access(archive)
  await page.keyboard.press("Escape")
  console.log(
    "PASS: native record search, JSON/CSV export, UI filters and confirmed bulk deletion preserve source files"
  )

  const manual = await invoke("data_backup")
  const policy = {
    enabled: false,
    directory: join(data, "自动备份目录"),
    intervalHours: 24,
    keepCount: 2,
  }
  await invoke("backup_policy_save", { policy })
  await invoke("backup_run_now")
  const first = (await invoke("backup_management_get")).entries.find(
    (e) => e.automatic
  ).path
  await invoke("backup_run_now")
  await invoke("backup_run_now")
  await assert.rejects(access(first))
  await access(manual.path)
  const overview = await invoke("backup_management_get")
  assert.equal(overview.entries.filter((e) => e.automatic).length, 2)
  assert.ok(overview.status.lastSuccessMs)

  await page.getByRole("button", { name: "设置", exact: true }).click()
  await page.getByRole("tab", { name: "数据", exact: true }).click()
  const management = page.getByRole("region", { name: "自动备份管理" })
  await expect(management.getByLabel("保留备份份数")).toHaveValue("2")
  await management.getByLabel("保留备份份数").fill("3")
  await management
    .getByRole("button", { name: "保存备份设置", exact: true })
    .click()
  await expect(
    management.getByText("自动备份设置已保存。", { exact: true })
  ).toBeVisible()
  assert.equal(
    (await invoke("backup_management_get")).status.policy.keepCount,
    3
  )
  await management
    .getByRole("button", { name: "预览恢复", exact: true })
    .first()
    .click()
  const preview = page.getByRole("alertdialog")
  await expect(preview).toContainText("恢复这份数据备份")
  await preview.getByRole("button", { name: "取消", exact: true }).click()
  await management.scrollIntoViewIfNeeded()
  await page.screenshot({
    path: join(evidence, "automatic-backup-management.png"),
    animations: "disabled",
  })
  console.log(
    "PASS: native automatic-backup catalog, retention preserves manual backup, policy editing and restore preview"
  )
  // A new directory has no successful backup: the next real startup must catch up without UI polling.
  const duePolicy = {
    ...policy,
    enabled: true,
    directory: join(data, "启动补做备份"),
  }
  await invoke("backup_policy_save", { policy: duePolicy })
  return duePolicy
}

export async function verifyAutomaticBackupRestart({ invoke, policy }) {
  await expect
    .poll(
      async () => (await invoke("backup_management_get")).status.lastSuccessMs,
      { timeout: 15000 }
    )
    .not.toBeNull()
  const overview = await invoke("backup_management_get")
  assert.deepEqual(overview.status.policy, policy)
  const entry = overview.entries.find((e) => e.path.includes("启动补做备份"))
  assert.ok(entry)
  const preview = await invoke("database_restore_preview", { path: entry.path })
  assert.equal(preview.unified, true)
  await invoke("database_restore_discard", { token: preview.token })
  await invoke("backup_policy_save", { policy: { ...policy, enabled: false } })
  console.log(
    "PASS: real restart catches up due automatic backup with a validated unified snapshot"
  )
}
