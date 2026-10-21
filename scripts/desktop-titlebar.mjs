import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { expect } from "@playwright/test"

export async function verifyTitlebar({ page, invoke, evidence, child }) {
  const button = (name) => page.getByRole("button", { name, exact: true })
  assert.equal(await invoke("plugin:window|is_decorated"), false)
  await expect(page.getByLabel("窗口标题栏", { exact: true })).toBeVisible()
  for (const theme of ["dark", "light"]) {
    await page.evaluate((theme) => {
      document.documentElement.classList.toggle("dark", theme === "dark")
      document.documentElement.classList.toggle("light", theme === "light")
    }, theme)
    await page.screenshot({ path: join(evidence, `titlebar-${theme}.png`) })
  }
  await button("最大化窗口").click()
  await expect.poll(() => invoke("plugin:window|is_maximized")).toBe(true)
  await button("还原窗口").click()
  await expect.poll(() => invoke("plugin:window|is_maximized")).toBe(false)
  await page.locator("[data-tauri-drag-region]").dblclick()
  await expect.poll(() => invoke("plugin:window|is_maximized")).toBe(true)
  await page.locator("[data-tauri-drag-region]").dblclick()
  await expect.poll(() => invoke("plugin:window|is_maximized")).toBe(false)
  // Capture the real HWND before minimizing; MainWindowHandle may then return zero.
  const handle = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `[Diagnostics.Process]::GetProcessById(${child.pid}).MainWindowHandle.ToInt64()`,
    ],
    { windowsHide: true, encoding: "utf8" }
  )
  assert.equal(handle.status, 0, handle.stderr)
  const hwnd = handle.stdout.trim()
  assert.match(hwnd, /^[1-9][0-9]*$/)
  await button("最小化窗口").click()
  await expect.poll(() => invoke("plugin:window|is_minimized")).toBe(true)
  const restored = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class TitlebarWindow { [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n); }'; [TitlebarWindow]::ShowWindow([IntPtr]${hwnd}, 9)`,
    ],
    { windowsHide: true, encoding: "utf8" }
  )
  assert.equal(restored.status, 0, restored.stderr)
  await expect.poll(() => invoke("plugin:window|is_minimized")).toBe(false)
  await button("关闭窗口").click()
  await expect.poll(() => child.exitCode, { timeout: 10000 }).not.toBeNull()
  assert.equal(child.exitCode, 0)
  console.log(
    "PASS: native custom titlebar, themes, maximize/restore, double-click, minimize, graceful close"
  )
}
