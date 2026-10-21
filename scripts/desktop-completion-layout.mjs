// Build the isolated native-e2e binary with scripts/tauri-layout-test.conf.json
// after the frontend build, then run desktop-smoke.mjs --completion-layout-only.
// Window resizing/zoom permissions belong only to this test build.
import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { expect } from "@playwright/test"

export async function verifyCompletionLayout({
  page,
  invoke,
  root,
  evidence,
  sevenZip,
  stress,
}) {
  const source = join(root, "待扫描目录")
  for (let i = 0; i < 21; i++) {
    const folder = join(source, `测试目录${i}`)
    await mkdir(folder, { recursive: true })
    for (let j = 0; j < 3; j++)
      await writeFile(join(folder, `内容${j}.txt`), "窗口布局验证")
  }
  const archive = join(
    stress?.folder ?? root,
    stress ? `${stress.longName}-待补扫归档.7z` : "多目录归档.7z"
  )
  assert.equal(
    spawnSync(sevenZip, ["a", "-t7z", "-pfixture-layout", archive, source], {
      windowsHide: true,
      stdio: "ignore",
    }).status,
    0
  )
  await invoke("settings_update", {
    update: { kind: "scanMaxFilesPerDirectory", value: 1 },
  })
  const task = await invoke("recovery_start", {
    request: {
      archivePath: archive,
      outputDirectory: join(root, "解压结果"),
      knownPassword: "fixture-layout",
      recursive: true,
      computeMode: "cpuOnly",
    },
  })
  await expect
    .poll(
      async () =>
        (await invoke("recovery_status", { taskId: task.taskId })).completed,
      { timeout: 30000 }
    )
    .toBe(true)
  const result = await invoke("recovery_status", { taskId: task.taskId })
  assert.equal(result.success, true)
  assert.ok(result.skippedScanDirectories.length > 0)
  await page.reload()
  await expect(
    page.getByRole("button", { name: "继续扫描剩余目录", exact: true })
  ).toBeVisible()
  const records = []
  const cdp = await page.context().newCDPSession(page)
  for (const theme of ["dark", "light"]) {
    if (theme === "light")
      await page
        .getByRole("button", { name: "切换到浅色", exact: true })
        .click()
    for (const [width, height] of [
      [1280, 800],
      [960, 640],
    ]) {
      await invoke("plugin:window|set_size", {
        label: "main",
        value: { Logical: { width, height } },
      })
      for (const zoom of [1, 1.25, 1.5]) {
        await invoke("plugin:webview|set_webview_zoom", {
          label: "main",
          value: zoom,
        })
        await page.waitForTimeout(250)
        const measurement = await page.evaluate(() => {
          const content = document.querySelector(
            '[data-workbench="extract"] [data-slot="workbench-page-content"]'
          )
          content.scrollTop = 0
          const clip = content.getBoundingClientRect()
          const names = ["继续扫描剩余目录", "打开解压文件夹", "打开解压选项"]
          const buttons = names.map((name) => {
            const el = [...content.querySelectorAll("button")].find(
              (el) =>
                el.getAttribute("aria-label") === name ||
                el.textContent.trim() === name
            )
            const rect = el.getBoundingClientRect()
            const hit = document.elementFromPoint(
              rect.x + rect.width / 2,
              rect.y + rect.height / 2
            )
            return {
              name,
              visible:
                rect.top >= clip.top &&
                rect.bottom <= clip.bottom &&
                rect.left >= 0 &&
                rect.right <= innerWidth &&
                Boolean(hit && el.contains(hit)),
              top: rect.top,
              bottom: rect.bottom,
            }
          })
          return {
            width: innerWidth,
            height: innerHeight,
            dpr: devicePixelRatio,
            overflow: content.scrollHeight - content.clientHeight,
            buttons,
          }
        })
        records.push({ theme, window: [width, height], zoom, ...measurement })
        const screenshot = await cdp.send("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: false,
        })
        await writeFile(
          join(evidence, `native-${theme}-${width}-${zoom}.png`),
          Buffer.from(screenshot.data, "base64")
        )
        console.log(JSON.stringify(records.at(-1)))
      }
    }
  }
  await writeFile(
    join(evidence, "layout-results.json"),
    JSON.stringify(
      {
        taskId: task.taskId,
        skippedDirectories: result.skippedScanDirectories.length,
        records,
      },
      null,
      2
    )
  )
  assert.ok(
    records.every((r) => r.overflow <= 1 && r.buttons.every((b) => b.visible)),
    "Completion layout overflow or obscured action; see layout-results.json"
  )
}
