import { test, expect } from "@playwright/test"

for (const width of [900, 390]) {
  test(`页内扫描限制可保存且引擎抽屉底栏随分类切换（${width}px）`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 650 })
    await page.goto("/")
    await page.getByRole("button", { name: "设置", exact: true }).click()
    await page.getByRole("tab", { name: "解压与解密", exact: true }).click()
    const dialog = page.getByRole("dialog")
    const input = page.getByRole("spinbutton", {
      name: "目录扫描文件数上限",
      exact: true,
    })
    const save = page.getByRole("button", { name: "保存上限", exact: true })
    await input.fill("-1")
    await save.click()
    expect(await input.evaluate((el) => el.validity.valid)).toBe(false)
    await input.fill("12")
    await save.click()
    await expect(page.locator("[data-sonner-toaster]")).toContainText(
      "已保存扫描上限：12"
    )
    await page.getByRole("button", { name: "关闭通知", exact: true }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await page.getByRole("button", { name: "引擎管理", exact: true }).click()
    const footer = dialog.locator('[data-slot="workbench-details-footer"]')
    for (const [tab, label, count] of [
      ["工具目录", "保存目录", 3],
      ["John / Perl", "保存", 3],
      ["Hashcat", "下载并安装", 1],
      ["完整引擎包", "离线部署", 1],
    ]) {
      await dialog.getByRole("tab", { name: tab, exact: true }).click()
      await expect(
        footer.getByRole("button", { name: label, exact: true })
      ).toBeInViewport({ ratio: 1 })
      await expect(footer.getByRole("button")).toHaveCount(count)
      const bounds = await footer.boundingBox()
      expect(Math.round(bounds.y + bounds.height)).toBe(650)
    }
  })
}

test("解压选项集中归组且文件位置在页内展开", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "设置", exact: true }).click()
  await expect(page.getByRole("tab")).toHaveText([
    "常规",
    "解压与解密",
    "AI 模型",
    "数据",
  ])
  await expect(
    page.getByRole("spinbutton", { name: "最大嵌套深度" })
  ).toBeVisible()
  await expect(
    page.getByRole("switch", { name: "智能清理空文件夹" })
  ).toBeVisible()
  await page.getByRole("tab", { name: "常规", exact: true }).click()
  await expect(
    page.getByRole("spinbutton", { name: "最大嵌套深度" })
  ).toHaveCount(0)
  await page.getByRole("tab", { name: "数据", exact: true }).click()
  await page.getByRole("button", { name: "文件位置", exact: true }).click()
  await expect(page.getByText("数据根目录", { exact: true })).toBeVisible()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await page.getByRole("button", { name: "文件位置", exact: true }).click()
  await expect(page.getByText("数据根目录", { exact: true })).not.toBeVisible()
})
