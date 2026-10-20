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
  journal = { version: 1, enabled: false, items: [] },
  activeTask = task
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
        setTask(next) {
          current = next
        },
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
          if (command === "plugin:window|is_minimized") return false
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
    { task: activeTask, journal }
  )
}

test("归档类型随恢复状态更新，兼容旧快照、改名文件与窄屏", async ({ page }) => {
  const running = {
    ...task,
    phase: "hashcat",
    running: true,
    completed: false,
    success: false,
    engine: "Hashcat GPU",
    archivePath: "C:/fixtures/root.dll",
    recursiveDepth: 0,
    rootExtractionCompleted: false,
  }
  // Older task snapshots have only the root format.
  await mockDesktop(page, undefined, running)
  await page.goto("/")
  const format = page.getByText(/^识别类型：/)
  await expect(format).toHaveText("识别类型：7z")

  const nested = {
    ...running,
    phase: "john",
    engine: "John CPU",
    recursiveDepth: 1,
    rootExtractionCompleted: true,
    currentArchivePath: "C:/fixtures/output/嵌套归档.dll",
    currentArchiveFormatLabel: "RAR5",
  }
  await page.evaluate((next) => window.__ARC_TEST__.setTask(next), nested)
  await expect(format).toHaveText("识别类型：RAR5")
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(format).toBeVisible()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true)

  // The completed result describes the root even if the last child was a RAR.
  await page.evaluate((next) => window.__ARC_TEST__.setTask(next), {
    ...nested,
    phase: "completed",
    running: false,
    completed: true,
    success: true,
  })
  await expect(format).toHaveText("识别类型：7z")
})

test("真实 DOM：Sheet 勾选重试、切页保留状态、导出默认脱敏", async ({
  page,
}) => {
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  await mockDesktop(page)
  await page.goto("/")
  await expect(page.getByText(/^识别类型：/)).toHaveText("识别类型：7z")
  await expect(page.getByRole("button", { name: "详细过程" })).toBeVisible()
  if (process.env.ARC_RECALL_DOC_SCREENSHOTS === "1") {
    await mkdir("assets/screenshots", { recursive: true })
    await page.screenshot({ path: "assets/screenshots/workbench.png" })
  }
  await expect(
    page.getByRole("button", { name: "导出 JSON", exact: true })
  ).toBeHidden()
  await page.getByRole("button", { name: "导出任务报告", exact: true }).click()
  await page.getByRole("button", { name: "导出 JSON", exact: true }).click()
  await expect(
    page.getByText("报告文件：C:/fixtures/reports/result.json")
  ).toBeVisible()
  const report = await page.evaluate(
    () => window.__ARC_TEST__.reports[0].report
  )
  expect(report.paths).toBeUndefined()
  expect(JSON.stringify(report)).not.toContain(task.recoveredPassword)
  await page.getByRole("checkbox", { name: "包含文件路径" }).check()
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
  await expect(
    page.getByRole("button", { name: "按顺序处理 1 项" })
  ).toBeEnabled()
  expect(await page.evaluate(() => window.__ARC_TEST__.starts)).toEqual([])
  await expect(page.getByLabel("记住任务队列")).toBeHidden()
  await page.getByRole("button", { name: "打开解压选项" }).click()
  await expect(page.getByText(/已找回 2 项/)).toBeVisible()
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
  await expect(page.getByLabel("记住任务队列")).toBeHidden()
  await page.getByRole("button", { name: "打开解压选项" }).click()
  await expect(
    page.getByRole("dialog").getByLabel("记住任务队列")
  ).toBeDisabled()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true)
  expect(errors).toEqual([])
})

test("参考后缀标签支持多选、回车和按钮添加、自定义去重及切页保留", async ({
  page,
}) => {
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto("/")
  await page.getByRole("button", { name: "压缩", exact: true }).click()
  await page
    .getByRole("switch", { name: "使用 AI 优化名称", exact: true })
    .check()
  await page.getByRole("switch", { name: "参考文件内容", exact: true }).check()
  const suffixes = page.getByRole("group", {
    name: "选择参考文件后缀",
    exact: true,
  })
  const tag = (suffix) =>
    suffixes.getByRole("button", { name: suffix, exact: true })
  await expect(tag(".txt")).toHaveAttribute("aria-pressed", "true")
  await expect(tag(".md")).toHaveAttribute("aria-pressed", "true")
  await tag(".json").click()
  await tag(".txt").click()
  await expect(tag(".json")).toHaveAttribute("aria-pressed", "true")
  await expect(tag(".md")).toHaveAttribute("aria-pressed", "true")
  await expect(tag(".txt")).toHaveAttribute("aria-pressed", "false")
  const custom = page.getByRole("textbox", { name: "自定义后缀", exact: true })
  await custom.fill("*.RST")
  await custom.press("Enter")
  await expect(tag(".rst")).toHaveAttribute("aria-pressed", "true")
  await expect(custom).toHaveValue("")
  await custom.fill(".rst, custom")
  await page.getByRole("button", { name: "添加后缀标签", exact: true }).click()
  await expect(tag(".rst")).toHaveCount(1)
  await expect(tag(".custom")).toHaveAttribute("aria-pressed", "true")
  await page
    .getByRole("button", { name: "删除 .custom 标签", exact: true })
    .click()
  await expect(tag(".custom")).toHaveCount(0)
  await expect(custom).toBeFocused()
  await expect(tag(".md")).toHaveAttribute("aria-pressed", "true")
  await custom.fill("custom")
  await custom.press("Enter")
  await expect(tag(".custom")).toHaveAttribute("aria-pressed", "true")
  await tag(".rst").focus()
  await page.keyboard.press("Space")
  await expect(tag(".rst")).toHaveAttribute("aria-pressed", "false")
  await page.getByRole("button", { name: "解压", exact: true }).click()
  await page.getByRole("button", { name: "压缩", exact: true }).click()
  await expect(tag(".rst")).toHaveAttribute("aria-pressed", "false")
  await expect(tag(".custom")).toHaveAttribute("aria-pressed", "true")
  await custom.fill("../txt")
  await custom.press("Enter")
  await expect(custom).toHaveAttribute("aria-invalid", "true")
  await expect(
    page.getByText("请输入有效后缀，例如 txt、.md 或 *.json。", { exact: true })
  ).toBeVisible()
  await custom.fill("rst")
  await expect(custom).toHaveAttribute("aria-invalid", "false")
  await page.setViewportSize({ width: 960, height: 640 })
  await custom.scrollIntoViewIfNeeded()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true)
  await page.screenshot({ path: "test-results/ai-reference-tags.png" })
  expect(errors).toEqual([])
})

test("字节流跟随运行和等待密码状态，后台暂停后从原位置恢复", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await mockDesktop(page, undefined, {
    ...task,
    phase: "internal",
    running: true,
    completed: false,
    success: false,
  })
  await page.goto("/")
  const stream = page.locator(".byte-stream")
  await expect(stream).toHaveAttribute("data-activity", "running")
  await page.evaluate(() => window.dispatchEvent(new Event("focus")))
  await expect(stream).toHaveAttribute("data-paused", "false")
  await expect
    .poll(() =>
      stream.evaluate(
        (e) => e.getAnimations({ subtree: true })[0]?.playbackRate
      )
    )
    .toBe(1.15)
  await page.evaluate(() => window.dispatchEvent(new Event("blur")))
  await expect(stream).toHaveAttribute("data-paused", "false")
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    })
    document.dispatchEvent(new Event("visibilitychange"))
  })
  await expect(stream).toHaveAttribute("data-paused", "true")
  const time = await stream.evaluate(async (e) => {
    const animation = e.getAnimations({ subtree: true })[0]
    await animation.ready
    return animation.currentTime
  })
  await page.waitForTimeout(200)
  expect(
    await stream.evaluate(
      (e) => e.getAnimations({ subtree: true })[0].currentTime
    )
  ).toBe(time)
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    })
    document.dispatchEvent(new Event("visibilitychange"))
  })
  await expect
    .poll(() =>
      stream.evaluate((e) => e.getAnimations({ subtree: true })[0].currentTime)
    )
    .toBeGreaterThan(time)
  await page.evaluate((next) => window.__ARC_TEST__.setTask(next), {
    ...task,
    phase: "exhausted",
    running: false,
    success: false,
  })
  await expect(stream).toHaveAttribute("data-activity", "waiting")
  await expect
    .poll(() =>
      stream.evaluate(
        (e) => e.getAnimations({ subtree: true })[0]?.playbackRate
      )
    )
    .toBe(0.35)
  await page.emulateMedia({ reducedMotion: "reduce" })
  await expect
    .poll(() =>
      stream.evaluate((e) => e.getAnimations({ subtree: true }).length)
    )
    .toBe(0)
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await expect
    .poll(() =>
      stream.evaluate(
        (e) => e.getAnimations({ subtree: true })[0]?.playbackRate
      )
    )
    .toBe(0.35)
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "压缩", exact: true })
    .click()
  await expect(stream).toHaveAttribute("data-activity", "idle")
})

test("解压舞台区分等待密码、完成和仍有待处理项", async ({ context }) => {
  for (const [label, next] of [
    ["需要密码", { ...task, phase: "exhausted", success: false }],
    ["解压完成，仍有待处理项", task],
    [
      "解压完成",
      {
        ...task,
        pendingArchivePaths: [],
        skippedArchivePaths: [],
        skippedNestedArchiveCount: 0,
        scanInterrupted: false,
      },
    ],
  ]) {
    const page = await context.newPage()
    await page.setViewportSize({ width: 1440, height: 900 })
    await mockDesktop(page, undefined, next)
    await page.goto("/")
    await expect(page.locator(".byte-archive-heading .byte-lead")).toHaveText(
      label
    )
    if (next.success)
      await expect(page.getByLabel("本次任务统计")).toBeVisible()
    else await expect(page.getByLabel("本次任务统计")).toHaveCount(0)
    await page.setViewportSize({ width: 390, height: 844 })
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth
      )
    ).toBe(true)
    if (next.success)
      await expect(
        page.getByRole("button", { name: "打开解压文件夹", exact: true })
      ).toBeVisible()
    await page.close()
  }
})

test("完成后收起重试与层级，主要结果留在首屏且可重新填写密码", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await mockDesktop(page)
  await page.goto("/")
  await expect(page.locator("[data-slot=recovery-result]")).toBeVisible()
  await page.evaluate(() => {
    const data = new DataTransfer()
    data.setData("text/plain", "C:/fixtures/中文目录/多层归档.zip")
    window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data }))
  })
  await expect(page.getByLabel("已知密码（可选）")).toBeVisible()
  await page
    .getByRole("button", { name: "开始恢复并解压", exact: true })
    .click()
  await expect(
    page.getByText("重新解压 / 修改密码与策略", { exact: true })
  ).toBeVisible()
  await expect(page.getByLabel("已知密码（可选）")).toBeHidden()
  await expect(page.locator("[data-slot=archive-stage]")).toBeHidden()
  const content = page.locator(
    '[data-workbench="extract"] [data-slot="workbench-page-content"]'
  )
  await content.evaluate((el) => {
    el.scrollTop = 0
  })
  await expect(
    page.getByRole("button", { name: "打开解压文件夹", exact: true })
  ).toBeInViewport()
  await page.getByText("归档层级与处理状态", { exact: true }).click()
  await expect(page.locator("[data-slot=archive-stage]")).toBeVisible()
  await page.getByText("重新解压 / 修改密码与策略", { exact: true }).click()
  await page.getByLabel("已知密码（可选）").fill("retry-password")
  await expect(
    page.getByRole("button", { name: "开始恢复并解压", exact: true })
  ).toBeEnabled()
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await content.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true
  )
})
