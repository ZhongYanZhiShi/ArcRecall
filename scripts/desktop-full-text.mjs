import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { writeFile } from "node:fs/promises"
import { join, dirname, basename } from "node:path"
import { expect } from "@playwright/test"

// Read the OS result, rather than intercepting or replacing native operations.
function osRead(script, env = {}) {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new();" + script,
    ],
    { encoding: "utf8", windowsHide: true, env: { ...process.env, ...env } }
  )
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim() || "null")
}
const clipboard = () =>
  osRead("ConvertTo-Json -InputObject (Get-Clipboard -Raw) -Compress")
const explorerPaths = () =>
  osRead(
    "$items=@((New-Object -ComObject Shell.Application).Windows() | ForEach-Object {try { [pscustomobject]@{path=$_.Document.Folder.Self.Path;handle=$_.HWND} } catch {}}); ConvertTo-Json -InputObject $items -Compress"
  ) ?? []
const normalized = (path) =>
  path
    .replace(/^\\\\\?\\/, "")
    .replaceAll("/", "\\")
    .replace(/\\$/, "")
    .toLowerCase()

export async function verifyFullText({ page, invoke, root, evidence, stress }) {
  const records = []
  const cdp = await page.context().newCDPSession(page)
  const button = (name) => page.getByRole("button", { name, exact: true })
  const nav = (name) =>
    page
      .getByRole("navigation")
      .getByRole("button", { name, exact: true })
      .click()
  const history = (
    await invoke("history_list", { query: { skip: 0, take: 100 } })
  ).entries[0]
  const ai = await invoke("ai_profiles_list")
  const profile = ai.profiles.find((p) => p.id === ai.activeProfileId)
  let context
  const shot = async (name) => {
    const result = await cdp.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    })
    await writeFile(
      join(
        evidence,
        `full-${context.theme}-${context.width}-${context.zoom}-${name}.png`
      ),
      Buffer.from(result.data, "base64")
    )
  }
  const hover = async (name, locator, expected) => {
    await locator.hover()
    const tip = page.locator(".full-text-tooltip:visible")
    await expect(tip).toBeVisible()
    await expect(tip).toHaveText(expected)
    await tip.evaluate(async (el) => {
      await Promise.all(
        el
          .getAnimations()
          .map((animation) => animation.finished.catch(() => {}))
      )
    })
    const rect = await tip.evaluate((el) => {
      const r = el.getBoundingClientRect()
      return {
        x: r.x,
        y: r.y,
        right: r.right,
        bottom: r.bottom,
        width: innerWidth,
        height: innerHeight,
        overflowX: el.scrollWidth - el.clientWidth,
        overflowY: el.scrollHeight - el.clientHeight,
      }
    })
    assert.ok(
      rect.x >= 0 &&
        rect.y >= 0 &&
        rect.right <= rect.width + 1 &&
        rect.bottom <= rect.height + 1 &&
        rect.overflowX <= 1 &&
        rect.overflowY <= 1,
      JSON.stringify({ name, rect })
    )
    await shot(name)
    records.push({ ...context, name, kind: "hover", complete: true, rect })
    await page.mouse.move(3, 3)

    await expect(tip).toBeHidden()
  }
  const full = (value) =>
    page.locator("[data-full-text]:visible").filter({ hasText: value }).first()
  const copy = async (name, locator, value) => {
    await invoke("plugin:window|set_focus", { label: "main" })
    await locator.click()
    await expect.poll(clipboard).toBe(value)
    records.push({
      ...context,
      name,
      kind: "clipboard",
      complete: true,
      length: value.length,
    })
  }
  const open = async (name, locator, path) => {
    await locator.click()
    await expect
      .poll(
        () =>
          explorerPaths().some(
            (item) => normalized(item.path ?? "") === normalized(path)
          ),
        { timeout: 12000, intervals: [300, 500, 1000] }
      )
      .toBe(true)
    records.push({ ...context, name, kind: "explorer", complete: true, path })
    await invoke("plugin:window|set_focus", { label: "main" })
  }
  await nav("压缩")
  await expect
    .poll(async () => {
      await invoke("plugin:event|emit_to", {
        target: { kind: "Webview", label: "main" },
        event: "tauri://drag-drop",
        payload: { paths: stress.sources, position: { x: 0, y: 0 } },
      })
      return page.locator(".byte-packing-list > li").count()
    })
    .toBe(stress.sources.length)
  await page.locator("#archive-name").fill(stress.longName)
  for (const theme of ["dark", "light"]) {
    await invoke("plugin:webview|set_webview_zoom", { label: "main", value: 1 })
    if (await button(theme === "dark" ? "切换到深色" : "切换到浅色").count())
      await button(theme === "dark" ? "切换到深色" : "切换到浅色").click()
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
        await nav("解压")
        await hover(
          "archive-path",
          full(history.archivePath),
          history.archivePath
        )
        await nav("压缩")
        await hover(
          "source-name",
          full(basename(stress.sources[0])),
          basename(stress.sources[0])
        )
        await hover("source-path", full(stress.sources[0]), stress.sources[0])
        await hover(
          "result-name",
          full(stress.longName + ".7z"),
          stress.longName + ".7z"
        )
        await button("AI 命名 · 未开启").click()
        await hover(
          "profile-summary",
          full(profile.name + " · " + profile.model),
          profile.name + " · " + profile.model
        )
        await button("关闭").click()
        await nav("历史")
        await hover(
          "history-name",
          page
            .locator('[data-workbench="history"] [data-full-text]:visible')
            .first(),
          history.archiveName
        )
        await button("记录详情").first().click()
        await copy(
          "archive-copy",
          button("复制压缩包路径"),
          history.archivePath
        )
        await copy(
          "output-copy",
          button("复制解压到路径"),
          history.outputDirectory
        )
        await open(
          "archive-open",
          button("打开压缩包所在文件夹"),
          dirname(history.archivePath)
        )
        await open(
          "output-open",
          page
            .getByRole("dialog")
            .getByRole("button", { name: "打开解压目录", exact: true }),
          history.outputDirectory
        )
        await button("关闭").click()
        await nav("设置")
        await page.getByRole("tab", { name: "AI 模型", exact: true }).click()
        const selector = page.getByRole("combobox", {
          name: "已保存 AI 配置",
          exact: true,
        })
        const nameLabel = (await selector.isVisible())
          ? selector.locator("[data-full-text]")
          : full(profile.name)
        await hover("profile-name", nameLabel, profile.name)
        const nameInput = page.locator("#ai-profile-name")
        await nameInput.click()
        await nameInput.press("Control+A")
        await nameInput.press("Control+C")
        await expect.poll(clipboard).toBe(profile.name)
        records.push({
          ...context,
          name: "profile-copy",
          kind: "clipboard",
          complete: true,
          length: profile.name.length,
        })
        console.log("DONE " + JSON.stringify(context))
      }
    }
  }
  await writeFile(
    join(evidence, "full-text-results.json"),
    JSON.stringify(records, null, 2)
  )
  await writeFile(
    join(evidence, "explorer-targets.json"),
    JSON.stringify(
      { root, paths: [dirname(history.archivePath), history.outputDirectory] },
      null,
      2
    )
  )
}
