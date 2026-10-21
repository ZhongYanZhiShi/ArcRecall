import { test, expect } from "@playwright/test"

for (const width of [1280, 390, 320]) {
  test(`字典：添加、搜索、复制与行选择互不干扰（${width}px）`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 844 })
    await context.grantPermissions(["clipboard-read", "clipboard-write"])
    await page.goto("/")
    await page.getByRole("button", { name: "字典", exact: true }).click()
    await expect(page.getByText(/解压时自动尝试这些候选密码。/)).toBeVisible()
    await expect(page.getByText("字典还是空的")).toBeVisible()
    await page.getByRole("button", { name: "添加密码", exact: true }).click()
    const sheet = page.getByRole("dialog")
    const notifications = page.locator("[data-sonner-toaster]")
    const addFeedback = sheet.getByRole("status")
    const candidate = "long-password-".repeat(12) + "独特后缀"
    await sheet.getByLabel("新增单条", { exact: true }).fill(candidate)
    await sheet.getByRole("button", { name: "添加", exact: true }).click()
    await expect(addFeedback).toContainText("新增 1")
    await sheet.getByLabel("新增单条", { exact: true }).fill(candidate)
    await sheet.getByRole("button", { name: "添加", exact: true }).click()
    await expect(addFeedback).toContainText("重复 1")
    await expect(addFeedback).toBeInViewport()
    await sheet
      .getByLabel("粘贴多行", { exact: true })
      .fill(`${candidate}\nsecond-password`)
    await sheet.getByRole("button", { name: "添加多行", exact: true }).click()
    await expect(addFeedback).toContainText("新增 1")
    await expect(addFeedback).toContainText("重复 1")
    await page.screenshot({
      path: test.info().outputPath("dictionary-add.png"),
      animations: "disabled",
    })
    await sheet.getByRole("button", { name: "关闭", exact: true }).click()
    const search = page.getByRole("searchbox", { name: "搜索字典候选" })
    await search.fill("no-such-candidate")
    await search.press("Enter")
    await expect(
      page.getByText("没有匹配的候选", { exact: true })
    ).toBeVisible()
    await page.getByRole("button", { name: "显示全部候选" }).click()
    await expect(search).toHaveValue("")
    const copy = page.getByRole("button", {
      name: "复制候选 #1 的完整密码",
      exact: true,
    })
    const checkbox = page.getByRole("checkbox", {
      name: "选择候选 #1",
      exact: true,
    })
    const row = page.getByRole("row").filter({ has: copy })
    await copy.focus()
    await page.keyboard.press("Enter")
    await expect(copy.locator('[aria-label="已复制"]')).toBeVisible()
    await expect(
      notifications.getByText("密码已复制", { exact: true })
    ).toBeVisible()
    await expect(sheet).toHaveCount(0)
    await expect(checkbox).not.toBeChecked()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      candidate
    )
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth
      )
    ).toBe(true)
    const rowBeforeSelection = await row.boundingBox()
    const tableBeforeSelection = await page.getByRole("table").boundingBox()
    await row.getByRole("cell").last().click()
    await expect(checkbox).toBeChecked()
    await expect(
      page.getByRole("group", { name: "所选候选操作" })
    ).toBeVisible()
    expect(await row.boundingBox()).toEqual(rowBeforeSelection)
    expect(await page.getByRole("table").boundingBox()).toEqual(
      tableBeforeSelection
    )
    await page.screenshot({
      path: test.info().outputPath("dictionary-selected.png"),
      animations: "disabled",
    })
    await page.getByRole("button", { name: "取消选择", exact: true }).click()
    await expect(checkbox).not.toBeChecked()
    await expect(search).toBeVisible()
    expect(await row.boundingBox()).toEqual(rowBeforeSelection)
    await row.getByRole("cell").last().click()
    await copy.click()
    await expect(checkbox).toBeChecked()
    await checkbox.click()
    await expect(checkbox).not.toBeChecked()
    await row.getByRole("cell").last().click()
    await expect(checkbox).toBeChecked()
    await row.getByRole("cell").last().click()
    await expect(checkbox).not.toBeChecked()
    await checkbox.focus()
    await page.keyboard.press("Space")
    await expect(checkbox).toBeChecked()
    await page.keyboard.press("Space")
    await expect(checkbox).not.toBeChecked()
    await page.screenshot({
      path: test.info().outputPath("dictionary-list.png"),
      animations: "disabled",
    })
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth
      )
    ).toBe(true)

    await page.getByRole("button", { name: "添加密码", exact: true }).click()
    await sheet
      .getByLabel("粘贴多行", { exact: true })
      .fill(
        Array.from(
          { length: 40 },
          (_, index) => `scroll-candidate-${index}`
        ).join("\n")
      )
    await sheet.getByRole("button", { name: "添加多行", exact: true }).click()
    await expect(addFeedback).toContainText("新增 40")
    await sheet.getByRole("button", { name: "关闭", exact: true }).click()
    const viewport = page.locator(
      '.table-scroll-fade [data-slot="scroll-area-viewport"]'
    )
    const header = page.locator('.table-scroll-fade [data-slot="table-header"]')
    const headerBefore = await header.boundingBox()
    await expect
      .poll(() =>
        header.evaluate(
          (element) => getComputedStyle(element, "::after").opacity
        )
      )
      .toBe("0")
    const sizeSelect = page.getByRole("combobox", { name: "每页条数" })
    await sizeSelect.click()
    await page.getByRole("option", { name: "自定义", exact: true }).click()
    const customSize = page.getByRole("spinbutton", { name: "自定义每页条数" })
    await customSize.fill("10")
    await page.getByRole("button", { name: "应用", exact: true }).click()
    await expect(
      page.getByText("第 1 / 5 页 · 共 42 条", { exact: true })
    ).toBeVisible()
    await expect(page.getByRole("row")).toHaveCount(11)
    const jump = page.getByRole("spinbutton", { name: "跳转页码" })
    await jump.fill("5")
    await jump.press("Enter")
    await expect(
      page.getByText("第 5 / 5 页 · 共 42 条", { exact: true })
    ).toBeVisible()
    await expect(page.getByRole("row")).toHaveCount(3)
    await expect(page.getByText(/页加载完成/)).toHaveCount(0)
    await expect(
      page.getByRole("button", { name: "下一页", exact: true })
    ).toBeDisabled()
    await jump.fill("6")
    await expect(jump).toHaveValue("5")
    await jump.press("Enter")
    await expect(
      page.getByText("第 5 / 5 页 · 共 42 条", { exact: true })
    ).toBeVisible()
    await jump.fill("0")
    await expect(jump).toHaveValue("1")
    await jump.fill("-2")
    await expect(jump).toHaveValue("1")
    await jump.fill("9999")
    await expect(jump).toHaveValue("5")
    await jump.fill("")
    await expect(jump).toHaveValue("")
    await jump.fill("2")
    await page.getByRole("heading", { level: 1 }).click()
    await expect(jump).toHaveValue("2")
    await expect(page.getByLabel("共 5 页", { exact: true })).toHaveText("/ 5")
    await expect(
      page.getByText("第 2 / 5 页 · 共 42 条", { exact: true })
    ).toBeVisible()
    await jump.fill("")
    await page.getByRole("heading", { level: 1 }).click()
    await expect(jump).toHaveValue("2")
    await page.screenshot({
      path: test.info().outputPath("dictionary-pagination.png"),
      animations: "disabled",
    })
    await page.getByRole("button", { name: "首页", exact: true }).click()
    await expect(jump).toHaveValue("1")
    await page.getByRole("button", { name: "末页", exact: true }).click()
    await expect(jump).toHaveValue("5")
    await sizeSelect.click()
    await page.getByRole("option", { name: "自定义", exact: true }).click()
    await customSize.fill("20000")
    await customSize.press("Enter")
    await expect(sizeSelect).toContainText("20000 行/页")
    await expect(jump).toHaveValue("1")
    await expect(page.getByRole("row")).toHaveCount(43)
    for (const size of [50, 100, 500, 1000]) {
      await sizeSelect.click()
      await page
        .getByRole("option", { name: `${size} 行/页`, exact: true })
        .click()
      await expect(sizeSelect).toContainText(`${size} 行/页`)
      await expect(
        page.getByText("第 1 / 1 页 · 共 42 条", { exact: true })
      ).toBeVisible()
      await expect(page.getByRole("row")).toHaveCount(43)
    }
    await viewport.evaluate((element) => {
      element.scrollTop = 220
    })
    await expect
      .poll(() =>
        header.evaluate(
          (element) => getComputedStyle(element, "::after").opacity
        )
      )
      .toBe("1")
    const headerAfter = await header.boundingBox()
    expect(Math.abs(headerAfter.y - headerBefore.y)).toBeLessThan(1)
    expect(
      await viewport.evaluate((element) =>
        getComputedStyle(element)
          .getPropertyValue("--scroll-fade-t-size")
          .trim()
      )
    ).toBe("0px")
    const fadeTop = await header.evaluate((element) =>
      parseFloat(getComputedStyle(element, "::after").top)
    )
    expect(Math.abs(fadeTop - headerAfter.height)).toBeLessThan(1)
    await page.screenshot({
      path: test.info().outputPath("dictionary-scrolled.png"),
      animations: "disabled",
    })
    await viewport.evaluate((element) => {
      element.scrollTop = 0
    })
    await expect
      .poll(() =>
        header.evaluate(
          (element) => getComputedStyle(element, "::after").opacity
        )
      )
      .toBe("0")
  })
}
