// Real Windows WebView2 + helper IPC. Preview mode never runs an installer.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createServer } from "node:net"
import { chromium, expect } from "@playwright/test"

if (process.platform !== "win32")
  throw new Error("Windows and WebView2 required")
const binary = resolve(
  process.env.ARC_RECALL_TEST_BINARY ?? "target/debug/arc-recall-desktop.exe"
)
const evidence = resolve("artifacts/update-helper")
await mkdir(evidence, { recursive: true })
for (const scenario of ["dark", "light", "invalid-package"]) {
  const theme = scenario === "light" ? "light" : "dark"
  const server = createServer().listen(0, "127.0.0.1")
  await once(server, "listening")
  const port = server.address().port
  await new Promise((done) => server.close(done))
  const profile = await mkdtemp(join(tmpdir(), "arcrecall-helper-webview-"))
  let args = ["--update-helper-preview", theme]
  if (scenario === "invalid-package") {
    const session = await mkdtemp(join(tmpdir(), "arcrecall-invalid-update-"))
    await writeFile(join(session, "installer.exe"), "MZinvalid-test-package")
    await writeFile(
      join(session, "request.json"),
      JSON.stringify({
        parent_pid: process.pid,
        application: binary,
        version: "9.0.0",
        theme,
        manifest: {
          version: "9.0.0",
          platforms: {
            "windows-x86_64": {
              url: "https://example.invalid/installer.exe",
              signature: "invalid",
            },
          },
        },
      })
    )
    args = ["--update-helper", session]
  }
  const child = spawn(binary, args, {
    windowsHide: true,
    env: {
      ...process.env,
      WEBVIEW2_USER_DATA_FOLDER: profile,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let output = "",
    browser
  child.stdout.on("data", (chunk) => {
    output += chunk.toString()
  })
  child.stderr.on("data", (chunk) => {
    output += chunk.toString()
  })
  try {
    let ready = false
    for (let attempt = 0; attempt < 180; attempt++) {
      if (child.exitCode !== null) throw new Error(`Helper exited: ${output}`)
      try {
        ready = (await fetch(`http://127.0.0.1:${port}/json/version`)).ok
      } catch {
        /* startup */
      }
      if (ready) break
      await new Promise((done) => setTimeout(done, 250))
    }
    assert(ready, `WebView2 did not start: ${output}`)
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    const context = browser.contexts()[0]
    const page = context.pages()[0] ?? (await context.waitForEvent("page"))
    const errors = []
    page.on("pageerror", (error) => errors.push(error.message))
    if (scenario === "invalid-package") {
      await expect(
        page.getByRole("heading", { name: "更新未完成" })
      ).toBeVisible({ timeout: 15000 })
      await expect(page.getByRole("alert")).toBeVisible()
      await page.evaluate(() =>
        window.__TAURI_INTERNALS__.invoke("helper_start")
      )
      await expect
        .poll(
          async () =>
            (
              await page.evaluate(() =>
                window.__TAURI_INTERNALS__.invoke("helper_status")
              )
            ).phase
        )
        .toBe("failed")
    } else
      await expect(
        page.getByText("界面预览 · 不会执行安装", { exact: true })
      ).toBeVisible({ timeout: 15000 })
    const state = await page.evaluate(() =>
      window.__TAURI_INTERNALS__.invoke("helper_status")
    )
    assert.equal(state.preview, scenario !== "invalid-package")
    assert.equal(
      state.phase,
      scenario === "invalid-package" ? "failed" : "installing"
    )
    assert.equal(state.theme, theme)
    const blocked = await page.evaluate(async () => {
      try {
        await window.__TAURI_INTERNALS__.invoke("settings_get")
        return false
      } catch {
        return true
      }
    })
    assert(blocked, "Helper must not expose normal application commands")
    await page.screenshot({ path: join(evidence, `${scenario}.png`) })
    assert.deepEqual(errors, [])
    const exited = once(child, "exit")
    await page.getByRole("button", { name: "关闭更新窗口" }).click()
    await Promise.race([
      exited,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Helper did not close")), 10000)
      ),
    ])
    console.log(
      `${scenario}: real helper WebView, state, IPC isolation and close passed`
    )
  } finally {
    await browser?.close().catch(() => {})
    if (child.exitCode === null) child.kill()
  }
}
