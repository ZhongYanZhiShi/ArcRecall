import { test, expect } from "@playwright/test"

for (const width of [1280, 320]) {
  test(`大页字典限制挂载行数，并保留整页选择、复制、键盘导航和搜索（${width}px）`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 800 })
    await context.grantPermissions(["clipboard-read", "clipboard-write"])
    const errors = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.goto("/")
    await page.getByRole("button", { name: "字典", exact: true }).click()
    const candidates = Array.from(
      { length: 20_000 },
      (_, index) => `candidate-${String(index + 1).padStart(5, "0")}`
    )
    await page.locator('input[type="file"]').setInputFiles({
      name: "大页候选.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(candidates.join("\n")),
    })
    await expect(page.getByText("共 20000 条", { exact: true })).toBeVisible()
    const size = page.getByRole("combobox", { name: "每页条数" })
    await size.click()
    await page.getByRole("option", { name: "自定义", exact: true }).click()
    const input = page.getByRole("spinbutton", { name: "自定义每页条数" })
    await input.fill("20000")
    const started = performance.now()
    await input.press("Enter")
    const table = page.getByRole("table")
    await expect(table).toHaveAttribute("aria-rowcount", "20001")
    const rows = table.locator("[data-dictionary-index]")
    await expect.poll(() => rows.count()).toBeLessThan(80)
    const rendered = await rows.count()
    expect(rendered).toBeGreaterThan(5)
    const loadMs = performance.now() - started

    await page.getByRole("checkbox", { name: "全选当前列表" }).check()
    await expect(
      page.getByRole("group", { name: "所选候选操作" })
    ).toContainText("20000")
    await page.getByRole("button", { name: "取消选择", exact: true }).click()

    // Cross the mounted window with Tab and Shift+Tab, not just rows already in the DOM.
    const last = rows.last()
    const index = Number(await last.getAttribute("data-dictionary-index"))
    await last.getByRole("button", { name: /复制候选/ }).focus()
    await page.keyboard.press("Tab")
    await expect(
      table
        .locator(`[data-dictionary-index="${index + 1}"]`)
        .getByRole("checkbox")
    ).toBeFocused()
    await page.keyboard.press("Shift+Tab")
    await expect(
      table
        .locator(`[data-dictionary-index="${index}"]`)
        .getByRole("button", { name: /复制候选/ })
    ).toBeFocused()

    const viewport = page.locator(
      '.table-scroll-fade [data-slot="scroll-area-viewport"]'
    )
    await viewport.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    const lastCopy = page.getByRole("button", {
      name: "复制候选 #20000 的完整密码",
      exact: true,
    })
    await expect(lastCopy).toBeInViewport()
    await lastCopy.click()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      "candidate-20000"
    )
    await expect.poll(() => rows.count()).toBeLessThan(80)
    await page.screenshot({
      path: test.info().outputPath("dictionary-large-page.png"),
    })

    // A smaller result that still needs windowing must recover from a bottom scroll.
    const search = page.getByRole("searchbox", { name: "搜索字典候选" })
    await search.fill("candidate-001")
    await search.press("Enter")
    await expect(table).toHaveAttribute("aria-rowcount", "101")
    await expect(rows).toHaveCount(100)
    await page.getByRole("button", { name: "清除搜索", exact: true }).click()
    await expect(table).toHaveAttribute("aria-rowcount", "20001")
    await viewport.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    await expect(lastCopy).toBeInViewport()
    await search.fill("candidate-01")
    await search.press("Enter")
    await expect(table).toHaveAttribute("aria-rowcount", "1001")
    await expect(
      page.getByRole("button", {
        name: "复制候选 #1000 的完整密码",
        exact: true,
      })
    ).toBeInViewport()
    await expect.poll(() => rows.count()).toBeLessThan(80)
    await page.getByRole("button", { name: "历史", exact: true }).click()
    await page.getByRole("button", { name: "字典", exact: true }).click()
    await expect(
      page.getByRole("button", {
        name: "复制候选 #1000 的完整密码",
        exact: true,
      })
    ).toBeInViewport()
    expect(errors).toEqual([])
    console.log(
      JSON.stringify({
        candidates: 20_000,
        width,
        mountedRows: rendered,
        changePageSizeMs: Math.round(loadMs),
      })
    )
  })
}
