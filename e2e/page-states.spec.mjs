import { test, expect } from "@playwright/test"

for (const theme of ["dark", "light"]) {
  for (const width of [900, 390]) {
    test(`读取失败有明确提示且可重试恢复（${theme} ${width}px）`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: width === 390 ? 500 : 650 })
      await page.goto("/")
      await expect(page.getByRole("navigation")).toBeVisible()
      if (theme === "light")
        await page
          .getByRole("button", { name: "切换到浅色", exact: true })
          .click()
      await page
        .getByRole("navigation")
        .getByRole("button", { name: "设置", exact: true })
        .click()
      await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0)
      await page.evaluate(() => {
        window.__STATE_FAIL__ = true
        window.__TAURI_INTERNALS__ = {
          async invoke(command) {
            if (command === "ai_profiles_list") {
              if (window.__STATE_FAIL__)
                throw new Error("无法读取本机配置，请检查文件访问权限。")
              return {
                profiles: [],
                activeProfileId: "",
                renamePrompt: "生成简洁归档名称。",
              }
            }
            if (command === "log_list") {
              if (window.__STATE_FAIL__) throw new Error("无法读取本机日志。")
              return {
                entries: [],
                totalCount: 0,
                matchedCount: 0,
                hasMore: false,
                stats: {
                  errorCount: 0,
                  warnCount: 0,
                  infoCount: 0,
                  debugCount: 0,
                  fileCount: 0,
                  diskBytes: 0,
                  unreadableLineCount: 0,
                },
                directory: "",
              }
            }
            if (command === "history_list") {
              if (window.__STATE_FAIL__)
                throw new Error("无法读取本机恢复记录。")
              return {
                entries: [],
                totalCount: 0,
                matchedCount: 0,
                passwordCount: 0,
              }
            }
            return null
          },
        }
      })
      const nav = (name) =>
        page
          .getByRole("navigation")
          .getByRole("button", { name, exact: true })
          .click()
      await nav("设置")
      await page.getByRole("tab", { name: "AI 模型", exact: true }).click()
      await expect(
        page.getByText("AI 配置读取失败", { exact: true })
      ).toBeVisible()
      const retry = page.getByRole("button", {
        name: "重试读取配置",
        exact: true,
      })
      await expect(retry).toBeInViewport({ ratio: 1 })
      await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0)
      await page.evaluate(() => {
        window.__STATE_FAIL__ = false
      })
      await retry.click()
      await expect(
        page.getByRole("textbox", { name: "配置名称", exact: true })
      ).toBeEnabled()
      await expect(
        page.getByText("AI 配置读取失败", { exact: true })
      ).toHaveCount(0)
      await page.evaluate(() => {
        window.__STATE_FAIL__ = true
      })
      await nav("历史")
      const retryHistory = page.getByRole("button", {
        name: "重试读取历史",
        exact: true,
      })
      await expect(retryHistory).toBeInViewport({ ratio: 1 })
      await page.evaluate(() => {
        window.__STATE_FAIL__ = false
      })
      await retryHistory.click()
      await expect(
        page.getByText("还没有成功记录", { exact: true })
      ).toBeVisible()
      await page.evaluate(() => {
        window.__STATE_FAIL__ = true
      })
      await nav("日志")
      await page.getByRole("checkbox", { name: /自动刷新/ }).uncheck()
      await page.getByRole("button", { name: "摘要", exact: true }).click()
      await expect(
        page.getByText("日志读取失败", { exact: true })
      ).toBeVisible()
      await expect(
        page.getByText("当前没有需关注的日志", { exact: true })
      ).toHaveCount(0)
      const dismiss = page.locator("[data-sonner-toast] [data-close-button]")
      if (await dismiss.count()) await dismiss.first().click()
      const retryLogs = page.getByRole("button", {
        name: "重试读取日志",
        exact: true,
      })
      await retryLogs.scrollIntoViewIfNeeded()
      await expect(retryLogs).toBeInViewport({ ratio: 1 })
      await page.evaluate(() => {
        window.__STATE_FAIL__ = false
      })
      await retryLogs.click()
      await expect(
        page.getByText("当前没有需关注的日志", { exact: true })
      ).toBeVisible()
    })
  }
}
