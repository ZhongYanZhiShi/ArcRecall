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
