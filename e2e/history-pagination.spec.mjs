import { test, expect } from "@playwright/test"

for (const width of [1280, 390]) {
  test(`嵌套归档默认收起，展开后可打开文件夹（${width}px）`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 })
    await page.goto("/")
    await page.getByRole("button", { name: "历史", exact: true }).click()
    await expect(page.getByRole("combobox", { name: "每页条数" })).toBeEnabled()
    await page.evaluate(() => {
      window.__HISTORY_OPENED__ = []
      const child = {
        id: 2,
        archiveName: "嵌套归档.zip",
        archivePath: "D:\\输出\\顶层\\嵌套归档.zip",
        outputDirectory: "D:\\输出\\顶层\\嵌套",
        archiveFormat: "ZIP",
        fileSize: 1024,
        volumeCount: 1,
        lastVerifiedAtMs: 1_792_324_800_000,
        hasPassword: true,
      }
      const root = {
        ...child,
        id: 1,
        archiveName: "顶层归档.zip",
        archivePath: "C:\\[测试分组] 中文目录\\顶层归档.zip",
        outputDirectory: "D:\\输出\\顶层",
        children: [child],
      }
      window.__TAURI_INTERNALS__ = {
        async invoke(command, args) {
          if (command === "history_list")
            return {
              entries: [root],
              totalCount: 1,
              matchedCount: 1,
              passwordCount: 2,
            }
          if (command === "history_reveal_password") {
            if (window.__HISTORY_DEFER_REVEAL__) {
              return new Promise((resolve) => {
                window.__HISTORY_REVEAL_RESOLVE__ = resolve
              })
            }
            return "nested-secret"
          }
          if (command === "open_path") {
            if (window.__HISTORY_OPEN_FAIL__) throw new Error("路径不存在。")
            window.__HISTORY_OPENED__.push(args.path)
          }
          return null
        },
      }
    })
    await page.getByRole("button", { name: "刷新", exact: true }).click()
    const root = page.getByRole("article", {
      name: "顶层归档.zip",
      exact: true,
    })
    const nested = page.getByRole("list", {
      name: "顶层归档.zip的嵌套压缩包",
      exact: true,
    })
    const child = nested.getByRole("article", {
      name: "嵌套归档.zip",
      exact: true,
    })
    const toggle = page.getByRole("button", {
      name: "嵌套压缩包 · 1",
      exact: true,
    })
    await expect(toggle).toHaveAttribute("aria-expanded", "false")
    await expect(child).not.toBeVisible()
    await toggle.click()
    await expect(toggle).toHaveAttribute("aria-expanded", "true")
    await expect(child).toBeVisible()
    expect((await child.boundingBox()).y).toBeGreaterThan(
      (await root.boundingBox()).y
    )
    expect((await child.boundingBox()).x).toBeGreaterThan(
      (await root.boundingBox()).x
    )
    await expect(
      page.getByRole("combobox", { name: "每页条数" })
    ).toContainText("100 组/页")
    await root
      .getByRole("button", { name: "打开压缩包所在文件夹", exact: true })
      .click()
    await child
      .getByRole("button", { name: "打开解压目录", exact: true })
      .click()
    expect(await page.evaluate(() => window.__HISTORY_OPENED__)).toEqual([
      "C:\\[测试分组] 中文目录",
      "D:\\输出\\顶层\\嵌套",
    ])
    await child.getByRole("button", { name: "查看密码", exact: true }).click()
    await expect(child.locator("code")).toHaveText("nested-secret")
    await toggle.click()
    await expect(child).not.toBeVisible()
    await toggle.click()
    await expect(child.locator("code")).toHaveText("••••••••")
    await page.evaluate(() => {
      window.__HISTORY_DEFER_REVEAL__ = true
    })
    await child.getByRole("button", { name: "查看密码", exact: true }).click()
    await expect
      .poll(() => page.evaluate(() => typeof window.__HISTORY_REVEAL_RESOLVE__))
      .toBe("function")
    await toggle.click()
    await page.evaluate(() => window.__HISTORY_REVEAL_RESOLVE__("late-secret"))
    await toggle.click()
    await expect(
      child.getByRole("button", { name: "查看密码", exact: true })
    ).toBeEnabled()
    await expect(child.locator("code")).toHaveText("••••••••")
    await page.screenshot({
      path: test.info().outputPath("history-nested.png"),
      animations: "disabled",
    })
    await page.evaluate(() => {
      window.__HISTORY_OPEN_FAIL__ = true
    })
    await root
      .getByRole("button", { name: "打开解压目录", exact: true })
      .click()
    await expect(
      page.locator('[data-sonner-toast][data-type="error"]')
    ).toHaveText("路径不存在。")
  })
}

for (const width of [1280, 900, 390, 320]) {
  test(`长路径默认紧凑展示，展开和复制保留完整内容（${width}px）`, async ({
    page,
    context,
  }) => {
    const errors = []
    page.on("pageerror", (error) => errors.push(error.message))
    await context.grantPermissions(["clipboard-read", "clipboard-write"])
    await page.setViewportSize({ width, height: 844 })
    await page.goto("/")
    await page.getByRole("button", { name: "历史", exact: true }).click()
    await expect(page.getByRole("combobox", { name: "每页条数" })).toBeEnabled()
    const archivePath = `D:\\下载\\[测试分组] 中文目录\\${"归档资料与设计素材 ".repeat(12)}\\加密归档.dll`
    await page.evaluate((archivePath) => {
      window.__TAURI_INTERNALS__ = {
        async invoke(command) {
          if (command === "history_list") {
            return {
              entries: [
                {
                  id: 1,
                  archiveName: "加密归档.dll",
                  archivePath,
                  outputDirectory: archivePath.slice(0, -4),
                  archiveFormat: "RAR5",
                  fileSize: 209 * 1024 * 1024,
                  volumeCount: 1,
                  lastVerifiedAtMs: 1_792_324_800_000,
                  hasPassword: true,
                },
              ],
              totalCount: 1,
              matchedCount: 1,
              passwordCount: 1,
            }
          }
          return null
        },
      }
    }, archivePath)
    await page.getByRole("button", { name: "刷新", exact: true }).click()
    const record = page.getByRole("article").filter({ hasText: "加密归档.dll" })
    const path = record.getByTitle(archivePath, { exact: true })
    await expect(path).toBeVisible()
    await expect
      .poll(() => path.evaluate((el) => el.scrollWidth > el.clientWidth))
      .toBe(true)
    const collapsed = await record.boundingBox()
    expect(collapsed.height).toBeLessThan(340)
    await page.screenshot({
      path: test.info().outputPath("history-long-paths.png"),
      animations: "disabled",
    })
    const toggle = record.getByRole("button", { name: /^(展开|收起)路径$/ })
    await toggle.focus()
    await toggle.press("Enter")
    await expect(toggle).toHaveAttribute("aria-expanded", "true")
    await expect
      .poll(() => path.evaluate((el) => el.scrollWidth <= el.clientWidth))
      .toBe(true)
    expect((await record.boundingBox()).height).toBeGreaterThan(
      collapsed.height
    )
    await record
      .getByRole("button", { name: "复制压缩包路径", exact: true })
      .click()
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(archivePath)
    await record.getByRole("button", { name: "收起路径", exact: true }).click()
    await expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect((await record.boundingBox()).height).toBe(collapsed.height)
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <= innerWidth &&
          document.documentElement.scrollHeight <= innerHeight
      )
    ).toBe(true)
    expect(errors).toEqual([])
  })
}

test("历史列表局部滚动，搜索和分页固定且没有表格", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 480 })
  await page.goto("/")
  await page.getByRole("button", { name: "历史", exact: true }).click()
  await expect(page.getByRole("article")).toHaveCount(3)
  await expect(page.getByRole("table")).toHaveCount(0)
  const area = page.locator('[data-slot="history-scroll-area"]')
  const viewport = area.locator('[data-slot="scroll-area-viewport"]')
  const search = page.getByRole("searchbox", { name: "搜索压缩包名称或路径" })
  const pagination = page.getByRole("navigation", { name: "历史分页" })
  const beforeSearch = await search.boundingBox()
  const beforePagination = await pagination.boundingBox()
  expect(
    await viewport.evaluate((el) => el.scrollHeight > el.clientHeight)
  ).toBe(true)
  await viewport.evaluate((el) => {
    el.scrollTop = 120
  })
  expect(await viewport.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  expect((await search.boundingBox()).y).toBe(beforeSearch.y)
  expect((await pagination.boundingBox()).y).toBe(beforePagination.y)
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <= innerWidth &&
        document.documentElement.scrollHeight <= innerHeight
    )
  ).toBe(true)
  await page.screenshot({
    path: test.info().outputPath("history-scrolled.png"),
    animations: "disabled",
  })
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
    const records = page.getByRole("article")
    await expect(
      records.getByText("项目设计素材.7z", { exact: true })
    ).toBeVisible()
    await expect(records.getByText("—", { exact: true })).toHaveCount(3)
    await expect(page.getByRole("table")).toHaveCount(0)
    const first = await records.nth(0).boundingBox()
    const second = await records.nth(1).boundingBox()
    expect(second.y).toBeGreaterThan(first.y)
    expect(second.x).toBe(first.x)
    expect(second.width).toBe(first.width)
    await page.screenshot({
      path: test.info().outputPath("history-list.png"),
      animations: "disabled",
    })
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
        name: "查看密码",
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
        name: "复制密码",
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
        name: "复制密码",
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
    const deleteButton = page.getByRole("button", {
      name: "删除 项目设计素材.7z 的记录",
      exact: true,
    })
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
    await expect(size).toContainText("100 组/页")
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
      page.getByText("第 2 / 3 页 · 共 3 组", { exact: true })
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
    await page.getByRole("option", { name: "1000 组/页", exact: true }).click()
    await expect(size).toContainText("1000 组/页")
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
