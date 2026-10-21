import { test, expect } from "@playwright/test"

async function contrast(locator, property, pseudo = null) {
  return locator.evaluate(
    (element, { property, pseudo }) => {
      const canvas = document.createElement("canvas")
      canvas.width = canvas.height = 1
      const context = canvas.getContext("2d", { willReadFrequently: true })
      const rgba = (value) => {
        context.clearRect(0, 0, 1, 1)
        context.fillStyle = value
        context.fillRect(0, 0, 1, 1)
        return [...context.getImageData(0, 0, 1, 1).data]
      }
      const blend = (color, background) =>
        color
          .slice(0, 3)
          .map(
            (value, i) =>
              (value * color[3]) / 255 + background[i] * (1 - color[3] / 255)
          )
      const ancestors = []
      for (let node = element; node; node = node.parentElement)
        ancestors.unshift(node)
      let background = [255, 255, 255]
      for (const node of ancestors)
        background = blend(
          rgba(getComputedStyle(node).backgroundColor),
          background
        )
      const foreground = blend(
        rgba(getComputedStyle(element, pseudo)[property]),
        background
      )
      const luminance = (color) =>
        color
          .map((value) => {
            value /= 255
            return value <= 0.04045
              ? value / 12.92
              : ((value + 0.055) / 1.055) ** 2.4
          })
          .reduce(
            (sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i],
            0
          )
      const a = luminance(foreground),
        b = luminance(background)
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
    },
    { property, pseudo }
  )
}

for (const width of [1920, 900, 390]) {
  test(`浅色按钮悬停与输入提示保持可读对比度（${width}px）`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 1920 ? 1080 : 650 })
    await page.goto("/")
    await page.getByRole("button", { name: "切换到浅色", exact: true }).click()
    await page
      .getByRole("navigation")
      .getByRole("button", { name: "字典", exact: true })
      .click()
    await page.getByRole("button", { name: "添加密码", exact: true }).click()
    const drawer = page.getByRole("dialog")
    const upload = drawer.getByRole("button", { name: "选择文件", exact: true })
    await upload.hover()
    await expect
      .poll(() => contrast(upload, "color"))
      .toBeGreaterThanOrEqual(4.5)
    const editor = drawer.getByRole("textbox", {
      name: "粘贴多行",
      exact: true,
    })
    expect(
      await contrast(editor, "color", "::placeholder")
    ).toBeGreaterThanOrEqual(4.5)
    expect(await contrast(editor, "borderTopColor")).toBeGreaterThanOrEqual(3)
    const add = drawer.getByRole("button", { name: "添加多行", exact: true })
    await expect(add).toBeDisabled()
    expect(await contrast(add, "color")).toBeGreaterThanOrEqual(4.5)
    await page.keyboard.press("Tab")
    await editor.focus()
    expect(await editor.evaluate((el) => el.matches(":focus-visible"))).toBe(
      true
    )
    await editor.fill("example-password")
    await expect(add).toBeEnabled()
    await expect(add).toBeInViewport({ ratio: 1 })
  })
}
