import { mockDictionaryImportSessions } from "./helpers/dictionary-session.mjs"
import { test, expect } from "@playwright/test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"

const nav = (page, name) =>
  page
    .getByRole("navigation")
    .getByRole("button", { name, exact: true })
    .click()
async function setup(page, theme, width) {
  await page.setViewportSize({ width, height: width === 390 ? 500 : 650 })
  await page.goto("/")
  await nav(page, "设置")
  await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0)
  if (theme === "light")
    await page.getByRole("button", { name: "切换到浅色", exact: true }).click()
  await page.evaluate(() => {
    window.pendingWrites = []
    window.__TAURI_INTERNALS__ = {
      async invoke(command, args) {
        if (
          [
            "ai_settings_update",
            "settings_update",
            "data_backup",
            "dictionary_add",
          ].includes(command)
        )
          return new Promise((resolve, reject) =>
            window.pendingWrites.push({ command, args, resolve, reject })
          )
        if (command === "ai_profiles_list")
          return {
            profiles: [],
            activeProfileId: "",
            renamePrompt: "初始提示词",
          }
        if (command === "settings_get")
          return {
            version: 0,
            engine: {},
            logging: { level: "info", maxDiskMib: 25 },
            recovery: { computeMode: "gpuPreferred" },
          }
        if (command === "database_info")
          return {
            exists: true,
            candidateCount: 0,
            path: "测试数据.db",
            rootPath: "测试目录",
            settingsPath: "配置.json",
            logsPath: "日志",
            toolsPath: "工具",
          }
        if (command === "dictionary_list")
          return { entries: [], totalCount: 0, matchedCount: 0 }
        if (command === "log_write") return null
        throw new Error("测试读取暂不可用")
      },
    }
  })
  await mockDictionaryImportSessions(page)
}
async function dismiss(page) {
  const close = page.getByRole("button", { name: "关闭通知", exact: true })
  while (await close.count()) {
    const count = await close.count()
    await close.first().click()
    await expect(close).toHaveCount(count - 1)
  }
}
async function rejectWrite(page) {
  await page.evaluate(() =>
    window.pendingWrites.at(-1).reject(new Error("写入暂不可用，请重试。"))
  )
  await expect(page.locator("[data-sonner-toaster]")).toContainText(
    "写入暂不可用"
  )
}
async function shot(page, name) {
  if (!process.env.UI_LIFECYCLE_SHOTS) return
  await mkdir(process.env.UI_LIFECYCLE_SHOTS, { recursive: true })
  await page.screenshot({
    path: join(process.env.UI_LIFECYCLE_SHOTS, `${name}.png`),
    animations: "disabled",
  })
}

for (const theme of ["dark", "light"])
  for (const width of [900, 390]) {
    const label = `${theme}-${width}`
    test(`提示词提交时可关闭重开，离开需等待，失败草稿可继续编辑（${label}）`, async ({
      page,
    }) => {
      await setup(page, theme, width)
      await page.getByRole("tab", { name: "AI 模型", exact: true }).click()
      await page
        .getByRole("button", { name: "编辑提示词", exact: true })
        .click()
      const dialog = page.getByRole("dialog")
      const input = dialog.getByRole("textbox", { name: "AI 重命名提示词" })
      await input.fill("保留主题的草稿")
      await dialog
        .getByRole("button", { name: "保存提示词", exact: true })
        .click()
      await expect(input).toBeDisabled()
      await dialog.getByRole("button", { name: "关闭", exact: true }).click()
      await nav(page, "字典")
      await expect(
        page.getByRole("heading", { name: "设置", exact: true })
      ).toBeVisible()
      await expect(page.getByRole("alertdialog")).toHaveCount(0)
      await expect(page.locator("[data-sonner-toaster]")).toContainText(
        "等待完成后再切换"
      )
      await page.getByRole("tab", { name: "常规", exact: true }).click()
      await expect(
        page.getByRole("tab", { name: "AI 模型", exact: true })
      ).toHaveAttribute("aria-selected", "true")
      await dismiss(page)
      await page
        .getByRole("button", { name: "编辑提示词 · 未保存", exact: true })
        .click()
      await expect(input).toHaveValue("保留主题的草稿")
      await expect(input).toBeDisabled()
      expect(await page.evaluate(() => window.pendingWrites.length)).toBe(1)
      await shot(page, `${label}-prompt-reopened-pending`)
      await rejectWrite(page)
      await expect(input).toBeEnabled()
      await page.keyboard.press("Escape")
      await dismiss(page)
      await page.getByRole("tab", { name: "常规", exact: true }).click()
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: "继续编辑", exact: true })
        .click()
      await page
        .getByRole("button", { name: "编辑提示词 · 未保存", exact: true })
        .click()
      await expect(input).toHaveValue("保留主题的草稿")
      await shot(page, `${label}-prompt-retained-after-failure`)
    })

    test(`备份跨分类和页面保持同一次操作，返回后恢复成功状态（${label}）`, async ({
      page,
    }) => {
      await setup(page, theme, width)
      await page.getByRole("tab", { name: "数据", exact: true }).click()
      await page.getByRole("button", { name: "创建备份", exact: true }).click()
      await page.getByRole("tab", { name: "常规", exact: true }).click()
      await page.getByRole("tab", { name: "数据", exact: true }).click()
      await expect(
        page.getByRole("button", { name: "正在备份…", exact: true })
      ).toBeDisabled()
      await nav(page, "字典")
      await nav(page, "设置")
      await page.getByRole("tab", { name: "数据", exact: true }).click()
      await expect(
        page.getByRole("button", { name: "正在备份…", exact: true })
      ).toBeDisabled()
      expect(await page.evaluate(() => window.pendingWrites.length)).toBe(1)
      await shot(page, `${label}-backup-returned-pending`)
      await page.evaluate(() =>
        window.pendingWrites[0].resolve({
          path: "测试目录/备份.db",
          byteCount: 1024,
          createdAtMs: Date.now(),
        })
      )
      await expect(
        page.getByRole("button", { name: "创建备份", exact: true })
      ).toBeEnabled()
      await expect(
        page.getByText("备份位置：测试目录/备份.db", { exact: true })
      ).toBeVisible()
    })

    test(`设置草稿跨页面保留，后台保存失败不重置输入（${label}）`, async ({
      page,
    }) => {
      await setup(page, theme, width)
      await page.getByRole("tab", { name: "常规", exact: true }).click()
      const capacity = page.getByRole("spinbutton", { name: "最大磁盘占用" })
      await capacity.fill("55")
      await nav(page, "字典")
      await nav(page, "设置")
      await page.getByRole("tab", { name: "常规", exact: true }).click()
      await expect(capacity).toHaveValue("55")
      await page.getByRole("button", { name: "保存", exact: true }).click()
      await nav(page, "字典")
      await rejectWrite(page)
      await dismiss(page)
      await nav(page, "设置")
      await page.getByRole("tab", { name: "常规", exact: true }).click()
      await expect(capacity).toHaveValue("55")
      await expect(
        page.getByRole("button", { name: "保存", exact: true })
      ).toBeEnabled()
      expect(await page.evaluate(() => window.pendingWrites.length)).toBe(1)
      await page.getByRole("tab", { name: "解压与解密", exact: true }).click()
      await page
        .getByRole("button", { name: /^引擎管理(?: · 未保存)?$/ })
        .click()
      const dialog = page.getByRole("dialog")
      await dialog.getByRole("tab", { name: "工具目录", exact: true }).click()
      await dialog
        .getByRole("textbox", { name: "公共目录（绝对路径）" })
        .fill("C:\\测试工具草稿")
      await page.keyboard.press("Escape")
      await nav(page, "字典")
      await nav(page, "设置")
      await page
        .getByRole("button", { name: /^引擎管理(?: · 未保存)?$/ })
        .click()
      await expect(
        dialog.getByRole("textbox", { name: "公共目录（绝对路径）" })
      ).toHaveValue("C:\\测试工具草稿")
      await shot(page, `${label}-tool-draft-returned`)
    })
  }
