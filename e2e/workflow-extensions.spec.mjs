import { test, expect } from "@playwright/test"

async function setup(page) {
  await page.goto("/")
  await expect(
    page.getByRole("button", { name: "选择压缩包", exact: true })
  ).toBeVisible()
  await page.evaluate(() => {
    window.workflowCalls = []
    window.testPresets = [
      {
        name: "资料处理",
        outputDirectory: null,
        recursive: false,
        computeMode: "cpuOnly",
        dictionaryGroup: "资料分组",
        openWhenDone: false,
      },
    ]
    const entries = [
      { id: 1, value: "candidate-one", byteCount: 13, successCount: 0 },
      { id: 2, value: "candidate-two", byteCount: 13, successCount: 0 },
    ]
    window.__TAURI_INTERNALS__ = {
      metadata: {
        currentWindow: { label: "main" },
        currentWebview: { label: "main" },
      },
      transformCallback: () => 1,
      unregisterCallback: () => {},
      async invoke(command, args) {
        window.workflowCalls.push({ command, args })
        if (command === "processing_presets_list") return window.testPresets
        if (command === "processing_preset_apply")
          return window.testPresets.find((p) => p.name === args.name)
        if (command === "processing_preset_save") {
          window.testPresets = [
            ...window.testPresets.filter((p) => p.name !== args.preset.name),
            args.preset,
          ]
          return null
        }
        if (command === "processing_preset_delete") {
          window.testPresets = window.testPresets.filter(
            (p) => p.name !== args.name
          )
          return null
        }
        if (command === "archive_folder_scan") {
          const result = {
            entries: [
              {
                path: "C:/扫描/资料.7z.001",
                volumePaths: ["C:/扫描/资料.7z.001", "C:/扫描/资料.7z.002"],
                format: "7z",
                fileSize: 100,
                volumeCount: 2,
              },
              {
                path: "C:/扫描/其他.zip",
                volumePaths: ["C:/扫描/其他.zip"],
                format: "ZIP",
                fileSize: 50,
                volumeCount: 1,
              },
            ],
            warnings: [],
            visitedEntries: 3,
            ignoredFiles: 0,
            skippedLinks: 0,
            truncated: false,
            cancelled: false,
          }
          if (window.deferFolderScan)
            return new Promise((resolve) => {
              window.finishFolderScan = () =>
                resolve({ ...result, cancelled: true })
            })
          return result
        }
        if (command === "plugin:dialog|open") return "C:/测试输出"
        if (command === "archive_action_run") {
          if (window.deferArchiveAction)
            return new Promise((resolve, reject) => {
              window.rejectArchiveAction = reject
            })
          return {
            outputDirectory: args.request.selectedPaths
              ? "C:/测试输出/新目录"
              : null,
            entryCount: 1,
            message: args.request.selectedPaths
              ? "所选文件提取完成"
              : "完整性检查通过",
          }
        }
        if (command === "archive_action_cancel") {
          window.rejectArchiveAction?.("操作已取消")
          window.finishFolderScan?.()
          return null
        }
        if (command === "dictionary_groups") return ["资料分组"]
        if (command === "dictionary_list")
          return { entries, totalCount: 2, matchedCount: 2 }
        if (command === "dictionary_group_list")
          return {
            entries: entries.slice(0, 1),
            totalCount: 2,
            matchedCount: 1,
          }
        if (command === "dictionary_count") return 2
        if (command === "history_list")
          return {
            entries: [],
            totalCount: 0,
            matchedCount: 0,
            passwordCount: 0,
          }
        if (command === "task_records_list")
          return [
            {
              taskId: "sample-task",
              archivePath: "C:/测试目录/嵌套归档.zip",
              outputDirectory: "C:/测试输出",
              startedAtMs: 1000,
              elapsedMs: 1500,
              state: "failed",
              failureKind: "MissingTool",
              recursive: true,
              computeMode: "cpuOnly",
              dictionaryGroup: "资料分组",
              pendingArchivePaths: [],
              skippedScanDirectories: [],
            },
          ]
        if (command === "archive_analyze")
          return {
            archivePath: args.path,
            fileName: "嵌套归档.zip",
            format: "zip",
            formatLabel: "ZIP",
            fileSize: 100,
            volumeCount: 1,
            suggestedOutputDirectory: "C:/测试输出",
          }
        if (command === "archive_preview")
          return {
            entries: [
              {
                path: "中文目录/资料.txt",
                size: 42,
                directory: false,
                encrypted: true,
              },
              {
                path: "图片.png",
                size: 10,
                directory: false,
                encrypted: false,
              },
            ],
            totalEntries: 2,
            totalBytes: 52,
            truncated: false,
          }
        if (command === "recovery_status") return null
        if (command === "recovery_capabilities")
          return { gpuAvailable: false, cpuAvailable: true, methods: [] }
        if (command === "settings_get")
          return {
            recovery: { computeMode: "cpuOnly" },
            engine: {},
            logging: { level: "info", maxDiskMib: 25 },
          }
        return null
      },
    }
  })
}

test("归档预览只读取目录并支持按路径筛选", async ({ page }) => {
  await setup(page)
  await page.evaluate(() => {
    const data = new DataTransfer()
    data.setData("text/plain", "C:/测试目录/嵌套归档.zip")
    window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data }))
  })
  await page.getByRole("button", { name: "预览内容", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "归档内容预览" })
  await expect(dialog.getByText("文件 · 中文目录/资料.txt")).toBeVisible()
  await dialog.getByRole("textbox", { name: "搜索归档内容" }).fill("资料")
  await expect(dialog.getByText("文件 · 图片.png")).toHaveCount(0)
  const calls = await page.evaluate(() => window.workflowCalls)
  expect(
    calls.filter((call) => call.command === "archive_preview")
  ).toHaveLength(1)
  expect(calls.some((call) => call.command === "recovery_start")).toBe(false)
  await page.screenshot({ path: test.info().outputPath("archive-preview.png") })
})

test("已有候选可加入字典分组并按分组查看", async ({ page }) => {
  await setup(page)
  await page.getByRole("button", { name: "字典", exact: true }).click()
  await page.getByRole("checkbox", { name: "选择候选 #1", exact: true }).click()
  await page.getByRole("button", { name: /管理分组/ }).click()
  const dialog = page.getByRole("dialog", { name: "字典分组", exact: true })
  await dialog.getByRole("textbox", { name: "新分组名称" }).fill("资料分组")
  await dialog.getByRole("button", { name: "创建分组并加入所选候选" }).click()
  await expect(dialog).not.toBeVisible()
  await expect(
    page.getByRole("checkbox", { name: "选择候选 #2", exact: true })
  ).toHaveCount(0)
  expect(
    await page.evaluate(
      () =>
        window.workflowCalls.find(
          (call) => call.command === "dictionary_group_assign"
        ).args
    )
  ).toEqual({ name: "资料分组", ids: [1] })
  await page.screenshot({
    path: test.info().outputPath("dictionary-groups.png"),
  })
})

test("失败记录允许补充密码并加入队列而不直接执行", async ({ page }) => {
  await setup(page)
  await page.getByRole("button", { name: "历史", exact: true }).click()
  await page.getByRole("button", { name: "任务记录", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "任务记录与重试" })
  await expect(dialog.getByText("引擎未就绪")).toBeVisible()
  await dialog.getByRole("button", { name: "准备重试" }).click()
  await dialog
    .getByRole("textbox", { name: "重试已知密码" })
    .fill("temporary-secret")
  await page.screenshot({
    path: test.info().outputPath("task-records-retry.png"),
  })
  await dialog.getByRole("button", { name: "整包加入队列" }).click()
  await expect(
    page.getByText("已加入解压队列，请到解压页确认并开始。")
  ).toBeVisible()
  const calls = await page.evaluate(() => window.workflowCalls)
  expect(calls.some((call) => call.command === "recovery_start")).toBe(false)
  expect(
    calls
      .filter((call) => call.command === "recovery_queue_save")
      .some((call) => JSON.stringify(call.args).includes("temporary-secret"))
  ).toBe(false)
})

test("预览中勾选单个文件后只提交所选路径并展示输出位置", async ({ page }) => {
  await setup(page)
  await page.evaluate(() => {
    const data = new DataTransfer()
    data.setData("text/plain", "C:/测试目录/嵌套归档.zip")
    window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data }))
  })
  await page.getByRole("button", { name: "预览内容", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "归档内容预览" })
  await dialog
    .getByRole("checkbox", { name: "选择 中文目录/资料.txt", exact: true })
    .click()
  await dialog
    .getByRole("button", { name: "提取所选（1）", exact: true })
    .click()
  await expect(dialog.getByText("所选文件提取完成")).toBeVisible()
  expect(
    await page.evaluate(
      () =>
        window.workflowCalls.find((c) => c.command === "archive_action_run")
          .args.request.selectedPaths
    )
  ).toEqual(["中文目录/资料.txt"])
  await expect(
    dialog.getByRole("button", { name: "打开提取目录" })
  ).toBeVisible()
  await dialog.getByRole("button", { name: "检查完整性", exact: true }).click()
  await expect(
    dialog.getByText("完整性检查通过", { exact: true })
  ).toBeVisible()
})

test("运行完整性检查时禁止重复提交并允许取消", async ({ page }) => {
  await setup(page)
  await page.evaluate(() => {
    window.deferArchiveAction = true
    const data = new DataTransfer()
    data.setData("text/plain", "C:/测试目录/嵌套归档.zip")
    window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data }))
  })
  await page.getByRole("button", { name: "预览内容", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "归档内容预览" })
  await dialog.getByRole("button", { name: "检查完整性", exact: true }).click()
  await expect(
    dialog.getByRole("button", { name: "检查完整性", exact: true })
  ).toBeDisabled()
  await dialog.getByRole("button", { name: "取消操作", exact: true }).click()
  await expect(dialog.getByRole("alert")).toHaveText("操作已取消")
  await expect(
    dialog.getByRole("button", { name: "检查完整性", exact: true })
  ).toBeEnabled()
})

test("应用预设后扫描结果经确认加入队列且不自动开始", async ({ page }) => {
  await setup(page)
  await page.getByRole("button", { name: "处理预设", exact: true }).click()
  const presets = page.getByRole("dialog", { name: "处理预设", exact: true })
  await presets.getByRole("combobox", { name: "已保存预设" }).click()
  await page.getByRole("option", { name: "资料处理", exact: true }).click()
  await presets.getByRole("button", { name: "应用预设", exact: true }).click()
  await expect(presets).not.toBeVisible()
  await page.getByRole("button", { name: "处理预设", exact: true }).click()
  await presets
    .getByRole("textbox", { name: "预设名称", exact: true })
    .fill("新预设")
  await presets
    .getByRole("button", { name: "保存当前选项", exact: true })
    .click()
  await expect(page.getByText("预设已保存", { exact: true })).toBeVisible()
  const saved = await page.evaluate(
    () =>
      window.workflowCalls.find((c) => c.command === "processing_preset_save")
        .args.preset
  )
  expect(saved.recursive).toBe(false)
  expect(saved.dictionaryGroup).toBe("资料分组")
  expect(saved).not.toHaveProperty("knownPassword")
  await expect(
    presets.getByRole("button", { name: "保存当前选项", exact: true })
  ).toBeDisabled()
  await page.keyboard.press("Escape")
  await page.getByRole("button", { name: "扫描文件夹", exact: true }).click()
  const scanner = page.getByRole("dialog", { name: "扫描文件夹并导入" })
  await scanner
    .getByRole("button", { name: "选择文件夹并扫描", exact: true })
    .click()
  await expect(
    scanner.getByRole("checkbox", {
      name: "导入 C:/扫描/资料.7z.001",
      exact: true,
    })
  ).toBeVisible()
  await scanner
    .getByRole("checkbox", { name: "导入 C:/扫描/资料.7z.001", exact: true })
    .click()
  await scanner
    .getByRole("button", { name: "确认加入队列（1）", exact: true })
    .click()
  await expect(scanner).not.toBeVisible()
  expect(
    await page.evaluate(() =>
      window.workflowCalls.some((c) => c.command === "recovery_start")
    )
  ).toBe(false)
  await page.getByRole("button", { name: "扫描文件夹", exact: true }).click()
  await expect(
    scanner.getByRole("checkbox", {
      name: "导入 C:/扫描/资料.7z.001",
      exact: true,
    })
  ).toBeDisabled()
  await page.screenshot({
    path: test.info().outputPath("folder-scan-import.png"),
    animations: "disabled",
  })
})

test("扫描取消后保留部分结果供用户确认", async ({ page }) => {
  await setup(page)
  await page.evaluate(() => {
    window.deferFolderScan = true
  })
  await page.getByRole("button", { name: "扫描文件夹", exact: true }).click()
  const scanner = page.getByRole("dialog", { name: "扫描文件夹并导入" })
  await scanner
    .getByRole("button", { name: "选择文件夹并扫描", exact: true })
    .click()
  await expect
    .poll(() => page.evaluate(() => !!window.finishFolderScan))
    .toBe(true)
  await scanner.getByRole("button", { name: "停止扫描", exact: true }).click()
  await expect(scanner.getByRole("status")).toContainText("扫描已停止")
  await expect(
    scanner.getByRole("checkbox", {
      name: "导入 C:/扫描/其他.zip",
      exact: true,
    })
  ).toBeEnabled()
})
