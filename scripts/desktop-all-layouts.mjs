import assert from "node:assert/strict"
import { expect } from "@playwright/test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"

export async function verifyAllPageLayouts({ page, invoke, evidence, stress }) {
  page.setDefaultTimeout(10000)
  const cdp = await page.context().newCDPSession(page)
  const records = []
  if (stress) {
    await page
      .getByRole("navigation")
      .getByRole("button", { name: "压缩", exact: true })
      .click()
    await page
      .getByTestId("compress-source-scroll")
      .waitFor({ state: "attached", timeout: 500 })
      .catch(() => {})
    await invoke("plugin:event|emit_to", {
      target: { kind: "Webview", label: "main" },
      event: "tauri://drag-drop",
      payload: { paths: stress.sources, position: { x: 0, y: 0 } },
    })
    await page.getByTestId("compress-source-scroll").waitFor()
    await expect(page.locator(".byte-packing-list > li")).toHaveCount(
      stress.sources.length
    )
    await page.locator("#archive-name").fill(stress.longName)
  }
  const smallOnly = process.env.ARC_RECALL_LAYOUT_FOCUS === "small"
  let context
  let activePage = "extract"
  const nav = async (name) => {
    await page
      .getByRole("navigation")
      .getByRole("button", { name, exact: true })
      .click()
    activePage = {
      解压: "extract",
      压缩: "compress",
      字典: "dictionary",
      历史: "history",
      日志: "logs",
      设置: "settings",
    }[name]
  }
  const button = (name) => page.getByRole("button", { name, exact: true })
  const inspect = async (name, required = []) => {
    await page.waitForTimeout(300)
    const record = await page.evaluate(
      ({ required, activePage }) => {
        const shown = (el) => el.checkVisibility({ visibilityProperty: true })
        const dialog = [...document.querySelectorAll('[role="dialog"]')].find(
          shown
        )
        const content =
          dialog ??
          [...document.querySelectorAll('[role="listbox"]')].find(shown) ??
          [
            ...document.querySelectorAll(
              `[data-workbench="${activePage}"] [data-slot="workbench-page-content"]`
            ),
          ].find(shown)
        const label = (el) => {
          const clone = el.cloneNode(true)
          clone
            .querySelectorAll("svg,[aria-hidden=true]")
            .forEach((n) => n.remove())
          return el.getAttribute("aria-label") ?? clone.textContent.trim()
        }
        const all = [...content.querySelectorAll("button")].filter(shown)
        const footerButtons = dialog
          ? [...dialog.querySelectorAll('[data-slot$="footer"] button')].filter(
              shown
            )
          : []
        const targets = [
          ...new Set([
            ...all.filter((el) => required.includes(label(el))),
            ...footerButtons,
            ...(!dialog
              ? [...content.querySelectorAll(".byte-ai-actions button")].filter(
                  shown
                )
              : []),
            ...(!dialog && activePage === "compress"
              ? [
                  ...content.querySelectorAll(
                    ".byte-packing-list > li:first-child button"
                  ),
                ].filter(shown)
              : []),
            ...(dialog ? all.filter((el) => label(el) === "关闭") : []),
          ]),
        ]
        const controls = targets.map((el) => {
          const r = el.getBoundingClientRect(),
            hit = document.elementFromPoint(
              r.x + r.width / 2,
              r.y + r.height / 2
            )
          let unclipped = true
          for (
            let parent = el.parentElement;
            parent;
            parent = parent.parentElement
          ) {
            const style = getComputedStyle(parent)
            const bounds = parent.getBoundingClientRect()
            if (
              /auto|scroll|hidden|clip/.test(style.overflowY) &&
              (r.top < bounds.top - 1 || r.bottom > bounds.bottom + 1)
            )
              unclipped = false
            if (
              /auto|scroll|hidden|clip/.test(style.overflowX) &&
              (r.left < bounds.left - 1 || r.right > bounds.right + 1)
            )
              unclipped = false
          }
          return {
            name: label(el),
            rect: [r.x, r.y, r.width, r.height],
            visible:
              unclipped &&
              r.top >= 0 &&
              r.bottom <= innerHeight + 1 &&
              r.left >= 0 &&
              r.right <= innerWidth + 1 &&
              (el.disabled || (!!hit && el.contains(hit))),
          }
        })
        return {
          viewport: [innerWidth, innerHeight],
          overflow: content.scrollHeight - content.clientHeight,
          scrollRegions: [content, ...content.querySelectorAll("*")]
            .filter(shown)
            .filter(
              (el) =>
                /auto|scroll/.test(getComputedStyle(el).overflowY) &&
                el.scrollHeight > el.clientHeight + 1
            )
            .map((el) => ({
              slot: el.dataset.slot ?? el.className,
              overflow: el.scrollHeight - el.clientHeight,
            })),
          horizontal: Math.max(
            document.documentElement.scrollWidth - innerWidth,
            content.scrollWidth - content.clientWidth
          ),
          innerHorizontal: [
            ...content.querySelectorAll(
              '.workbench-details-body,[data-slot="scroll-area-viewport"],.byte-ai-panel [data-slot="card-content"]'
            ),
          ]
            .filter(shown)
            .map((el) => ({
              slot: el.dataset.slot ?? el.className,
              overflow: el.scrollWidth - el.clientWidth,
            }))
            .filter((item) => item.overflow > 1),
          controls,
          missing: required.filter(
            (name) => !controls.some((c) => c.name === name)
          ),
          dialog: Boolean(dialog),
        }
      },
      { required, activePage }
    )
    const item = { ...context, name, ...record }
    records.push(item)
    if (
      item.horizontal > 1 ||
      item.innerHorizontal.length ||
      item.missing.length ||
      item.controls.some((c) => !c.visible)
    )
      console.log("FAIL " + JSON.stringify(item))
    const shot = await cdp.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    })
    await writeFile(
      join(
        evidence,
        `all-${context.theme}-${context.width}-${context.zoom}-${name}.png`
      ),
      Buffer.from(shot.data, "base64")
    )
  }
  const drawer = async (name, trigger, required = [], tabs = []) => {
    await button(trigger).first().click()
    if (stress && name === "add-password") {
      await page.locator("#dict-single").fill(stress.longText)
      await page.locator("#dict-paste").fill(stress.multiline)
    }
    await inspect(name, required)
    for (const tab of tabs) {
      await page
        .getByRole("dialog")
        .getByRole("tab", { name: tab, exact: true })
        .click()
      await inspect(`${name}-${tab.replaceAll(" / ", "-")}`)
    }
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "关闭", exact: true })
      .click()
  }
  for (const theme of ["dark", "light"]) {
    await invoke("plugin:webview|set_webview_zoom", { label: "main", value: 1 })
    if (await button(theme === "dark" ? "切换到深色" : "切换到浅色").count())
      await button(theme === "dark" ? "切换到深色" : "切换到浅色").click()
    for (const [width, height] of smallOnly
      ? [[960, 640]]
      : [
          [1280, 800],
          [960, 640],
        ]) {
      await invoke("plugin:window|set_size", {
        label: "main",
        value: { Logical: { width, height } },
      })
      for (const zoom of smallOnly ? [1.5] : [1, 1.25, 1.5]) {
        context = { theme, width, height, zoom }
        await invoke("plugin:webview|set_webview_zoom", {
          label: "main",
          value: zoom,
        })
        await nav("解压")
        await inspect("extract", [
          "继续扫描剩余目录",
          "打开解压文件夹",
          "打开解压选项",
        ])
        await drawer("extract-options", "打开解压选项")
        await drawer("process", /^详细过程/, [], [])
        await nav("压缩")
        await inspect("compress", ["开始压缩", "添加文件", "添加文件夹"])
        await drawer("compression-ai", "AI 命名 · 未开启")
        await nav("字典")
        await expect(button("添加密码")).toBeEnabled()
        await inspect("dictionary", ["添加密码", "下一页", "上一页"])
        if (stress) {
          if (await button("首页").isEnabled()) await button("首页").click()
          await expect(button("下一页")).toBeEnabled()
          await button("下一页").click()
          await expect(button("添加密码")).toBeEnabled()
          await inspect("dictionary-next", ["添加密码", "上一页", "下一页"])
          await button("首页").click()
          await expect(button("添加密码")).toBeEnabled()
        }
        await drawer("add-password", "添加密码", ["添加多行"])
        await nav("历史")
        await inspect("history", [
          "刷新",
          "历史工具",
          "搜索",
          "上一页",
          "下一页",
        ])
        await drawer("history-details", "记录详情")
        await nav("日志")
        await inspect("logs", ["立即刷新日志"])
        await drawer("log-diagnostics", "日志诊断")
        await nav("设置")
        for (const category of ["AI 模型", "解密引擎", "应用", "数据"]) {
          await page.getByRole("tab", { name: category, exact: true }).click()
          await page.waitForTimeout(150)
          if (category === "AI 模型") {
            await inspect("ai", ["保存配置", "重命名提示词"])
            const selector = page.getByRole("combobox", {
              name: "已保存 AI 配置",
              exact: true,
            })
            if (stress && (await selector.isVisible())) {
              await selector.click()
              await inspect("ai-profiles-menu")
              await page.getByRole("option").first().click()
              await inspect("ai-profile-selected", [
                "保存配置",
                "重命名提示词",
                "设为当前",
              ])
            }
            await drawer("prompt", "重命名提示词", ["保存提示词"])
          }
          if (category === "解密引擎") {
            await inspect("engine", ["引擎管理", "解压行为"])
            await drawer("recovery-settings", "解压行为", ["保存上限"])
            await drawer(
              "engines",
              "引擎管理",
              [],
              ["工具目录", "John / Perl", "Hashcat", "完整引擎包"]
            )
          }
          if (category === "应用") {
            await inspect("app", ["保存"])
            await drawer("app-update", "应用更新")
          }
          if (category === "数据") {
            await inspect("data", ["创建备份", "从备份恢复"])
            await drawer("locations", "文件位置")
          }
        }
        console.log("DONE " + JSON.stringify(context))
      }
    }
  }
  await writeFile(
    join(
      evidence,
      smallOnly ? "all-layout-small-results.json" : "all-layout-results.json"
    ),
    JSON.stringify(records, null, 2)
  )
  assert.ok(
    records.every(
      (r) =>
        r.horizontal <= 1 &&
        !r.innerHorizontal.length &&
        !r.missing.length &&
        r.controls.every((c) => c.visible)
    ),
    "Layout failures; see all-layout-results.json"
  )
}
