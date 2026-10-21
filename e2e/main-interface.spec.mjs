import { test, expect } from "@playwright/test"

test("中等宽度的输出位置开关与目录选项不重叠", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 600 })
  await page.goto("/")
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "压缩", exact: true })
    .click()
  const output = page.locator(".byte-compress-output")
  await expect(output).toBeVisible()
  const heading = await output.locator(":scope > div").first().boundingBox()
  const options = await output
    .locator('[data-slot="toggle-group"]')
    .boundingBox()
  expect(options.y).toBeGreaterThanOrEqual(heading.y + heading.height)
  await expect(
    page.getByRole("button", { name: "开始压缩", exact: true })
  ).toBeInViewport({ ratio: 1 })
})

for (const [width, height] of [
  [900, 650],
  [768, 600],
]) {
  test(`小窗口切换设置分类后回到顶部，AI 保存按钮完整可见（${width}×${height}）`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height })
    await page.goto("/")
    await page.getByRole("button", { name: "设置", exact: true }).click()
    await page.getByRole("tab", { name: "解密引擎", exact: true }).click()
    await page
      .getByRole("button", { name: "引擎管理", exact: true })
      .scrollIntoViewIfNeeded()
    await page.getByRole("tab", { name: "AI 模型", exact: true }).click()
    await expect(
      page.getByRole("button", { name: "新建配置", exact: true })
    ).toBeInViewport({ ratio: 1 })
    await expect(
      page.getByRole("button", { name: "保存配置", exact: true })
    ).toBeInViewport({ ratio: 1 })
    const prompt = page.getByRole("button", {
      name: "重命名提示词",
      exact: true,
    })
    await expect(prompt).toBeInViewport({ ratio: 1 })
    await prompt.click()
    const drawer = page.getByRole("dialog", { name: "归档重命名提示词" })
    await expect(drawer).toBeVisible()
    const bounds = await drawer.boundingBox()
    expect(bounds.y).toBe(0)
    expect(bounds.height).toBe(height)
    await expect(
      drawer.getByRole("heading", { name: "归档重命名提示词", exact: true })
    ).toHaveCount(1)
    const editor = drawer.getByRole("textbox", {
      name: "AI 重命名提示词",
      exact: true,
    })
    expect((await editor.boundingBox()).height).toBeGreaterThan(300)
    await editor.fill("根据资料内容生成简洁的归档名称。\n".repeat(150))
    await expect(
      drawer.getByRole("button", { name: "保存提示词", exact: true })
    ).toBeInViewport({ ratio: 1 })
    await expect(
      drawer.getByRole("button", { name: "关闭", exact: true })
    ).toBeInViewport({ ratio: 1 })
  })
}

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
        content.getByRole("heading", {
          level: 1,
          name: id === "extract" ? "打开压缩包。" : label,
          exact: true,
        })
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
