import { test, expect } from "@playwright/test"

async function setup(page) {
  await page.addInitScript(() => {
    window.queueCalls = []
    window.queueSaves = []
    window.queueFinishTasks = false
    const items = ["第一.zip", "第二.zip", "第三.zip"].map((name, index) => ({
      id: index + 1,
      path: `C:/资料/${name}`,
      state: "waiting",
    }))
    const preset = {
      name: "资料整理",
      outputDirectory: "D:/整理",
      recursive: false,
      computeMode: "cpuOnly",
      dictionaryGroup: null,
      openWhenDone: false,
    }
    const task = (request, running) => ({
      taskId: request.archivePath,
      phase: running ? "extracting" : "completed",
      running,
      completed: !running,
      success: !running,
      cancelled: false,
      failureKind: null,
      failurePhase: null,
      gpuStarted: false,
      archivePath: request.archivePath,
      archiveFormat: "zip",
      archiveFormatLabel: "ZIP",
      engine: "7z",
      message: running ? "正在处理" : "处理完成",
      candidateCount: 0,
      attemptedCount: 0,
      startedAtMs: Date.now(),
      elapsedMs: 10,
      recoveredPassword: null,
      outputDirectory: request.outputDirectory,
      computeMode: "cpuOnly",
      recursiveEnabled: false,
      recursiveDepth: 0,
      currentArchivePath: null,
      nestedArchiveCount: 0,
      extractedNestedArchiveCount: 0,
      skippedNestedArchiveCount: 0,
      scannedFileCount: 0,
      rootExtractionCompleted: !running,
      depthLimitReached: false,
      countLimitReached: false,
      events: [],
    })
    let currentRequest
    window.__TAURI_INTERNALS__ = {
      metadata: {
        currentWindow: { label: "main" },
        currentWebview: { label: "main" },
      },
      transformCallback: () => 1,
      unregisterCallback: () => {},
      async invoke(command, args) {
        window.queueCalls.push({ command, args })
        if (command === "app_update_status" || command === "app_update_check")
          return {
            currentVersion: "0.2.0",
            configured: false,
            autoUpdate: false,
            phase: "idle",
            version: null,
            notes: null,
            downloadedBytes: 0,
            totalBytes: null,
            lastChecked: null,
            error: null,
          }
        if (command === "recovery_queue_load")
          return { version: 1, enabled: true, items }
        if (command === "recovery_queue_save") {
          window.queueSaves.push(args)
          return null
        }
        if (command === "processing_presets_list") return [preset]
        if (command === "processing_preset_apply") {
          if (window.queueRejectPreset) throw new Error("预设输出目录不存在")
          return preset
        }
        if (command === "archive_analyze")
          return {
            archivePath: args.path,
            fileName: args.path.split("/").at(-1),
            format: "zip",
            formatLabel: "ZIP",
            fileSize: 100,
            volumeCount: 1,
            suggestedOutputDirectory: args.path.replace(/\.zip$/, ""),
          }
        if (command === "recovery_start") {
          currentRequest = args.request
          return task(currentRequest, !window.queueFinishTasks)
        }
        if (command === "recovery_status")
          return currentRequest
            ? task(currentRequest, !window.queueFinishTasks)
            : null
        if (command === "recovery_capabilities")
          return { gpuAvailable: false, cpuAvailable: true, methods: [] }
        if (command === "settings_get")
          return {
            recovery: { computeMode: "cpuOnly" },
            engine: {},
            logging: { level: "info", maxDiskMib: 25 },
          }
        if (command === "dictionary_groups") return []
        if (command === "dictionary_count") return 0
        return null
      },
    }
  })
  await page.goto("/")
  const panel = page.getByRole("region", { name: "批次队列", exact: true })
  await expect(panel.getByText("批次队列 · 3 项")).toBeVisible()
  return panel
}

test("队列等待项可调序、应用预设和批量移除，修改按新顺序写入任务记忆", async ({
  page,
}) => {
  const panel = await setup(page)
  await expect(
    panel.getByRole("button", { name: "批量检查完整性", exact: true })
  ).toBeDisabled()
  await panel
    .getByRole("button", { name: "上移 第三.zip", exact: true })
    .click()
  await expect(panel.locator("ol > li p[title]")).toHaveText([
    "第一.zip",
    "第三.zip",
    "第二.zip",
  ])
  await panel
    .getByRole("checkbox", { name: "选择队列项 第三.zip", exact: true })
    .click()
  await panel
    .getByRole("button", { name: "为所选等待项应用预设", exact: true })
    .click()
  const dialog = page.getByRole("dialog", {
    name: "为等待项应用预设",
    exact: true,
  })
  await dialog.getByRole("combobox", { name: "队列处理预设" }).click()
  await page.getByRole("option", { name: "资料整理", exact: true }).click()
  await dialog
    .getByRole("button", { name: "确认应用到所选等待项", exact: true })
    .click()
  await expect(dialog).not.toBeVisible()
  const saved = await page.evaluate(() => window.queueSaves.at(-1))
  expect(saved.items.map((item) => item.path)).toEqual([
    "C:/资料/第一.zip",
    "C:/资料/第三.zip",
    "C:/资料/第二.zip",
  ])
  expect(saved.items[1].options).toEqual({
    outputDirectory: "D:/整理",
    recursive: false,
    computeMode: "cpuOnly",
    dictionaryGroup: null,
    openWhenDone: false,
  })
  expect(saved.items[0].options).toBeUndefined()
  expect(saved.items[2].options).toBeUndefined()
  await panel
    .getByRole("checkbox", { name: "选择队列项 第二.zip", exact: true })
    .click()
  await panel
    .getByRole("button", { name: "移除所选 2 项", exact: true })
    .click()
  await expect(panel.locator("ol > li p[title]")).toHaveText(["第一.zip"])
  await expect
    .poll(() => page.evaluate(() => window.queueSaves.at(-1)?.items.length))
    .toBe(1)
  await page.screenshot({
    path: test.info().outputPath("queue-management.png"),
  })
})

test("安排暂停会等待当前项成功并保留后续等待项，继续处理不重跑已完成项", async ({
  page,
}) => {
  const panel = await setup(page)
  await panel
    .getByRole("button", { name: "按顺序处理 3 项", exact: true })
    .click()
  await panel
    .getByRole("button", { name: "当前项完成后暂停", exact: true })
    .click()
  await expect(
    panel.getByText("已安排暂停：当前归档仍会完成处理，随后保留等待项。")
  ).toBeVisible()
  await expect(
    panel.getByRole("checkbox", { name: "选择队列项 第二.zip", exact: true })
  ).toBeDisabled()
  expect(
    await page.evaluate(() =>
      window.queueCalls.some((call) => call.command === "recovery_cancel")
    )
  ).toBe(false)
  await page.evaluate(() => {
    window.queueFinishTasks = true
  })
  await expect(
    panel.getByRole("button", { name: "继续处理 2 项", exact: true })
  ).toBeVisible()
  await expect(panel.locator("ol > li").nth(0)).toContainText("已完成")
  await expect(panel.locator("ol > li").nth(1)).toContainText("等待")
  expect(
    await page.evaluate(
      () =>
        window.queueCalls.filter((call) => call.command === "recovery_start")
          .length
    )
  ).toBe(1)
  await page.screenshot({ path: test.info().outputPath("queue-paused.png") })
  await panel
    .getByRole("button", { name: "继续处理 2 项", exact: true })
    .click()
  await expect(
    panel.getByRole("button", { name: "暂无待处理任务", exact: true })
  ).toBeVisible()
  expect(
    await page.evaluate(() =>
      window.queueCalls
        .filter((call) => call.command === "recovery_start")
        .map((call) => call.args.request.archivePath)
    )
  ).toEqual(["C:/资料/第一.zip", "C:/资料/第二.zip", "C:/资料/第三.zip"])
})

test("预设校验失败会保留等待项原选项并显示错误", async ({ page }) => {
  const panel = await setup(page)
  await page.evaluate(() => {
    window.queueRejectPreset = true
  })
  await panel
    .getByRole("checkbox", { name: "选择队列项 第一.zip", exact: true })
    .click()
  await panel
    .getByRole("button", { name: "为所选等待项应用预设", exact: true })
    .click()
  const dialog = page.getByRole("dialog", {
    name: "为等待项应用预设",
    exact: true,
  })
  await dialog.getByRole("combobox", { name: "队列处理预设" }).click()
  await page.getByRole("option", { name: "资料整理", exact: true }).click()
  await dialog
    .getByRole("button", { name: "确认应用到所选等待项", exact: true })
    .click()
  await expect(dialog.getByRole("alert")).toContainText("预设输出目录不存在")
  expect(await page.evaluate(() => window.queueSaves.length)).toBe(0)
})
