import assert from "node:assert/strict"
import { join } from "node:path"
import { writeFile } from "node:fs/promises"
import { expect } from "@playwright/test"

// Real WebView2, native commands and temporary SQLite stores; no IPC mocks.
export async function verifyImprovements({
  page,
  invoke,
  pastePaths,
  archive,
  data,
  evidence,
}) {
  const nav = (name) =>
    page
      .getByRole("navigation")
      .getByRole("button", { name, exact: true })
      .click()
  await nav("设置")
  await page.getByRole("tab", { name: "解密引擎", exact: true }).click()
  await page.getByRole("button", { name: "解压行为", exact: true }).click()
  const scan = page.getByLabel("目录扫描文件数上限", { exact: true })
  await expect(scan).toHaveValue("0")
  await scan.fill("123")
  await page.keyboard.press("Escape")
  await nav("字典")
  await nav("设置")
  await page.getByRole("button", { name: "解压行为", exact: true }).click()
  await expect(scan).toHaveValue("123")
  await page.keyboard.press("Escape")
  const backup = await invoke("data_backup")
  await invoke("settings_update", {
    update: { kind: "scanMaxFilesPerDirectory", value: 456 },
  })
  await page.getByRole("tab", { name: "数据", exact: true }).click()
  await page.getByRole("button", { name: "刷新备份列表", exact: true }).click()
  const entry = page.getByText(backup.path, { exact: true }).locator("..")
  await entry.getByRole("button", { name: "预览恢复", exact: true }).click()
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "备份当前数据并恢复", exact: true })
    .click()
  await expect(page.getByRole("alertdialog")).not.toBeVisible()
  await page.getByRole("tab", { name: "解密引擎", exact: true }).click()
  await page.getByRole("button", { name: "解压行为", exact: true }).click()
  await expect(scan).toHaveValue("0")
  assert.equal(
    (await invoke("settings_get")).recovery.scanMaxFilesPerDirectory,
    0
  )
  await page.screenshot({
    path: join(evidence, "restored-engine-settings.png"),
  })
  await page.keyboard.press("Escape")
  console.log(
    "PASS: native restore refreshes engine settings; ordinary navigation preserves unsaved input"
  )

  await nav("解压")
  await pastePaths([archive])
  await expect(
    page.getByRole("button", { name: "预览内容", exact: true })
  ).toBeEnabled()
  // Synchronously leave while the real IPC promise is pending. React Activity
  // hides the existing page; it must still settle the preview's busy state.
  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll("button")]
    buttons.find((button) => button.textContent.trim() === "预览内容").click()
    document.querySelector("nav button[aria-label='字典']")?.click()
    const dictionary = [...document.querySelectorAll("nav button")].find(
      (button) => button.textContent.trim() === "字典"
    )
    dictionary.click()
  })
  await expect(
    page.getByRole("button", { name: "预览内容", exact: true })
  ).not.toBeVisible()
  await nav("解压")
  const preview = page.getByRole("dialog", { name: "归档内容预览" })
  await expect(preview.getByRole("alert")).toBeVisible({ timeout: 15000 })
  await page.keyboard.press("Escape")
  await expect(
    page.getByRole("button", { name: "预览内容", exact: true })
  ).toBeEnabled()
  await page.getByRole("button", { name: "预览内容", exact: true }).click()
  await expect(preview.getByRole("alert")).toBeVisible()
  await page.keyboard.press("Escape")
  console.log(
    "PASS: failed native preview settles across Activity navigation and permits another request"
  )

  const session = await invoke("dictionary_import_begin")
  const before = await invoke("dictionary_count")
  for (let batch = 0; batch < 2; batch++) {
    await invoke("dictionary_add", {
      importId: session,
      candidates: [`session-candidate-${batch}`],
    })
    await assert.rejects(invoke("data_backup"), /当前任务|数据维护/)
    await assert.rejects(invoke("backup_run_now"), /当前任务|数据维护/)
  }
  await invoke("dictionary_import_finish", { id: session })
  assert.equal(await invoke("dictionary_count"), before + 2)
  await invoke("data_backup")
  await assert.rejects(
    invoke("dictionary_add", {
      importId: session,
      candidates: ["late-candidate"],
    })
  )
  // Caller closes the actual window with this browser-owned session outstanding.
  // Shutdown must release the gap without requiring a WebView acknowledgement.
  await invoke("dictionary_import_begin")
  await writeFile(
    join(evidence, "improvements-results.json"),
    JSON.stringify(
      {
        runtime: "Windows Tauri + WebView2 + Rust + SQLite",
        data,
        restoredSettings: true,
        previewNavigation: true,
        importMaintenanceExclusion: true,
      },
      null,
      2
    )
  )
  console.log(
    "PASS: native import excludes backups between batches, finished sessions reject late writes"
  )
}
