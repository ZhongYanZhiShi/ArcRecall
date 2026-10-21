import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { expect } from "@playwright/test"

export async function verifyKeyboardFocus({ page, invoke, evidence }) {
  page.setDefaultTimeout(10000)
  const cdp = await page.context().newCDPSession(page)
  const records = []
  let context
  const button = (name) => page.getByRole("button", { name, exact: true })
  const nav = (name) =>
    page
      .getByRole("navigation")
      .getByRole("button", { name, exact: true })
      .click()
  const inspect = async () => {
    await page.waitForTimeout(200)
    const state = await page.evaluate(() => {
      const el = document.activeElement
      const s = getComputedStyle(el),
        r = el.getBoundingClientRect()
      let clipped =
        r.x < -1 ||
        r.y < -1 ||
        r.right > innerWidth + 1 ||
        r.bottom > innerHeight + 1
      for (
        let parent = el.parentElement;
        parent;
        parent = parent.parentElement
      ) {
        const ps = getComputedStyle(parent),
          pr = parent.getBoundingClientRect()
        if (
          /auto|scroll|hidden|clip/.test(ps.overflowY) &&
          (r.y < pr.y - 1 || r.bottom > pr.bottom + 1)
        )
          clipped = true
      }
      const hit = document.elementFromPoint(
        r.x + r.width / 2,
        r.y + r.height / 2
      )
      return {
        tag: el.tagName,
        name:
          el.getAttribute("aria-label") ||
          el.textContent?.trim().slice(0, 60) ||
          el.id,
        visible: el.matches(":focus-visible"),
        outline: s.outlineWidth,
        offset: s.outlineOffset,
        color: s.outlineColor,
        background: s.backgroundColor,
        slot: el.getAttribute("data-slot"),
        variant: el.getAttribute("data-variant"),
        clipped,
        hit: hit?.outerHTML.slice(0, 200),
        covered: !hit || !(el === hit || el.contains(hit)),
      }
    })
    if (state.covered || state.clipped) await shot("focus-obstruction")
    assert.ok(
      state.visible &&
        parseFloat(state.outline) >= 1.5 &&
        parseFloat(state.outline) <= 2.1 &&
        parseFloat(state.offset) <= -2.5 &&
        !state.clipped &&
        !state.covered,
      JSON.stringify({ context, state })
    )
    assert.notEqual(
      state.color,
      state.background,
      "Focus must contrast with control background"
    )
    records.push({ ...context, kind: "focus", ...state })
  }
  const tabTo = async (locator) => {
    await locator.waitFor({ state: "visible" })
    for (let i = 0; i < 90; i++) {
      await page.keyboard.press("Tab")
      if (await locator.evaluate((el) => el === document.activeElement)) {
        await inspect()
        return
      }
    }
    throw new Error("Tab could not reach target: " + locator)
  }
  const shot = async (name) => {
    await page.waitForTimeout(250)
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
        await nav("字典")
        await tabTo(button("添加密码"))
        await shot("page-button")
        await page.keyboard.press("Enter")
        await expect(page.getByRole("dialog")).toBeVisible()
        await tabTo(page.locator("#dict-single"))
        await shot("input")
        await page.keyboard.type(`focus-${theme}-${width}-${zoom}`)
        await page.keyboard.press("Enter")
        await expect(page.locator("#dict-single")).toHaveValue("")
        await expect(
          page.getByRole("dialog").getByRole("status")
        ).toContainText("单条新增完成")
        await tabTo(page.locator("#dict-paste"))
        await shot("textarea")
        for (let i = 0; i < 6; i++) {
          await page.keyboard.press("Tab")
          await expect(page.getByRole("dialog")).toContainText("添加密码")
          await expect
            .poll(() =>
              page.evaluate(
                () => !!document.activeElement.closest('[role="dialog"]')
              )
            )
            .toBe(true)
          await inspect()
        }
        await page.keyboard.press("Escape")
        await expect(page.getByRole("dialog")).toBeHidden()
        await expect(button("添加密码")).toBeFocused()
        await nav("设置")
        await page.getByRole("tab", { name: "解密引擎", exact: true }).click()
        await tabTo(button("解压行为"))
        await page.keyboard.press("Enter")
        const limit = page.getByRole("spinbutton", {
          name: "目录扫描文件数上限",
          exact: true,
        })
        await tabTo(limit)
        await page.keyboard.press("Control+A")
        await page.keyboard.type("12")
        await tabTo(button("保存上限"))
        await shot("save-button")
        await page.keyboard.press("Enter")
        await expect(page.locator("[data-sonner-toast]").last()).toContainText(
          "已保存扫描上限：12"
        )
        await page.keyboard.press("Escape")
        await expect(page.getByRole("dialog")).toBeHidden()
        await expect(button("解压行为")).toBeFocused()
        records.push({
          ...context,
          kind: "keyboard-actions",
          enterAdd: true,
          enterSave: true,
          escapeRestore: true,
          trapped: true,
        })
        await writeFile(
          join(evidence, "results.json"),
          JSON.stringify(records, null, 2)
        )
        console.log("DONE " + JSON.stringify(context))
      }
    }
  }
}
