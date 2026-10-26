import { test, expect } from "@playwright/test"

async function setup(page, overrides = {}) {
  await page.addInitScript((overrides) => {
    const state = (window.updateTest = {
      status: {
        currentVersion: "1.0.0",
        version: "2.0.0",
        configured: true,
        autoUpdate: true,
        phase: "ready",
        notes: "改进归档处理\n修复路径兼容问题",
        downloadedBytes: 1024,
        totalBytes: 1024,
        lastChecked: null,
        error: null,
        installBlocked: false,
        cached: true,
        cacheWarning: null,
        ...overrides,
      },
      calls: [],
      failDownload: false,
      failCheck: false,
    })
    const installedVersion = localStorage.getItem("test-current-version")
    if (installedVersion) {
      Object.assign(state.status, {
        currentVersion: installedVersion,
        version: null,
        phase: "current",
        notes: null,
      })
    }
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
    window.__TAURI_INTERNALS__ = {
      metadata: {
        currentWindow: { label: "main" },
        currentWebview: { label: "main" },
      },
      transformCallback() {
        return 1
      },
      unregisterCallback() {},
      async invoke(command, args) {
        state.calls.push(command)
        if (command === "app_update_status") return { ...state.status }
        if (command === "app_update_check") {
          if (state.failCheck) {
            state.status.error = "网络暂时不可用"
            throw new Error(state.status.error)
          }
          return
        }
        if (command === "app_update_download") {
          state.status.error = null
          if (state.failDownload) {
            state.status.error = "连接已断开"
            throw new Error(state.status.error)
          }
          state.status.phase = "ready"
          return
        }
        if (command === "app_update_install") return
        if (command === "settings_get")
          return {
            autoUpdate: true,
            logging: { level: "info", maxDiskMib: 100 },
            recovery: { computeMode: "gpuPreferred" },
          }
        if (command === "settings_update")
          return {
            autoUpdate: true,
            logging: { level: "info", maxDiskMib: args.update.value },
          }
        if (command === "recovery_queue_load")
          return {
            version: 1,
            enabled: !!state.status.queueItems,
            items: state.status.queueItems ?? [],
          }
        if (command === "recovery_capabilities")
          return { gpuAvailable: false, cpuAvailable: true, methods: [] }
        if (command === "dictionary_count") return 0
        if (command === "dictionary_list")
          return { entries: [], totalCount: 0, matchedCount: 0 }
        if (command === "compression_password_status")
          return { hasPassword: false }
        if (command === "ai_profiles_list")
          return {
            profiles: [],
            activeProfileId: "",
            renamePrompt: "测试提示词",
          }
        if (command === "plugin:event|listen") return 1
        return null
      },
    }
  }, overrides)
  await page.goto("/")
}

test("更新入口可就地展开、稍后关闭并保持键盘可达", async ({ page }) => {
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  await setup(page)
  const entry = page.getByRole("button", { name: "更新已就绪", exact: true })
  await entry.click()
  const panel = page.locator('[data-slot="popover-content"]')
  await expect(
    panel.getByRole("button", { name: "安装并重启", exact: true })
  ).toBeEnabled()
  await expect(panel).toContainText("下次打开仍可安装")
  await page.screenshot({ path: "artifacts/update-desktop.png" })
  await page.keyboard.press("Escape")
  await expect(panel).not.toBeVisible()
  await expect(entry).toBeFocused()
  await page.setViewportSize({ width: 390, height: 844 })
  await entry.click()
  const box = await panel.boundingBox()
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(390)
  await expect(panel).toHaveCSS("opacity", "1")
  await page.screenshot({ path: "artifacts/update-narrow.png" })
  await panel.getByRole("button", { name: "稍后", exact: true }).click()
  await expect(entry).toBeVisible()
  expect(
    await page.evaluate(() =>
      window.updateTest.calls.includes("app_update_install")
    )
  ).toBe(false)
  expect(errors).toEqual([])
})

test("任务结束只提醒，不自动安装", async ({ page }) => {
  await setup(page, { installBlocked: true })
  await page.getByRole("button", { name: "更新已就绪", exact: true }).click()
  const panel = page.locator('[data-slot="popover-content"]')
  await expect(
    panel.getByRole("button", { name: "安装并重启", exact: true })
  ).toHaveCount(0)
  await panel.getByRole("button", { name: "完成后提醒我" }).click()
  await expect(
    panel.getByRole("button", { name: "取消完成提醒" })
  ).toBeVisible()
  await page.evaluate(() => {
    window.updateTest.status.installBlocked = false
  })
  await expect(
    page.getByText("任务已结束，更新已就绪。", { exact: true })
  ).toBeVisible({ timeout: 10000 })
  expect(
    await page.evaluate(() =>
      window.updateTest.calls.includes("app_update_install")
    )
  ).toBe(false)
})

test("未知下载大小不伪造进度，下载失败可原地重试", async ({ page }) => {
  await setup(page, {
    phase: "downloading",
    totalBytes: null,
    downloadedBytes: 1048576,
  })
  await page.getByRole("button", { name: "下载更新…", exact: true }).click()
  const panel = page.locator('[data-slot="popover-content"]')
  await expect(panel).toContainText("已下载 1.0 MiB")
  await expect(panel).not.toContainText("%")
  await page.evaluate(() => {
    Object.assign(window.updateTest.status, {
      phase: "available",
      error: "连接已断开",
    })
  })
  await expect(panel.getByRole("button", { name: "重新下载" })).toBeVisible({
    timeout: 10000,
  })
  await panel.getByRole("button", { name: "重新下载" }).click()
  await expect(
    panel.getByRole("button", { name: "安装并重启", exact: true })
  ).toBeEnabled()
})

test("后台检查失败不弹错误通知，主动检查失败就地反馈", async ({ page }) => {
  await setup(page, { phase: "error", version: null, error: "网络暂时不可用" })
  await expect(
    page.locator('[data-sonner-toast][data-type="error"]')
  ).toHaveCount(0)
  await page.getByRole("button", { name: "更新未完成", exact: true }).click()
  await page.evaluate(() => {
    window.updateTest.failCheck = true
  })
  await page
    .locator('[data-slot="popover-content"]')
    .getByRole("button", { name: "重新检查" })
    .click()
  await expect(
    page.locator('[data-sonner-toast][data-type="error"]')
  ).toHaveCount(1)
})

test("安装前重新检查原生任务，拒绝过期的空闲状态", async ({ page }) => {
  await setup(page)
  await page.getByRole("button", { name: "更新已就绪", exact: true }).click()
  await page.evaluate(() => {
    window.updateTest.status.installBlocked = true
  })
  await page
    .locator('[data-slot="popover-content"]')
    .getByRole("button", { name: "安装并重启", exact: true })
    .click()
  await expect(page.getByRole("button", { name: "完成后提醒我" })).toBeVisible()
  expect(
    await page.evaluate(() =>
      window.updateTest.calls.includes("app_update_install")
    )
  ).toBe(false)
})

test("原生任务空闲时，待处理队列仍阻止安装", async ({ page }) => {
  await setup(page, {
    queueItems: [
      {
        id: 1,
        path: "C:/fixtures/待处理归档.zip",
        state: "waiting",
        stamp: null,
        blockedReason: null,
      },
    ],
  })
  await page.getByRole("button", { name: "更新已就绪", exact: true }).click()
  const panel = page.locator('[data-slot="popover-content"]')
  await expect(
    panel.getByRole("button", { name: "完成后提醒我" })
  ).toBeVisible()
  await expect(
    panel.getByRole("button", { name: "安装并重启", exact: true })
  ).toHaveCount(0)
})

test("未保存的日志设置阻止安装，并能返回处理", async ({ page }) => {
  await setup(page)
  await page.getByRole("button", { name: "设置", exact: true }).click()
  await page.getByRole("tab", { name: "应用", exact: true }).click()
  await page.locator("#log-max-disk-mib").fill("200")
  await page.getByRole("button", { name: "更新已就绪", exact: true }).click()
  const panel = page.locator('[data-slot="popover-content"]')
  await expect(panel).toContainText("日志磁盘上限有未保存的更改")
  await expect(
    panel.getByRole("button", { name: "安装并重启", exact: true })
  ).toBeDisabled()
  await panel.getByRole("button", { name: "返回处理" }).click()
  await expect(page.locator("#log-max-disk-mib")).toHaveValue("200")
  await page.locator("#log-max-disk-mib").fill("100")
  await page.getByRole("button", { name: "更新已就绪", exact: true }).click()
  await expect(
    panel.getByRole("button", { name: "安装并重启", exact: true })
  ).toBeEnabled()
})

test("用户确认安装后记录版本，下次启动只提示一次并保留更新说明", async ({
  page,
}) => {
  await setup(page)
  await page.getByRole("button", { name: "更新已就绪", exact: true }).click()
  await page
    .locator('[data-slot="popover-content"]')
    .getByRole("button", { name: "安装并重启", exact: true })
    .click()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.updateTest.calls.filter(
            (call) => call === "app_update_install"
          ).length
      )
    )
    .toBe(1)
  expect(
    await page.evaluate(() => localStorage.getItem("app-update-installing"))
  ).toBe("2.0.0")
  await page.evaluate(() =>
    localStorage.setItem("test-current-version", "2.0.0")
  )
  await page.reload()
  await expect(page.getByText("已更新至 v2.0.0", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "更新说明", exact: true }).click()
  await expect(page.locator('[data-slot="popover-content"]')).toContainText(
    "改进归档处理"
  )
  await page.reload()
  await expect(page.getByText("已更新至 v2.0.0", { exact: true })).toHaveCount(
    0
  )
})
