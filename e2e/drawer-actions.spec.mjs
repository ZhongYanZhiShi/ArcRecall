import { test, expect } from "@playwright/test"

for (const width of [900, 390]) {
  test(`抽屉底栏随引擎分类切换并保留表单校验（${width}px）`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 650 })
    await page.goto("/")
    await page.getByRole("button", { name: "设置", exact: true }).click()
    await page.getByRole("tab", { name: "解密引擎", exact: true }).click()
    await page.getByRole("button", { name: "解压行为", exact: true }).click()
    const dialog = page.getByRole("dialog")
    const input = dialog.getByRole("spinbutton", {
      name: "目录扫描文件数上限",
      exact: true,
    })
    const save = dialog.getByRole("button", { name: "保存上限", exact: true })
    await input.fill("-1")
    await save.click()
    expect(await input.evaluate((el) => el.validity.valid)).toBe(false)
    await input.fill("12")
    await save.click()
    await expect(page.locator("[data-sonner-toaster]")).toContainText(
      "已保存扫描上限：12"
    )
    const toast = await page
      .locator("[data-sonner-toast]")
      .first()
      .boundingBox()
    const action = await save.boundingBox()
    expect(toast.y + toast.height).toBeLessThanOrEqual(action.y)
    await dialog.getByRole("button", { name: "关闭", exact: true }).click()
    await page.getByRole("button", { name: "引擎管理", exact: true }).click()
    const footer = dialog.locator('[data-slot="workbench-details-footer"]')
    for (const [tab, label, count] of [
      ["工具目录", "保存目录", 2],
      ["John / Perl", "保存", 2],
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
