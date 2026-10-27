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
      failSettings: false,
      savedTools: "C:\\工具",
      savedJohn: "C:\\工具\\John",
      savedPerl: "C:\\工具\\Perl\\perl.exe",
      settings: {
        autoUpdate: true,
        logging: { level: "info", maxDiskMib: 100 },
        recovery: {
          computeMode: "gpuPreferred",
          scanMaxFilesPerDirectory: 10,
          extractionLimits: { maxGib: 100, maxEntries: 100000, maxDepth: 5 },
        },
      },
      desktopSettings: {
        supported: true,
        contextMenu: false,
        setupCompleted: true,
      },
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
        if (
          command === "desktop_launch_list" ||
          command === "compression_presets_list"
        )
          return []
        if (command === "compression_queue_load")
          return { enabled: false, items: [] }
        if (command === "desktop_integration_status") {
          if (state.failDesktopRead) throw new Error("暂时无法读取右键菜单")
          return { ...state.desktopSettings }
        }
        if (command === "desktop_integration_save") {
          state.desktopSettings.contextMenu = args.enabled
          return { ...state.desktopSettings }
        }
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
        if (command === "settings_get") {
          if (state.failSettingsRead) throw new Error("暂时无法读取设置")
          return structuredClone(state.settings)
        }
        if (command === "settings_update") {
          if (state.pendingSettings)
            await new Promise((resolve) => {
              state.finishSettings = resolve
            })
          if (state.failSettings) throw new Error("模拟保存失败")
          const { kind, value } = args.update
          if (kind === "logMaxDiskMib")
            state.settings.logging.maxDiskMib = value
          else if (kind === "logLevel") state.settings.logging.level = value
          else if (kind === "autoUpdate") state.settings.autoUpdate = value
          else state.settings.recovery[kind] = value
          return structuredClone(state.settings)
        }
        if (command === "recovery_queue_load")
          return {
            version: 1,
            enabled: !!state.status.queueItems,
            items: state.status.queueItems ?? [],
          }
        if (command === "tool_hashcat_status")
          return {
            configuredToolsDirectory: state.savedTools,
            toolsDirectory: state.savedTools,
            defaultToolsDirectory: "C:\\默认工具",
            installed: false,
          }
        if (command === "tool_john_perl_status")
          return {
            johnToolsDirectory: state.savedJohn,
            perlPath: state.savedPerl,
            ready: true,
            message: "已检测保存的路径",
          }
        if (command === "tool_full_bundle_status") {
          const component = {
            installed: false,
            bundled: false,
            runnable: false,
            version: "1",
            message: "未安装",
          }
          return {
            bundled: false,
            installed: false,
            sevenZip: { ...component, id: "7z", name: "7-Zip" },
            hashcat: { ...component, id: "hashcat", name: "Hashcat" },
            john: { ...component, id: "john", name: "John" },
            perl: { ...component, id: "perl", name: "Perl" },
          }
        }
        if (command === "tool_set_tools_directory") {
          if (state.failPathSave) throw new Error("路径保存失败")
          state.savedTools = args.path
          return structuredClone(state.settings)
        }
        if (command === "tool_set_john_perl") {
          if (state.failPathSave) throw new Error("路径保存失败")
          state.savedJohn = args.johnToolsDirectory
          state.savedPerl = args.perlPath
          return {
            johnToolsDirectory: state.savedJohn,
            perlPath: state.savedPerl,
            ready: true,
            message: "路径已保存",
          }
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
    window.updateTest.calls = []
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
  await page.getByRole("tab", { name: "常规", exact: true }).click()
  await page.locator("#log-max-disk-mib").fill("200")
  await page.getByRole("button", { name: "更新已就绪", exact: true }).click()
  const panel = page.locator('[data-slot="popover-content"]')
  await expect(panel).toContainText("常规设置有未保存的更改")
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
  const notes = page.getByRole("dialog", { name: "更新说明", exact: true })
  await expect(notes).toContainText("改进归档处理")
  await expect(page.locator('[data-slot="popover-content"]')).toHaveCount(0)
  await notes.getByRole("button", { name: "关闭", exact: true }).click()
  await page.getByRole("button", { name: "设置", exact: true }).click()
  await page.getByRole("tab", { name: "常规", exact: true }).click()
  await expect(
    page.getByRole("heading", { name: "当前版本更新说明" })
  ).toBeVisible()
  await page.reload()
  await expect(page.getByText("已更新至 v2.0.0", { exact: true })).toHaveCount(
    0
  )
})

for (const width of [1280, 390]) {
  test(`设置页内完成更新操作且无需详情弹窗（${width}px）`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    await setup(page, { phase: "available" })
    await page.getByRole("button", { name: "设置", exact: true }).click()
    await page.getByRole("tab", { name: "常规", exact: true }).click()
    const panel = page.getByRole("tabpanel", { name: "常规", exact: true })
    await expect(panel.getByText("应用更新", { exact: true })).toBeVisible()
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await panel.getByRole("button", { name: "下载更新", exact: true }).click()
    await expect(
      panel.getByRole("button", { name: "安装并重启", exact: true })
    ).toBeEnabled()
    await panel.getByRole("button", { name: "安装并重启", exact: true }).click()
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.updateTest.calls.filter(
              (command) => command === "app_update_install"
            ).length
        )
      )
      .toBe(1)
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await page.screenshot({ path: `artifacts/settings-update-${width}.png` })
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth
      )
    ).toBe(true)
  })
}

test("设置页内检查更新并展示失败重试", async ({ page }) => {
  await setup(page, { phase: "idle" })
  await page.getByRole("button", { name: "设置", exact: true }).click()
  await page.getByRole("tab", { name: "常规", exact: true }).click()
  const panel = page.getByRole("tabpanel", { name: "常规", exact: true })
  await page.evaluate(() => {
    window.updateTest.failCheck = true
    window.updateTest.calls = []
  })
  await panel.getByRole("button", { name: "检查更新", exact: true }).click()
  await expect(panel.getByText("更新未完成，当前版本仍可使用。")).toBeVisible()
  await page.evaluate(() => {
    window.updateTest.failCheck = false
  })
  await panel.getByRole("button", { name: "重新检查", exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.updateTest.calls.filter(
            (command) => command === "app_update_check"
          ).length
      )
    )
    .toBe(2)
  await expect(page.getByRole("dialog")).toHaveCount(0)
})

for (const width of [1280, 390]) {
  for (const entry of ["settings", "popover"]) {
    test(`完整更新说明独立展示并返回原操作入口（${entry}-${width}）`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 })
      const notes = "改进归档处理与路径兼容。\n".repeat(80) + "更新说明结束。"
      await setup(page, { notes })
      let panel
      if (entry === "settings") {
        await page.getByRole("button", { name: "设置", exact: true }).click()
        await page.getByRole("tab", { name: "常规", exact: true }).click()
        panel = page.getByRole("tabpanel", { name: "常规", exact: true })
      } else {
        await page
          .getByRole("button", { name: "更新已就绪", exact: true })
          .click()
        panel = page.locator('[data-slot="popover-content"]')
      }
      const trigger = panel.getByRole("button", {
        name: "查看更新说明",
        exact: true,
      })
      await trigger.click()
      const dialog = page.getByRole("dialog", { name: "更新说明", exact: true })
      await expect(dialog).toContainText("版本 v2.0.0")
      await expect(dialog).toContainText("更新说明结束。")
      await expect(
        dialog.getByRole("button", { name: "安装并重启" })
      ).toHaveCount(0)
      await expect(dialog).toHaveCSS("translate", "none")
      const bounds = await dialog.boundingBox()
      expect(bounds.x).toBeGreaterThanOrEqual(0)
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width)
      await expect(
        dialog.getByRole("button", { name: "关闭", exact: true })
      ).toBeInViewport({ ratio: 1 })
      await page.keyboard.press("Escape")
      await expect(dialog).not.toBeVisible()
      await expect(trigger).toBeFocused()
      await expect(
        panel.getByRole("button", { name: "安装并重启", exact: true })
      ).toBeEnabled()
    })
  }
}

for (const field of ["目录扫描文件数上限", "最大嵌套深度"]) {
  test(`未保存的${field}阻止安装且返回原草稿`, async ({ page }) => {
    await setup(page)
    await page.getByRole("button", { name: "设置", exact: true }).click()
    const input = page.getByRole("spinbutton", { name: field, exact: true })
    await input.fill("12")
    await page.getByRole("button", { name: "更新已就绪", exact: true }).click()
    const popover = page.locator('[data-slot="popover-content"]')
    await expect(popover).toContainText("解压与解密设置有未保存的更改")
    await expect(
      popover.getByRole("button", { name: "安装并重启", exact: true })
    ).toBeDisabled()
    await popover.getByRole("button", { name: "返回处理", exact: true }).click()
    await expect(input).toHaveValue("12")
    await expect(input).toBeFocused()
    await page
      .getByRole("button", {
        name: field === "最大嵌套深度" ? "保存解压限制" : "保存上限",
        exact: true,
      })
      .click()
    await page.getByRole("button", { name: "更新已就绪", exact: true }).click()
    await expect(
      popover.getByRole("button", { name: "安装并重启", exact: true })
    ).toBeEnabled()
  })
}

test("右键菜单草稿保存前阻止安装，保存后解除保护", async ({ page }) => {
  await setup(page)
  await page.getByRole("button", { name: "设置", exact: true }).click()
  await page.getByRole("tab", { name: "常规", exact: true }).click()
  const save = page.getByRole("button", {
    name: "保存右键菜单设置",
    exact: true,
  })
  await expect(save).toBeDisabled()
  await page.getByRole("checkbox", { name: /开启 Windows 右键菜单/ }).check()
  await page.getByRole("button", { name: "更新已就绪", exact: true }).click()
  const popover = page.locator('[data-slot="popover-content"]')
  await expect(
    popover.getByRole("button", { name: "安装并重启", exact: true })
  ).toBeDisabled()
  await popover.getByRole("button", { name: "返回处理", exact: true }).click()
  await expect(
    page.getByRole("checkbox", { name: /开启 Windows 右键菜单/ })
  ).toBeChecked()
  await save.click()
  await expect(save).toBeDisabled()
  await page.getByRole("button", { name: "更新已就绪", exact: true }).click()
  await expect(
    popover.getByRole("button", { name: "安装并重启", exact: true })
  ).toBeEnabled()
})

test("解压限制校验输入、保留失败草稿并清理过期成功反馈", async ({ page }) => {
  await setup(page)
  await page.getByRole("button", { name: "设置", exact: true }).click()
  const input = page.getByRole("spinbutton", {
    name: "最大嵌套深度",
    exact: true,
  })
  const save = page.getByRole("button", { name: "保存解压限制", exact: true })
  await expect(save).toBeDisabled()
  for (const value of ["", "0", "65", "1.5"]) {
    await input.fill(value)
    await expect(input).toHaveAttribute("aria-invalid", "true")
    await expect(save).toBeDisabled()
  }
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.updateTest.calls.filter(
            (command) => command === "settings_update"
          ).length
      )
    )
    .toBe(0)
  await input.fill("8")
  await page.evaluate(() => {
    window.updateTest.failSettings = true
    window.updateTest.pendingSettings = true
  })
  await save.click()
  await expect(
    page.getByRole("button", { name: "正在保存…", exact: true })
  ).toBeDisabled()
  await page.evaluate(() => {
    window.updateTest.finishSettings()
  })
  await expect(
    page.getByRole("alert").filter({ hasText: "模拟保存失败" })
  ).toBeVisible()
  await expect(input).toHaveValue("8")
  await page.evaluate(() => {
    window.updateTest.failSettings = false
    window.updateTest.pendingSettings = false
  })
  await save.click()
  await expect(
    page.getByText("已保存，下次启动的解压任务生效。", { exact: true })
  ).toBeVisible()
  await expect(save).toBeDisabled()
  await input.fill("9")
  await expect(
    page.getByText("已保存，下次启动的解压任务生效。", { exact: true })
  ).toHaveCount(0)
  await expect(save).toBeEnabled()
  await input.fill("8")
  await expect(save).toBeDisabled()
})

for (const width of [1280, 390]) {
  test(`引擎路径检测和刷新保留草稿，更新保护定位到对应字段（${width}）`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 })
    await setup(page)
    await page.getByRole("button", { name: "设置", exact: true }).click()
    await page.getByRole("button", { name: "引擎管理", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "引擎管理", exact: true })
    await dialog.getByRole("tab", { name: "工具目录", exact: true }).click()
    const tools = dialog.getByRole("textbox", {
      name: "公共目录（绝对路径）",
      exact: true,
    })
    await tools.fill("C:\\自定义工具")
    await dialog.getByRole("tab", { name: "John / Perl", exact: true }).click()
    const john = dialog.getByRole("textbox", {
      name: "John 工具目录",
      exact: true,
    })
    await john.fill("C:\\自定义工具\\John")
    await dialog
      .getByRole("button", { name: "检测已保存配置", exact: true })
      .click()
    await expect(john).toHaveValue("C:\\自定义工具\\John")
    await expect(
      dialog.getByRole("button", { name: "保存", exact: true })
    ).toBeEnabled()
    await dialog.getByRole("button", { name: "关闭", exact: true }).click()
    await page.getByRole("button", { name: "重新探测", exact: true }).click()
    await expect(
      page.getByRole("button", { name: "重新探测", exact: true })
    ).toBeEnabled()
    await page.getByRole("button", { name: "更新已就绪", exact: true }).click()
    const popover = page.locator('[data-slot="popover-content"]')
    await expect(
      popover.getByRole("button", { name: "安装并重启", exact: true })
    ).toBeDisabled()
    await popover.getByRole("button", { name: "返回处理", exact: true }).click()
    await expect(dialog).toBeVisible()
    await expect(tools).toBeFocused()
    await expect(tools).toHaveValue("C:\\自定义工具")
    await dialog.getByRole("button", { name: "撤销修改", exact: true }).click()
    await dialog.getByRole("tab", { name: "John / Perl", exact: true }).click()
    await expect(john).toHaveValue("C:\\自定义工具\\John")
    await dialog.getByRole("button", { name: "关闭", exact: true }).click()
    await page.getByRole("button", { name: "更新已就绪", exact: true }).click()
    await popover.getByRole("button", { name: "返回处理", exact: true }).click()
    await expect(john).toBeFocused()
    await dialog.getByRole("button", { name: "撤销修改", exact: true }).click()
    await dialog.getByRole("button", { name: "关闭", exact: true }).click()
    await page.getByRole("button", { name: "更新已就绪", exact: true }).click()
    await expect(
      popover.getByRole("button", { name: "安装并重启", exact: true })
    ).toBeEnabled()
  })
}

test("设置读取失败可以在原位置重试", async ({ page }) => {
  await setup(page)
  await page.evaluate(() => {
    window.updateTest.failSettingsRead = true
    window.updateTest.failDesktopRead = true
  })
  await page.getByRole("button", { name: "设置", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "重新读取解压限制", exact: true })
  ).toBeVisible()
  await page.evaluate(() => {
    window.updateTest.failSettingsRead = false
  })
  await page
    .getByRole("button", { name: "重新读取解压限制", exact: true })
    .click()
  await expect(
    page.getByRole("spinbutton", { name: "最大嵌套深度", exact: true })
  ).toBeEnabled()
  await page.getByRole("tab", { name: "常规", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "重新读取右键菜单设置", exact: true })
  ).toBeVisible()
  await page.evaluate(() => {
    window.updateTest.failDesktopRead = false
  })
  await page
    .getByRole("button", { name: "重新读取右键菜单设置", exact: true })
    .click()
  await expect(
    page.getByRole("checkbox", { name: /开启 Windows 右键菜单/ })
  ).toBeEnabled()
})

test("保存一组引擎路径不覆盖其他草稿，失败可重试", async ({ page }) => {
  await setup(page)
  await page.getByRole("button", { name: "设置", exact: true }).click()
  await page.getByRole("button", { name: "引擎管理", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "引擎管理", exact: true })
  await dialog.getByRole("tab", { name: "John / Perl", exact: true }).click()
  const john = dialog.getByRole("textbox", {
    name: "John 工具目录",
    exact: true,
  })
  await john.fill("C:\\新工具\\John")
  await dialog.getByRole("tab", { name: "工具目录", exact: true }).click()
  await dialog
    .getByRole("textbox", { name: "公共目录（绝对路径）", exact: true })
    .fill("C:\\新工具")
  await dialog.getByRole("button", { name: "保存目录", exact: true }).click()
  await expect(
    dialog.getByRole("button", { name: "保存目录", exact: true })
  ).toBeDisabled()
  await dialog.getByRole("tab", { name: "John / Perl", exact: true }).click()
  await expect(john).toHaveValue("C:\\新工具\\John")
  await page.evaluate(() => {
    window.updateTest.failPathSave = true
  })
  await dialog.getByRole("button", { name: "保存", exact: true }).click()
  await expect(page.locator("[data-sonner-toaster]")).toContainText(
    "路径保存失败"
  )
  await expect(john).toHaveValue("C:\\新工具\\John")
  await page.evaluate(() => {
    window.updateTest.failPathSave = false
  })
  await dialog.getByRole("button", { name: "保存", exact: true }).click()
  await expect(
    dialog.getByRole("button", { name: "保存", exact: true })
  ).toBeDisabled()
  await expect(john).toHaveValue("C:\\新工具\\John")
})
