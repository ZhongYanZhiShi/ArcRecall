import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { expect } from "@playwright/test"

export async function verifyScrollbars({ page, invoke, root, evidence }) {
  page.setDefaultTimeout(10000)
  const cdp = await page.context().newCDPSession(page)
  const records = []
  let context
  const nav = (name) =>
    page
      .getByRole("navigation")
      .getByRole("button", { name, exact: true })
      .click()
  const button = (name) => page.getByRole("button", { name, exact: true })
  const shot = async (name) => {
    const result = await cdp.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    })
    await writeFile(
      join(
        evidence,
        `${context.theme}-${context.width}-${context.zoom}-${name}.png`
      ),
      Buffer.from(result.data, "base64")
    )
  }
  const sources = []
  for (let i = 0; i < 40; i++) {
    const path = join(root, `滚动验证文件-${i}.txt`)
    await writeFile(path, `测试内容 ${i}`)
    sources.push(path)
  }
  await nav("压缩")
  await expect
    .poll(async () => {
      await invoke("plugin:event|emit_to", {
        target: { kind: "Webview", label: "main" },
        event: "tauri://drag-drop",
        payload: { paths: sources, position: { x: 0, y: 0 } },
      })
      return page.locator(".byte-packing-list > li").count()
    })
    .toBe(sources.length)
  const exercise = async (name, target, custom) => {
    await page.waitForTimeout(200)
    const metrics = await target.evaluate((el) => ({
      client: el.clientHeight,
      scroll: el.scrollHeight,
      width: el.clientWidth,
      scrollWidth: el.scrollWidth,
      nativeWidth: getComputedStyle(el, "::-webkit-scrollbar").width,
      nativeDisplay: getComputedStyle(el, "::-webkit-scrollbar").display,
      scrollbarWidth: getComputedStyle(el).scrollbarWidth,
    }))
    assert.ok(
      metrics.scrollWidth <= metrics.width + 1,
      `${name}: horizontal overflow`
    )
    const row = { ...context, name, metrics }
    if (custom)
      assert.ok(
        metrics.scrollbarWidth === "none" || metrics.nativeDisplay === "none",
        `${name}: duplicate native scrollbar`
      )
    if (metrics.scroll <= metrics.client + 1) {
      row.notNeeded = true
      records.push(row)
      return
    }
    await target.evaluate((el) => {
      el.scrollTop = 0
    })
    const rect = await target.boundingBox()
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2)
    await page.waitForTimeout(150)
    await page.mouse.wheel(0, 180)
    await expect
      .poll(() => target.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0)
    row.wheel = await target.evaluate((el) => el.scrollTop)
    await target.evaluate((el) => {
      el.scrollTop = 0
    })
    await page.waitForTimeout(150)
    let x, y
    if (custom) {
      const thumb = custom.locator('[data-slot="scroll-area-thumb"]')
      await expect(thumb).toBeVisible()
      const box = await thumb.boundingBox()
      x = box.x + box.width / 2
      y = box.y + box.height / 2
      row.normal = await thumb.evaluate(
        (el) => getComputedStyle(el).backgroundColor
      )
      await page.mouse.move(x, y)
      await page.waitForTimeout(200)
      row.hover = await thumb.evaluate(
        (el) => getComputedStyle(el).backgroundColor
      )
      assert.notEqual(row.normal, row.hover, `${name}: missing hover feedback`)
    } else {
      x = rect.x + rect.width - 5
      y =
        rect.y +
        Math.max(8, (metrics.client * metrics.client) / metrics.scroll / 2)
      await page.mouse.move(x, y)
    }
    await shot(`${name}-hover`)
    await page.mouse.down()
    await page.mouse.move(
      x,
      Math.min(rect.y + rect.height - 8, y + rect.height * 0.35),
      { steps: 12 }
    )
    await page.mouse.up()
    await expect
      .poll(() => target.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0)
    row.drag = await target.evaluate((el) => el.scrollTop)
    assert.equal(
      await page.evaluate(() => document.scrollingElement.scrollTop),
      0,
      `${name}: outer page scrolled`
    )
    records.push(row)
    await shot(`${name}-drag`)
  }
  for (const theme of ["dark", "light"]) {
    await invoke("plugin:webview|set_webview_zoom", { label: "main", value: 1 })
    const toggle = button(theme === "dark" ? "切换到深色" : "切换到浅色")
    if (await toggle.count()) await toggle.click()
    for (const [width, height] of [
      [1280, 800],
      [960, 640],
    ]) {
      await invoke("plugin:window|set_size", {
        label: "main",
        value: { Logical: { width, height } },
      })
      for (const zoom of [1, 1.25, 1.5]) {
        context = { theme, width, height, zoom }
        await invoke("plugin:webview|set_webview_zoom", {
          label: "main",
          value: zoom,
        })
        await invoke("plugin:window|set_focus", { label: "main" })
        await nav("压缩")
        const area = page.getByTestId("compress-source-scroll")
        await exercise(
          "page",
          area.locator('[data-slot="scroll-area-viewport"]'),
          area
        )
        await expect(button("开始压缩")).toBeInViewport({ ratio: 1 })
        await nav("字典")
        await button("添加密码").click()
        const textarea = page.locator("#dict-paste")
        await textarea.fill(
          Array.from(
            { length: 100 },
            (_, i) => `第 ${i + 1} 行 · 多行滚动验证`
          ).join("\n")
        )
        await textarea.evaluate((el) => el.blur())
        await exercise("drawer", page.locator(".dictionary-add-body"))
        await textarea.scrollIntoViewIfNeeded()
        await exercise("textarea", textarea)
        await expect(button("添加多行")).toBeInViewport({ ratio: 1 })
        await textarea.fill("")
        await button("关闭").click()
        await nav("设置")
        await page.getByRole("tab", { name: "解密引擎", exact: true }).click()
        await button("解压行为").click()
        await exercise(
          "settings-drawer",
          page.getByRole("dialog").locator(".workbench-details-body")
        )
        await expect(button("保存上限")).toBeInViewport({ ratio: 1 })
        await button("关闭").click()
        console.log("DONE " + JSON.stringify(context))
        await writeFile(
          join(evidence, "results.json"),
          JSON.stringify(records, null, 2)
        )
      }
    }
  }
}
