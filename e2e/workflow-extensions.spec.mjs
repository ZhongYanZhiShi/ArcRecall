import { test, expect } from "@playwright/test"

async function setup(page) {
  await page.goto("/")
  await expect(
    page.getByRole("button", { name: "选择压缩包", exact: true })
  ).toBeVisible()
  await page.evaluate(() => {
    window.workflowCalls = []
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
