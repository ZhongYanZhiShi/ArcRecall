import { test, expect } from "@playwright/test"

test("历史表头保持清晰，渐变只出现在表头下方", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 480 })
  await page.goto("/")
  await page.getByRole("button", { name: "历史", exact: true }).click()
  const area = page.locator(".table-scroll-fade:visible")
  const viewport = area.locator('[data-slot="scroll-area-viewport"]')
  const header = area.locator('[data-slot="table-header"]')
  await expect(page.getByRole("combobox", { name: "每页条数" })).toBeEnabled()
  const before = await header.boundingBox()
  expect(
    await viewport.evaluate((el) => el.scrollHeight > el.clientHeight)
  ).toBe(true)
  await expect
    .poll(() =>
      header.evaluate((el) => getComputedStyle(el, "::after").opacity)
    )
    .toBe("0")
  await viewport.evaluate((el) => {
    el.scrollTop = 80
  })
  await expect
    .poll(() =>
      header.evaluate((el) => getComputedStyle(el, "::after").opacity)
    )
    .toBe("1")
  const after = await header.boundingBox()
  expect(Math.abs(after.y - before.y)).toBeLessThan(1)
  expect(
    await viewport.evaluate((el) =>
      getComputedStyle(el).getPropertyValue("--scroll-fade-t-size").trim()
    )
  ).toBe("0px")
  expect(
    Math.abs(
      (await header.evaluate((el) =>
        parseFloat(getComputedStyle(el, "::after").top)
      )) - after.height
    )
  ).toBeLessThan(1)
  await page.screenshot({
    path: test.info().outputPath("history-scrolled.png"),
    animations: "disabled",
  })
  await viewport.evaluate((el) => {
    el.scrollTop = 0
  })
  await expect
    .poll(() =>
      header.evaluate((el) => getComputedStyle(el, "::after").opacity)
    )
    .toBe("0")
})

for (const width of [1280, 390]) {
  test(`历史按名称和路径回看，缺失信息使用占位符（${width}px）`, async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"])
    await page.setViewportSize({ width, height: 844 })
    await page.goto("/")
    await page.getByRole("button", { name: "历史", exact: true }).click()
    const records = page.locator("table:visible, article:visible")
    await expect(
      records.getByText("项目设计素材.7z", { exact: true })
    ).toBeVisible()
    await expect(records.getByText("—", { exact: true })).toHaveCount(3)
    await expect(page.getByText("内容指纹", { exact: true })).toHaveCount(0)
    await expect(
      page.getByText(
        "原名保留首次记录的名称，路径为最近成功解压时的位置。记录仅保存在本机。",
        { exact: true }
      )
    ).toHaveCount(0)
    const search = page.getByRole("searchbox", { name: "搜索压缩包名称或路径" })
    await search.fill("设计素材")
    await search.press("Enter")
    await expect(
      records.getByText("课程资料合集.rar", { exact: true })
    ).toHaveCount(0)
    await page
      .getByRole("button", {
        name: width === 1280 ? "查看密码" : "查看",
        exact: true,
      })
      .click()
    await expect(records.locator("code")).toHaveText("www.example.com")
    await page.evaluate(() => {
      const writeText = navigator.clipboard.writeText.bind(navigator.clipboard)
      navigator.clipboard.writeText = async () => {
        navigator.clipboard.writeText = writeText
        throw new Error("剪贴板暂不可用")
      }
    })
    await page
      .getByRole("button", {
        name: width === 1280 ? "复制密码" : "复制",
        exact: true,
      })
      .click()
    await expect(
      page.locator('[data-sonner-toast][data-type="error"]')
    ).toHaveText("剪贴板暂不可用")
    await expect(
      page.locator('[data-slot="workbench-page"]:visible [role="alert"]')
    ).toHaveCount(0)
    await page
      .getByRole("button", {
        name: width === 1280 ? "复制密码" : "复制",
        exact: true,
      })
      .click()
    const toaster = page.locator("[data-sonner-toaster]")
    await expect(toaster).toHaveAttribute("data-x-position", "right")
    await expect(toaster).toHaveAttribute("data-y-position", "bottom")
    await expect(toaster.getByText("密码已复制", { exact: true })).toBeVisible()
    await expect(
      page
        .locator('[data-slot="workbench-page"]:visible')
        .getByText("密码已复制", { exact: true })
    ).toHaveCount(0)
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("www.example.com")
    await page
      .getByRole("button", { name: "复制压缩包路径", exact: true })
      .click()
    await expect(toaster.getByText("路径已复制", { exact: true })).toBeVisible()
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("D:\\下载\\设计资料\\项目设计素材.7z")
    await page
      .getByRole("button", { name: "复制解压到路径", exact: true })
      .click()
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("D:\\工作\\项目设计素材")
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(1)
    await search.fill("已重命名")
    await search.press("Enter")
    await expect(
      records.getByText("课程资料合集.rar", { exact: true })
    ).toBeVisible()
    await expect(records.locator("code")).toHaveText("••••••••")
    await search.fill("D:\\学习资料")
    await search.press("Enter")
    await expect(
      records.getByText("课程资料合集.rar", { exact: true })
    ).toBeVisible()
    await search.fill("")
    await search.press("Enter")
    await page.screenshot({
      path: test.info().outputPath("history-information.png"),
      animations: "disabled",
    })
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth
      )
    ).toBe(true)
    await page.getByRole("button", { name: "刷新", exact: true }).click()
    await expect(
      toaster.getByText("历史记录已刷新", { exact: true })
    ).toBeVisible()
    const deleteButton =
      width === 1280
        ? page.getByRole("button", {
            name: "删除 项目设计素材.7z 的记录",
            exact: true,
          })
        : page
            .getByRole("article")
            .filter({ hasText: "项目设计素材.7z" })
            .getByRole("button", { name: "删除", exact: true })
    await deleteButton.click()
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "删除", exact: true })
      .click()
    await expect(
      toaster.getByText("历史记录已删除", { exact: true })
    ).toBeVisible()
    await expect(
      records.getByText("项目设计素材.7z", { exact: true })
    ).toHaveCount(0)
    await page.getByRole("button", { name: "历史工具", exact: true }).click()
    await page
      .getByRole("menuitem", { name: "清空历史记录", exact: true })
      .click()
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "清空历史", exact: true })
      .click()
    await expect(
      toaster.getByText("已清空 2 条历史记录", { exact: true })
    ).toBeVisible()
    await expect(
      page
        .getByText("还没有成功记录", { exact: true })
        .filter({ visible: true })
    ).toBeVisible()
    await expect(
      page.locator('[data-slot="workbench-page"]:visible [role="alert"]')
    ).toHaveCount(0)
  })

  test(`历史共用分页：跳转、条数与空结果（${width}px）`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await page.goto("/")
    await page.getByRole("button", { name: "历史", exact: true }).click()
    const size = page.getByRole("combobox", { name: "每页条数" })
    await expect(size).toContainText("100 行/页")
    await size.click()
    await page.getByRole("option", { name: "自定义", exact: true }).click()
    await page.getByRole("spinbutton", { name: "自定义每页条数" }).fill("1")
    await page.getByRole("button", { name: "应用", exact: true }).click()
    const jump = page.getByRole("spinbutton", { name: "跳转页码" })
    await expect(page.getByLabel("共 3 页", { exact: true })).toHaveText("/ 3")
    await page.getByRole("button", { name: "末页", exact: true }).click()
    await expect(jump).toHaveValue("3")
    await expect(
      page.getByRole("button", { name: "下一页", exact: true })
    ).toBeDisabled()
    await jump.fill("2")
    await jump.press("Enter")
    await expect(jump).toHaveValue("2")
    await expect(
      page.getByText("第 2 / 3 页 · 共 3 条", { exact: true })
    ).toBeVisible()
    await jump.fill("1")
    await jump.press("Tab")
    await expect(
      page.getByRole("button", { name: "首页", exact: true })
    ).toBeDisabled()
    await page.screenshot({
      path: test.info().outputPath("history-pagination.png"),
      animations: "disabled",
    })
    await size.click()
    await page.getByRole("option", { name: "1000 行/页", exact: true }).click()
    await expect(size).toContainText("1000 行/页")
    await expect(page.getByLabel("共 1 页", { exact: true })).toBeVisible()
    const search = page.getByRole("searchbox")
    await search.fill("no-such-history")
    await search.press("Enter")
    await expect(jump).toHaveValue("0")
    await expect(jump).toBeDisabled()
    await expect(
      page.getByRole("button", { name: "末页", exact: true })
    ).toBeDisabled()
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth
      )
    ).toBe(true)
  })
}
