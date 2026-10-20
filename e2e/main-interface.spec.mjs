import { test, expect } from "@playwright/test"

for (const width of [1280, 900, 390, 320]) {
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
    await expect(page.locator("[data-slot=archive-stage]")).toContainText(
      "等待选择压缩包"
    )
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
    await expect(page.getByRole("heading", { name: "指纹档案" })).toBeVisible()
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
