import { test, expect } from "@playwright/test"

for (const width of [1920, 900, 390]) {
  test(`深色模式区分选中、聚焦和禁用操作（${width}px）`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 1920 ? 1080 : 650 })
    await page.goto("/")
    await expect(page.locator("html")).toHaveClass(/\bdark\b/)
    await page
      .getByRole("button", { name: "打开解压选项", exact: true })
      .click()
    const drawer = page.getByRole("dialog")
    const options = drawer.locator('[data-slot="toggle-group-item"]')
    await expect(options.first()).toBeVisible()
    await expect(
      drawer
        .locator('[data-slot="toggle-group-item"][aria-pressed="true"]')
        .first()
    ).not.toHaveCSS("box-shadow", "none")
    const close = drawer.getByRole("button", { name: "关闭", exact: true })
    await page.keyboard.press("Tab")
    await close.focus()
    expect(await close.evaluate((el) => el.matches(":focus-visible"))).toBe(
      true
    )
    await expect(close).not.toHaveCSS("box-shadow", "none")
    await close.click()
    await page
      .getByRole("navigation")
      .getByRole("button", { name: "压缩", exact: true })
      .click()
    const start = page.getByRole("button", { name: "开始压缩", exact: true })
    await start.scrollIntoViewIfNeeded()
    await expect(start).toBeDisabled()
    await expect(start).toHaveCSS("opacity", "1")
    await expect(start).toHaveCSS("color", "rgb(139, 165, 174)")
  })
}
