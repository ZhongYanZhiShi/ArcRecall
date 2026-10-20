import { test, expect } from "@playwright/test"

for (const width of [2560, 1920, 1280, 900, 390, 320]) {
  test(`主入口使用字节流界面并保留跨页草稿与主题切换（${width}px）`, async ({
    page,
  }) => {
    const errors = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.emulateMedia({ colorScheme: "light" })
    await page.setViewportSize({ width, height: width <= 900 ? 650 : 844 })
    await page.goto("/")
    const navigation = page.getByRole("navigation", { name: "功能切换" })
    await expect(
      navigation.getByRole("button", { name: "解压", exact: true })
    ).toHaveAttribute("aria-current", "page")
    await expect(page.getByText("打开压缩包。", { exact: true })).toBeVisible()
    await expect(page.locator("[data-slot=archive-stage]")).toHaveCount(0)
    await expect(page.locator("html")).toHaveClass(/\bbyte\b/)
    await expect(page.locator("html")).toHaveClass(/\bdark\b/)
    await expect(page.locator("body")).toHaveCSS(
      "background-color",
      "rgb(8, 17, 23)"
    )
    await expect(page.locator(".byte-stream")).toHaveAttribute(
      "aria-hidden",
      "true"
    )
    await navigation.getByRole("button", { name: "压缩", exact: true }).click()
    const name = page.getByLabel("归档基础名称", { exact: true })
    await name.fill("待整理资料")
    const password = page.getByLabel("密码（可选）", { exact: true })
    await password.fill("layout-check-password")
    await page
      .getByLabel("确认新密码", { exact: true })
      .fill("layout-check-password")
    await page.getByRole("button", { name: "显示密码", exact: true }).click()
    await expect(password).toHaveAttribute("type", "text")
    await expect(password).toHaveValue("layout-check-password")
    const start = page.getByRole("button", { name: "开始压缩", exact: true })
    await start.scrollIntoViewIfNeeded()
    await expect(start).toBeInViewport()
    await navigation.getByRole("button", { name: "历史", exact: true }).click()
    await expect(
      page.getByRole("heading", { name: "历史", exact: true })
    ).toBeVisible()
    await navigation.getByRole("button", { name: "压缩", exact: true }).click()
    await expect(name).toHaveValue("待整理资料")
    await page.getByRole("button", { name: "切换到浅色", exact: true }).click()
    await expect(page.locator("html")).not.toHaveClass(/\bdark\b/)
    await page.getByRole("button", { name: "切换到深色", exact: true }).click()
    await expect(page.locator("html")).toHaveClass(/\bdark\b/)
    await navigation.getByRole("button", { name: "解压", exact: true }).click()
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth
      )
    ).toBe(true)
    expect(errors).toEqual([])
    await page.screenshot({
      path: test.info().outputPath("new-main.png"),
      animations: "disabled",
    })
  })
}

for (const width of [2560, 1920, 390]) {
  test(`功能页随窗口缩放保持居中、可读且无横向溢出（${width}px）`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width > 1000 ? 1440 : 844 })
    await page.goto("/")
    const errors = []
    page.on("pageerror", (error) => errors.push(error.message))
    for (const [id, label, limit] of [
      ["extract", "解压", 1600],
      ["compress", "压缩", 1600],
      ["dictionary", "字典", 1600],
      ["history", "历史", 1600],
      ["logs", "日志", 1600],
      ["settings", "设置", 1600],
    ]) {
      await page
        .getByRole("navigation")
        .getByRole("button", { name: label, exact: true })
        .click()
      const content = page.locator(
        `[data-workbench="${id}"] [data-slot="workbench-page-content"]`
      )
      await expect(content).toBeVisible()
      await expect(
        content.getByRole("heading", { level: 1, name: label, exact: true })
      ).toBeVisible()
      const bounds = await content.boundingBox()
      expect(bounds.width).toBeLessThanOrEqual(limit)
      expect(Math.abs(bounds.x - (width - bounds.width) / 2)).toBeLessThan(2)
      expect(
        await content.evaluate((el) => el.scrollWidth <= el.clientWidth)
      ).toBe(true)
      if (id === "compress") {
        const start = page.getByRole("button", {
          name: "开始压缩",
          exact: true,
        })
        await start.scrollIntoViewIfNeeded()
        await expect(start).toBeInViewport()
      }
      if (id === "settings") {
        for (const name of ["AI 模型", "解密引擎", "应用", "数据"]) {
          await page.getByRole("tab", { name, exact: true }).click()
          await expect(
            page.getByRole("tabpanel", { name, exact: true })
          ).toBeVisible()
          expect(
            await content.evaluate((el) => el.scrollWidth <= el.clientWidth)
          ).toBe(true)
        }
      }
    }
    expect(errors).toEqual([])
  })
}
