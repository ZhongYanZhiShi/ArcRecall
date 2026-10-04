import { test, expect } from "@playwright/test"
import { mkdir } from "node:fs/promises"

const task = {
  taskId: "fixture-root",
  phase: "completed",
  running: false,
  completed: true,
  success: true,
  cancelled: false,
  failureKind: null,
  failurePhase: null,
  gpuStarted: false,
  archivePath: "C:/fixtures/root.7z",
  archiveFormat: "sevenZip",
  archiveFormatLabel: "7z",
  engine: "7-Zip",
  message: "主归档解压完成，部分嵌套归档待处理。",
  candidateCount: 3,
  attemptedCount: 2,
  startedAtMs: 1000,
  elapsedMs: 1200,
  recoveredPassword: "$HEX[616263]",
  outputDirectory: "C:/fixtures/output",
  computeMode: "cpuOnly",
  recursiveEnabled: true,
  recursiveDepth: 1,
  currentArchivePath: null,
  nestedArchiveCount: 2,
  extractedNestedArchiveCount: 0,
  skippedNestedArchiveCount: 1,
  scannedFileCount: 3,
  rootExtractionCompleted: true,
  depthLimitReached: false,
  countLimitReached: false,
  completedArchivePaths: ["C:/fixtures/root.7z"],
  skippedArchivePaths: ["C:/fixtures/output/skipped.zip"],
  pendingArchivePaths: ["C:/fixtures/output/pending.zip"],
  scanInterrupted: true,
  budgetLimitReached: false,
  skippedScanDirectories: [],
  contentDirectories: [],
  timings: [{ operation: "scan", durationMs: 20 }],
  events: [],
}

async function mockDesktop(
  page,
  journal = { version: 1, enabled: false, items: [] }
) {
  await page.addInitScript(
    ({ task, journal }) => {
      let current = task
      const callbacks = new Map()
      let sequence = 0
      window.__ARC_TEST__ = {
        starts: [],
        reports: [],
        saves: [],
        unexpected: [],
      }
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
      window.__TAURI_INTERNALS__ = {
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { label: "main" },
        },
        transformCallback(fn) {
          const id = ++sequence
          callbacks.set(id, fn)
          return id
        },
        unregisterCallback(id) {
          callbacks.delete(id)
        },
        async invoke(command, args) {
          if (command === "plugin:event|listen") return 1
          if (
            command === "plugin:event|unlisten" ||
            command === "log_write" ||
            command === "open_output_directory"
          )
            return
          if (command === "app_update_status" || command === "app_update_check")
            return {
              currentVersion: "0.1.1",
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
          if (command === "settings_get")
            return {
              autoUpdate: false,
              recovery: { computeMode: "gpuPreferred" },
            }
          if (command === "dictionary_count") return 3
          if (command === "dictionary_list")
            return { entries: [], totalCount: 3, matchedCount: 0 }
          if (command === "recovery_capabilities")
            return { gpuAvailable: false, cpuAvailable: true, methods: [] }
          if (command === "recovery_queue_load") return journal
          if (command === "recovery_queue_save") {
            window.__ARC_TEST__.saves.push(args)
            return
          }
          if (command === "recovery_status") return current
          if (command === "recovery_start") {
            window.__ARC_TEST__.starts.push(args.request)
            current = {
              ...task,
              archivePath: args.request.archivePath,
              taskId: `retry-${sequence++}`,
              skippedArchivePaths: [],
              pendingArchivePaths: [],
            }
            return current
          }
          if (command === "archive_analyze")
            return {
              archivePath: args.path,
              suggestedOutputDirectory: args.path + "-out",
              format: "zip",
              formatLabel: "ZIP",
              fileSize: 32,
              fileName: args.path.split("/").pop(),
              volumeCount: 1,
            }
          if (command === "recovery_report_export") {
            window.__ARC_TEST__.reports.push(args)
            return `C:/fixtures/reports/result.${args.format}`
          }
          window.__ARC_TEST__.unexpected.push(command)
          throw new Error(`Unexpected mock IPC: ${command}`)
        },
      }
    },
    { task, journal }
  )
}

test("真实 DOM：Sheet 勾选重试、切页保留状态、导出默认脱敏", async ({
  page,
}) => {
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  await mockDesktop(page)
  await page.goto("/")
  await expect(page.getByRole("button", { name: "详细过程" })).toBeVisible()
  if (process.env.ARC_RECALL_DOC_SCREENSHOTS === "1") {
    await mkdir("assets/screenshots", { recursive: true })
    await page.screenshot({ path: "assets/screenshots/workbench.png" })
  }
  await page.getByRole("button", { name: "导出 JSON", exact: true }).click()
  await expect(
    page.getByText("已导出：C:/fixtures/reports/result.json")
  ).toBeVisible()
  const report = await page.evaluate(
    () => window.__ARC_TEST__.reports[0].report
  )
  expect(report.paths).toBeUndefined()
  expect(JSON.stringify(report)).not.toContain(task.recoveredPassword)
  await page.getByLabel("包含文件路径").check()
  await page.getByRole("button", { name: "导出 CSV", exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => window.__ARC_TEST__.reports.length))
    .toBe(2)
  await page.getByRole("button", { name: "详细过程" }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await dialog
    .getByRole("checkbox", {
      name: "重试 C:/fixtures/output/skipped.zip",
      exact: true,
    })
    .check()
  await dialog.getByRole("button", { name: "加入重试队列（1）" }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole("region", { name: "批次队列" })).toContainText(
    "skipped.zip"
  )
  await page.getByRole("button", { name: "字典", exact: true }).click()
  await page.getByRole("button", { name: "解压", exact: true }).click()
  await page.getByRole("button", { name: "按顺序处理 1 项" }).click()
  await expect
    .poll(() => page.evaluate(() => window.__ARC_TEST__.starts.length))
    .toBe(1)
  const request = await page.evaluate(() => window.__ARC_TEST__.starts[0])
  expect(request.archivePath).toBe(task.skippedArchivePaths[0])
  expect(request.computeMode).toBe("cpuOnly")
  expect(request.knownPassword).toBe(task.recoveredPassword)
  expect(request.avoidOutputCollision).toBe(true)
  expect(errors).toEqual([])
  expect(await page.evaluate(() => window.__ARC_TEST__.unexpected)).toEqual([])
})

test("真实 DOM：恢复队列等待手动启动、源文件错误和记录关闭", async ({
  page,
}) => {
  await mockDesktop(page, {
    version: 1,
    enabled: true,
    items: [
      {
        id: 1,
        path: "C:/fixtures/missing.zip",
        state: "waiting",
        blockedReason: "源文件已改变，请重新添加。",
        options: {},
      },
      {
        id: 2,
        path: "C:/fixtures/pending.zip",
        state: "running",
        options: { computeMode: "cpuOnly" },
      },
    ],
  })
  await page.goto("/")
  await expect(page.getByText(/已找回 2 项/)).toBeVisible()
  await expect(
    page.getByRole("button", { name: "按顺序处理 1 项" })
  ).toBeEnabled()
  expect(await page.evaluate(() => window.__ARC_TEST__.starts)).toEqual([])
  await page.getByLabel("记住任务队列").uncheck()
  await expect
    .poll(() => page.evaluate(() => window.__ARC_TEST__.saves.at(-1)?.enabled))
    .toBe(false)
  await expect(page.getByLabel("记住任务队列")).not.toBeChecked()
})

test("浏览器预览与窄屏仍有可读入口，无框架错误或横向溢出", async ({ page }) => {
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")
  await expect(
    page.getByRole("button", { name: "选择压缩包", exact: true })
  ).toBeVisible()
  await expect(page.getByLabel("记住任务队列")).toBeDisabled()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true)
  expect(errors).toEqual([])
})
