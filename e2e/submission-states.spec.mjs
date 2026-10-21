import { test, expect } from "@playwright/test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"

async function setup(page, theme, width) {
  await page.setViewportSize({
    width,
    height: width === 1920 ? 1080 : width === 390 ? 500 : 650,
  })
  await page.goto("/")
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "设置", exact: true })
    .click()
  await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0)
  if (theme === "light")
    await page.getByRole("button", { name: "切换到浅色", exact: true }).click()
  await page.evaluate(() => {
    window.submissions = []
    window.aiSettings = {
      profiles: [],
      activeProfileId: "",
      renamePrompt: "生成简洁归档名称。",
    }
    window.appSettings = {
      version: 0,
      engine: {},
      logging: { level: "info", maxDiskMib: 25 },
      recovery: { computeMode: "gpuPreferred", scanMaxFilesPerDirectory: 1000 },
    }
    window.__TAURI_INTERNALS__ = {
      async invoke(command, args) {
        if (
          [
            "ai_profile_upsert",
            "ai_settings_update",
            "ai_connection_test",
            "dictionary_add",
            "settings_update",
            "database_backup",
            "tool_set_tools_directory",
          ].includes(command)
        ) {
          return new Promise((resolve, reject) =>
            window.submissions.push({ command, args, resolve, reject })
          )
        }
        if (command === "ai_profiles_list") return window.aiSettings
        if (command === "settings_get") return window.appSettings
        if (command === "dictionary_list")
          return { entries: [], totalCount: 0, matchedCount: 0 }
        if (command === "database_info")
          return {
            path: "测试数据.db",
            exists: true,
            candidateCount: 0,
            rootPath: "测试目录",
            settingsPath: "配置.json",
            logsPath: "日志",
            toolsPath: "工具",
          }
        if (command === "log_write") return null
        throw new Error("此模拟场景未提供该读取结果。")
      },
    }
  })
}

async function dismissNotices(page) {
  const notices = page.locator("[data-sonner-toast] [data-close-button]")
  while (await notices.count()) {
    const count = await notices.count()
    await notices.first().click()
    await expect(notices).toHaveCount(count - 1)
  }
}

async function submitOnce(page, button, command) {
  await dismissNotices(page)
  await button.scrollIntoViewIfNeeded()
  await page.evaluate(() => {
    window.submissions = []
  })
  await button.evaluate((el) => {
    el.click()
    el.click()
  })
  await expect
    .poll(() => page.evaluate(() => window.submissions.length))
    .toBe(1)
  expect(await page.evaluate(() => window.submissions[0].command)).toBe(command)
}

async function reject(page, feedback = page.locator("[data-sonner-toaster]")) {
  await page.evaluate(() =>
    window.submissions[0].reject(new Error("暂时无法写入，请稍后重试。"))
  )
  await expect(feedback).toContainText("暂时无法写入")
}

async function screenshot(page, name) {
  if (!process.env.UI_SUBMIT_SHOTS) return
  await mkdir(process.env.UI_SUBMIT_SHOTS, { recursive: true })
  await page.screenshot({
    path: join(process.env.UI_SUBMIT_SHOTS, `${name}.png`),
    animations: "disabled",
  })
}

for (const theme of ["dark", "light"])
  for (const width of [900, 390]) {
    test(`清空确认等待提交结果，失败可原地重试（${theme}-${width}）`, async ({
      page,
    }) => {
      await setup(page, theme, width)
      await page.evaluate(() => {
        const original = window.__TAURI_INTERNALS__.invoke
        window.cleared = false
        window.__TAURI_INTERNALS__.invoke = async (command, args) => {
          if (["history_clear", "log_clear"].includes(command))
            return new Promise((resolve, reject) =>
              window.submissions.push({ command, resolve, reject })
            )
          if (command === "history_list") {
            const entries = window.cleared
              ? []
              : [
                  {
                    id: 1,
                    archiveName: "测试归档.zip",
                    fingerprintPrefix: "test",
                    archivePath: null,
                    outputDirectory: null,
                    archiveFormat: "zip",
                    fileSize: 1024,
                    volumeCount: 1,
                    firstSuccessAtMs: Date.now(),
                    lastVerifiedAtMs: Date.now(),
                    verificationCount: 1,
                    hasPassword: false,
                  },
                ]
            return {
              entries,
              totalCount: entries.length,
              matchedCount: entries.length,
              passwordCount: 0,
            }
          }
          if (command === "log_list") {
            const entries = window.cleared
              ? []
              : [
                  {
                    id: "test-log",
                    timestampMs: Date.now(),
                    level: "warn",
                    source: "test",
                    event: "test",
                    message: "测试提示",
                    context: {},
                  },
                ]
            return {
              entries,
              totalCount: entries.length,
              matchedCount: entries.length,
              hasMore: false,
              directory: "测试日志",
              stats: {
                errorCount: 0,
                warnCount: entries.length,
                infoCount: 0,
                debugCount: 0,
                fileCount: entries.length,
                diskBytes: 1024,
                unreadableLineCount: 0,
              },
            }
          }
          return original(command, args)
        }
      })
      for (const [nav, menu, action, command] of [
        ["历史", "历史工具", "清空历史", "history_clear"],
        ["日志", "日志工具", "清空日志", "log_clear"],
      ]) {
        await page.evaluate(() => {
          window.cleared = false
        })
        await page
          .getByRole("navigation")
          .getByRole("button", { name: nav, exact: true })
          .click()
        await page.getByRole("button", { name: menu, exact: true }).click()
        await page
          .getByRole("menuitem", {
            name: nav === "历史" ? "清空历史记录" : "清空本机日志",
            exact: true,
          })
          .click()
        const dialog = page.getByRole("alertdialog")
        await submitOnce(
          page,
          dialog.getByRole("button", { name: action, exact: true }),
          command
        )
        await expect(
          dialog.getByRole("button", { name: "取消", exact: true })
        ).toBeDisabled()
        await expect(
          dialog.getByRole("button", { name: "清空中…", exact: true })
        ).toBeInViewport({ ratio: 1 })
        await page.keyboard.press("Escape")
        await expect(dialog).toBeVisible()
        await screenshot(page, `${theme}-${width}-${command}-pending`)
        await reject(page)
        await expect(
          dialog.getByRole("button", { name: action, exact: true })
        ).toBeEnabled()
        await screenshot(page, `${theme}-${width}-${command}-error`)
        await submitOnce(
          page,
          dialog.getByRole("button", { name: action, exact: true }),
          command
        )
        await page.evaluate(() => {
          window.cleared = true
          window.submissions[0].resolve(1)
        })
        await expect(dialog).toHaveCount(0)
      }
    })
  }

for (const theme of ["dark", "light"])
  for (const width of [1920, 900, 390]) {
    const prefix = `${theme}-${width}`
    test(`AI 操作只标记当前动作，失败保留提示词且可重试（${prefix}）`, async ({
      page,
    }) => {
      const errors = []
      page.on("pageerror", (error) => errors.push(error.message))
      await setup(page, theme, width)
      await page.getByRole("tab", { name: "AI 模型", exact: true }).click()
      await expect(
        page.getByRole("textbox", { name: "配置名称", exact: true })
      ).toBeEnabled()
      const save = page.getByRole("button", { name: "保存配置", exact: true })
      await submitOnce(
        page,
        page.getByRole("button", { name: "测试", exact: true }),
        "ai_connection_test"
      )
      await expect(save).toBeDisabled()
      await expect(save.locator('[data-slot="spinner"]')).toHaveCount(0)
      await expect(
        page.getByRole("button", { name: "测试", exact: true })
      ).toHaveAttribute("aria-busy", "true")
      await screenshot(page, `${prefix}-ai-test-pending`)
      await reject(page)
      await expect(save).toBeEnabled()
      await submitOnce(page, save, "ai_profile_upsert")
      await expect(
        page.getByRole("button", { name: "保存中…", exact: true })
      ).toBeDisabled()
      await screenshot(page, `${prefix}-profile-pending`)
      await page.evaluate(() => {
        const p = window.submissions[0]
        window.aiSettings = {
          ...window.aiSettings,
          profiles: [
            { ...p.args.request, id: "test-profile", hasApiKey: false },
          ],
          activeProfileId: "test-profile",
        }
        p.resolve(window.aiSettings)
      })
      await expect(save).toBeDisabled()
      await expect(page.locator("[data-sonner-toaster]")).toContainText(
        "配置已保存"
      )
      await dismissNotices(page)
      await page
        .getByRole("button", { name: "重命名提示词", exact: true })
        .click()
      const dialog = page.getByRole("dialog")
      const prompt = dialog.getByRole("textbox", { name: "AI 重命名提示词" })
      await prompt.fill("保留归档主题，删除冗余字符。")
      await submitOnce(
        page,
        dialog.getByRole("button", { name: "保存提示词", exact: true }),
        "ai_settings_update"
      )
      await expect(prompt).toBeDisabled()
      await expect(
        dialog.getByRole("button", { name: "保存中…", exact: true })
      ).toBeInViewport({ ratio: 1 })
      await screenshot(page, `${prefix}-prompt-pending`)
      await reject(page)
      await expect(prompt).toHaveValue("保留归档主题，删除冗余字符。")
      await screenshot(page, `${prefix}-prompt-error`)
      await submitOnce(
        page,
        dialog.getByRole("button", { name: "保存提示词", exact: true }),
        "ai_settings_update"
      )
      await page.evaluate(() => {
        const p = window.submissions[0]
        window.aiSettings = { ...window.aiSettings, ...p.args.request }
        p.resolve(window.aiSettings)
      })
      await expect(page.locator("[data-sonner-toaster]")).toContainText(
        "提示词已保存"
      )
      await expect(
        dialog.getByRole("button", { name: "保存提示词", exact: true })
      ).toBeDisabled()
      await screenshot(page, `${prefix}-prompt-success`)
      expect(errors).toEqual([])
    })

    test(`字典添加防止连点，失败保留输入与底栏操作（${prefix}）`, async ({
      page,
    }) => {
      await setup(page, theme, width)
      await page
        .getByRole("navigation")
        .getByRole("button", { name: "字典", exact: true })
        .click()
      await page.getByRole("button", { name: "添加密码", exact: true }).click()
      const dialog = page.getByRole("dialog")
      const input = dialog.getByRole("textbox", { name: "粘贴多行" })
      await input.fill("测试候选一\n测试候选二")
      await submitOnce(
        page,
        dialog.getByRole("button", { name: "添加多行", exact: true }),
        "dictionary_add"
      )
      await expect(input).toBeDisabled()
      await expect(
        dialog.getByRole("button", { name: "添加中…", exact: true })
      ).toBeInViewport({ ratio: 1 })
      await screenshot(page, `${prefix}-dictionary-pending`)
      await reject(page, dialog.getByRole("status"))
      await expect(input).toHaveValue("测试候选一\n测试候选二")
      await expect(dialog.getByText(/输入内容已保留/)).toBeVisible()
      await expect(
        dialog.getByRole("button", { name: "添加多行", exact: true })
      ).toBeInViewport({ ratio: 1 })
      await screenshot(page, `${prefix}-dictionary-error`)
      await submitOnce(
        page,
        dialog.getByRole("button", { name: "添加多行", exact: true }),
        "dictionary_add"
      )
      await page.evaluate(() =>
        window.submissions[0].resolve({
          submittedCount: 2,
          addedCount: 2,
          duplicateCount: 0,
          invalidCount: 0,
        })
      )
      await expect(input).toHaveValue("")
      await expect(dialog.getByRole("status")).toContainText("批量新增完成")
      await screenshot(page, `${prefix}-dictionary-success`)
    })

    test(`设置保存与备份有独立忙碌状态并防止重复调用（${prefix}）`, async ({
      page,
    }) => {
      await setup(page, theme, width)
      await page.getByRole("button", { name: "解压行为", exact: true }).click()
      const dialog = page.getByRole("dialog")
      await dialog
        .getByRole("spinbutton", { name: "目录扫描文件数上限" })
        .fill("12")
      await submitOnce(
        page,
        dialog.getByRole("button", { name: "保存上限", exact: true }),
        "settings_update"
      )
      await expect(
        dialog.getByRole("button", { name: "保存中…", exact: true })
      ).toBeDisabled()
      await expect(
        dialog.getByRole("button", { name: "保存中…", exact: true })
      ).toBeInViewport({ ratio: 1 })
      await screenshot(page, `${prefix}-engine-pending`)
      await reject(page)
      await expect(
        dialog.getByRole("spinbutton", { name: "目录扫描文件数上限" })
      ).toHaveValue("12")
      await dialog.getByRole("button", { name: "关闭", exact: true }).click()
      await page.getByRole("button", { name: "引擎管理", exact: true }).click()
      await dialog.getByRole("tab", { name: "工具目录", exact: true }).click()
      await dialog
        .getByRole("textbox", { name: "公共目录（绝对路径）" })
        .fill("C:\\测试工具")
      await submitOnce(
        page,
        dialog.getByRole("button", { name: "保存目录", exact: true }),
        "tool_set_tools_directory"
      )
      await expect(
        dialog.getByRole("button", { name: "保存目录", exact: true })
      ).toBeDisabled()
      await expect(
        dialog.locator('[data-slot="workbench-details-footer"]')
      ).toContainText("正在保存公共工具目录")
      await expect(
        dialog.getByRole("button", { name: "保存目录", exact: true })
      ).toBeInViewport({ ratio: 1 })
      await screenshot(page, `${prefix}-tools-pending`)
      const progressBounds = await dialog
        .getByText("正在保存公共工具目录…", { exact: true })
        .boundingBox()
      const saveBounds = await dialog
        .getByRole("button", { name: "保存目录", exact: true })
        .boundingBox()
      expect(progressBounds.y + progressBounds.height).toBeLessThanOrEqual(
        saveBounds.y
      )
      await reject(page)
      await expect(
        dialog.getByRole("textbox", { name: "公共目录（绝对路径）" })
      ).toHaveValue("C:\\测试工具")
      await dialog.getByRole("button", { name: "关闭", exact: true }).click()
      await page.getByRole("tab", { name: "应用", exact: true }).click()
      await page.getByRole("spinbutton", { name: "最大磁盘占用" }).fill("50")
      await submitOnce(
        page,
        page.getByRole("button", { name: "保存", exact: true }),
        "settings_update"
      )
      await expect(
        page.getByRole("button", { name: "保存中…", exact: true })
      ).toBeDisabled()
      await screenshot(page, `${prefix}-app-pending`)
      await expect(
        page.getByRole("button", { name: "保存中…", exact: true })
      ).toBeInViewport({ ratio: 1 })
      await page.evaluate(() => {
        window.appSettings.logging.maxDiskMib = 50
        window.submissions[0].resolve(window.appSettings)
      })
      await expect(page.locator("[data-sonner-toaster]")).toContainText(
        "已调整为 50"
      )
      const debug = page.getByRole("button", {
        name: "调试 包含更细的界面诊断",
        exact: true,
      })
      await debug.scrollIntoViewIfNeeded()
      await submitOnce(page, debug, "settings_update")
      await expect(
        page.getByText("正在保存日志级别…", { exact: true })
      ).toBeVisible()
      await expect(debug).toBeDisabled()
      await screenshot(page, `${prefix}-log-level-pending`)
      await reject(page)
      await expect(
        page.getByRole("button", {
          name: "信息 推荐的日常运行记录",
          exact: true,
        })
      ).toHaveAttribute("aria-pressed", "true")
      await page.getByRole("tab", { name: "数据", exact: true }).click()
      await expect(
        page.getByRole("button", { name: "创建备份", exact: true })
      ).toBeEnabled()
      await submitOnce(
        page,
        page.getByRole("button", { name: "创建备份", exact: true }),
        "database_backup"
      )
      await page.evaluate(() =>
        window.submissions[0].resolve({
          path: "测试目录/数据备份.db",
          byteCount: 1024,
          createdAtMs: Date.now(),
        })
      )
      await expect(page.locator("[data-sonner-toaster]")).toContainText(
        "数据库备份已创建"
      )
      await screenshot(page, `${prefix}-backup-success`)
      await submitOnce(
        page,
        page.getByRole("button", { name: "创建备份", exact: true }),
        "database_backup"
      )
      await expect(
        page.getByRole("button", { name: "正在备份…", exact: true })
      ).toBeDisabled()
      await expect(
        page.getByRole("button", { name: "从备份恢复", exact: true })
      ).toBeDisabled()
      await screenshot(page, `${prefix}-backup-pending`)
      await reject(page)
      await expect(
        page.getByRole("button", { name: "创建备份", exact: true })
      ).toBeEnabled()
    })
  }
