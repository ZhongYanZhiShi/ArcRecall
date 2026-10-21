import { test, expect } from "@playwright/test"

for (const theme of ["light", "dark"]) {
  for (const [width, height] of [
    [900, 650],
    [320, 400],
  ]) {
    test(`弹出层保持在窗口内且通知不遮住底栏（${theme} ${width}px）`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height })
      await page.goto("/")
      if (theme === "light")
        await page
          .getByRole("button", { name: "切换到浅色", exact: true })
          .click()
      const nav = (name) =>
        page
          .getByRole("navigation")
          .getByRole("button", { name, exact: true })
          .click()
      await nav("设置")
      await page.getByRole("tab", { name: "AI 模型", exact: true }).click()
      await page
        .getByRole("combobox", { name: "服务类型", exact: true })
        .click()
      await expect(page.locator('[data-slot="select-content"]')).toBeInViewport(
        { ratio: 1 }
      )
      await page.keyboard.press("Escape")
      await page
        .getByRole("textbox", { name: "配置名称", exact: true })
        .fill("弹窗验证配置")
      await page.getByRole("tab", { name: "应用", exact: true }).click()
      const dialog = page.getByRole("alertdialog")
      await expect(dialog).toBeInViewport({ ratio: 1 })
      const bounds = await dialog.boundingBox()
      expect(bounds.x).toBeGreaterThanOrEqual(15)
      const save = dialog.getByRole("button", {
        name: "保存并离开",
        exact: true,
      })
      await save.hover()
      if (theme === "light")
        await expect(save).toHaveCSS("background-color", "rgb(6, 100, 85)")
      await dialog
        .getByRole("button", { name: "放弃更改", exact: true })
        .click()
      await nav("日志")
      await page.getByRole("button", { name: "日志工具", exact: true }).click()
      await expect(page.getByRole("menu")).toBeInViewport({ ratio: 1 })
      await page.keyboard.press("Escape")
      await nav("字典")
      await page.getByRole("button", { name: "添加密码", exact: true }).click()
      await page
        .getByRole("textbox", { name: "新增单条", exact: true })
        .fill("overlay-test-password")
      await page.getByRole("button", { name: "添加", exact: true }).click()
      const toast = page.locator("[data-sonner-toast]").first()
      await expect(toast).toBeInViewport({ ratio: 1 })
      const notification = await toast.boundingBox()
      const footer = await page
        .locator('[data-slot="dictionary-add-footer"]')
        .boundingBox()
      expect(notification.y + notification.height).toBeLessThanOrEqual(footer.y)
      await toast.getByRole("button", { name: "关闭通知", exact: true }).click()
      await expect(toast).toHaveCount(0)
    })
  }
}
