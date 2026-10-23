import assert from "node:assert/strict"
import { join } from "node:path"
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { expect } from "@playwright/test"

// Runs inside the existing isolated Tauri/WebView2 harness. Every command below
// reaches the real Rust implementation and bundled 7-Zip; no IPC is replaced.
export async function verifyBatchWorkflows({
  invoke,
  page,
  archive,
  password,
  data,
  evidence,
}) {
  const fixture = join(data, "[测试分组] 批量完整性检查")
  await mkdir(fixture, { recursive: true })
  const payload = join(fixture, "资料.txt")
  await writeFile(payload, "batch integrity fixture\n")
  const plain = join(fixture, "普通归档.7z")
  const afterFailure = join(fixture, "失败后继续.7z")
  const encrypted = join(fixture, "加密归档.dll")
  const damaged = join(fixture, "损坏归档.7z")
  const missing = join(fixture, "不存在的归档.7z")
  const sevenZip =
    process.env.ARC_RECALL_TEST_7ZIP ?? "C:/Program Files/7-Zip/7z.exe"
  const created = spawnSync(sevenZip, ["a", "-t7z", plain, payload], {
    windowsHide: true,
    encoding: "utf8",
  })
  assert.equal(created.status, 0, created.stderr)
  await copyFile(plain, afterFailure)
  await copyFile(archive, encrypted)
  const bytes = await readFile(plain)
  await writeFile(damaged, bytes.subarray(0, Math.floor(bytes.length / 2)))

  const paths = [plain, encrypted, damaged, missing, afterFailure]
  const id = crypto.randomUUID()
  assert.equal(await invoke("archive_batch_check_status", { id }), null)
  const checked = await invoke("archive_batch_check_run", {
    id,
    paths,
    password: "wrong-batch-password",
  })
  assert.equal(checked.running, false)
  assert.equal(checked.cancelled, false)
  assert.deepEqual(
    checked.items.map((item) => item.state),
    ["passed", "failed", "failed", "failed", "passed"]
  )
  assert.deepEqual(await invoke("archive_batch_check_status", { id }), checked)
  assert.ok(checked.items.every((item) => item.elapsedMs >= 0))
  assert.ok(checked.items.every((item) => item.checkedAtMs > 0))

  const retried = await invoke("archive_batch_check_run", {
    id,
    paths,
    password,
    retryFailed: true,
  })
  assert.deepEqual(
    retried.items.map((item) => item.state),
    ["passed", "passed", "failed", "failed", "passed"]
  )
  for (const index of [0, 4]) {
    assert.equal(
      retried.items[index].checkedAtMs,
      checked.items[index].checkedAtMs
    )
    assert.equal(retried.items[index].elapsedMs, checked.items[index].elapsedMs)
  }
  assert.ok(retried.items[1].checkedAtMs >= checked.items[1].checkedAtMs)
  for (const format of ["json", "csv"]) {
    const report = await invoke("archive_batch_check_export", {
      id,
      format,
      includePaths: false,
    })
    const contents = await readFile(report, "utf8")
    assert.ok(!contents.includes(password), "Batch report leaked a password")
    assert.ok(!contents.includes("wrong-batch-password"))
    assert.ok(!contents.includes(fixture), "Default report contains a path")
    assert.ok(!contents.includes(JSON.stringify(fixture).slice(1, -1)))
    if (format === "json") {
      const parsed = JSON.parse(contents.replace(/^\uFEFF/, ""))
      assert.equal(parsed.items.length, paths.length)
      assert.ok(parsed.items.every((item) => !("path" in item)))
      assert.deepEqual(
        parsed.items.map((item) => item.state),
        retried.items.map((item) => item.state)
      )
    }
  }
  const pathReport = await invoke("archive_batch_check_export", {
    id,
    format: "csv",
    includePaths: true,
  })
  const pathCsv = await readFile(pathReport, "utf8")
  assert.ok(pathCsv.includes(plain))
  assert.ok(pathCsv.includes(missing))
  assert.ok(!pathCsv.includes(password))

  const split = join(data, "[测试分组] 扫描目录", "分卷归档.7z")
  const grouped = await invoke("archive_batch_check_run", {
    id: crypto.randomUUID(),
    paths: [split + ".002", split + ".001", split + ".002"],
    password: null,
  })
  assert.equal(grouped.items.length, 1)
  assert.equal(grouped.items[0].path, split + ".001")
  assert.equal(grouped.items[0].state, "passed")

  // Distinct encrypted copies keep genuine 7-Zip checks busy long enough to
  // observe a completed item, verify the native action gate and then cancel.
  const cancellationPaths = [plain]
  for (let index = 0; index < 32; index++) {
    const path = join(fixture, `可取消归档-${index}.7z`)
    await copyFile(archive, path)
    cancellationPaths.push(path)
  }
  const cancelled = await page.evaluate(
    async ({ paths, archive, password, fixture }) => {
      const invoke = (command, args) =>
        window.__TAURI_INTERNALS__.invoke(command, args)
      const id = crypto.randomUUID()
      const pending = invoke("archive_batch_check_run", {
        id,
        paths,
        password,
      }).then(
        (value) => ({ value }),
        (error) => ({ error: String(error) })
      )
      let observed
      for (let count = 0; count < 1000; count++) {
        observed = await invoke("archive_batch_check_status", { id })
        if (observed?.running && observed.items[0]?.state === "passed") break
        if (observed && !observed.running) break
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      const rejections = []
      for (const [command, args] of [
        [
          "archive_folder_scan",
          { id: crypto.randomUUID(), path: fixture, includeSubfolders: false },
        ],
        [
          "archive_action_run",
          {
            id: crypto.randomUUID(),
            request: {
              path: archive,
              password,
              selectedPaths: null,
              outputParent: null,
            },
          },
        ],
        [
          "archive_batch_check_run",
          { id: crypto.randomUUID(), paths: [archive], password },
        ],
        [
          "recovery_start",
          {
            request: {
              archivePath: archive,
              knownPassword: password,
              recursive: false,
              computeMode: "cpuOnly",
              avoidOutputCollision: true,
            },
          },
        ],
      ]) {
        try {
          await invoke(command, args)
          rejections.push({ command, error: null })
        } catch (error) {
          rejections.push({ command, error: String(error) })
        }
      }
      await invoke("archive_action_cancel", { id })
      return { observed, rejections, completion: await pending }
    },
    { paths: cancellationPaths, archive, password, fixture }
  )
  assert.equal(cancelled.observed?.running, true)
  assert.equal(cancelled.observed.items[0].state, "passed")
  assert.ok(
    cancelled.rejections.every((item) => item.error),
    JSON.stringify(cancelled.rejections)
  )
  for (const item of cancelled.rejections)
    assert.match(
      item.error,
      /正在|进行/,
      `${item.command} must reject because the native gate is busy`
    )
  assert.equal(cancelled.completion.error, undefined)
  const stopped = cancelled.completion.value
  assert.equal(stopped.cancelled, true)
  assert.equal(stopped.running, false)
  assert.equal(stopped.items.length, cancellationPaths.length)
  assert.equal(stopped.items[0].state, "passed")
  assert.equal(
    stopped.items[0].checkedAtMs,
    cancelled.observed.items[0].checkedAtMs
  )
  assert.ok(stopped.items.some((item) => item.state === "cancelled"))
  assert.ok(
    stopped.items.some(
      (item) =>
        item.state === "cancelled" &&
        item.checkedAtMs === null &&
        item.elapsedMs === 0
    )
  )
  assert.ok(
    stopped.items.every((item) => !["waiting", "checking"].includes(item.state))
  )
  // Completion releases the native gate for the next real operation.
  const next = await invoke("archive_batch_check_run", {
    id: crypto.randomUUID(),
    paths: [plain],
    password: null,
  })
  assert.equal(next.items[0].state, "passed")
  console.log(
    "PASS: real mixed batch validation, failed-only retry, preserved prior results, redacted/opt-in reports, cancellation and native mutual exclusion"
  )

  await page.keyboard.press("Escape")
  await page.getByRole("button", { name: "解压", exact: true }).click()
  await page.evaluate(
    (paths) => {
      const clipboardData = new DataTransfer()
      clipboardData.setData("text/plain", paths.join("\n"))
      window.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData,
          bubbles: true,
          cancelable: true,
        })
      )
    },
    [plain, encrypted, afterFailure]
  )
  const queue = page.getByRole("region", { name: "批次队列", exact: true })
  await expect(queue).toBeVisible()
  for (const name of ["普通归档.7z", "加密归档.dll"])
    await queue
      .getByRole("checkbox", { name: `选择队列项 ${name}`, exact: true })
      .check()
  await queue
    .getByRole("button", { name: "批量检查完整性", exact: true })
    .click()
  const dialog = page.getByRole("dialog", {
    name: "批量完整性检查",
    exact: true,
  })
  await expect(dialog).toBeVisible()
  await dialog
    .getByLabel("本次检查密码", { exact: true })
    .fill("wrong-batch-password")
  await dialog.getByRole("button", { name: "开始检查", exact: true }).click()
  await expect(
    dialog.getByRole("button", { name: "仅重查未通过项", exact: true })
  ).toBeEnabled({ timeout: 30_000 })
  await dialog.getByLabel("本次检查密码", { exact: true }).fill(password)
  await dialog
    .getByRole("button", { name: "仅重查未通过项", exact: true })
    .click()
  await expect(dialog.getByRole("status")).toContainText(
    "检查结束 · 已检查 2/2 · 通过 2 · 未通过 0",
    { timeout: 30_000 }
  )
  await expect(
    dialog.getByRole("button", { name: "仅重查未通过项", exact: true })
  ).toBeDisabled({ timeout: 30_000 })
  await expect(dialog.getByLabel("本次检查密码", { exact: true })).toHaveValue(
    ""
  )
  await expect(
    dialog.getByRole("button", { name: "导出 JSON", exact: true })
  ).toBeEnabled()
  await dialog.getByRole("button", { name: "导出 JSON", exact: true }).click()
  await expect(dialog.getByText(/报告文件：/)).toBeVisible()
  await dialog
    .getByRole("checkbox", { name: "报告包含文件路径", exact: true })
    .check()
  await dialog.getByRole("button", { name: "导出 CSV", exact: true }).click()
  await expect(dialog.getByText(/报告文件：.*\.csv/)).toBeVisible()
  await page.screenshot({
    path: join(evidence, "native-batch-integrity.png"),
    animations: "disabled",
  })
  await page.keyboard.press("Escape")
  console.log(
    "PASS: real WebView queue entry, password correction, failed-only retry and batch report controls"
  )

  await page.getByRole("button", { name: "打开解压选项" }).click()
  await page.getByLabel("记住任务队列", { exact: true }).click()
  await expect(page.getByLabel("记住任务队列", { exact: true })).toBeChecked()
  await page.keyboard.press("Escape")
  await queue.getByRole("button", { name: "清除选择", exact: true }).click()
  await queue
    .getByRole("checkbox", { name: "选择队列项 失败后继续.7z", exact: true })
    .check()
  await queue
    .getByRole("button", { name: "移除所选 1 项", exact: true })
    .click()
  await expect(queue.getByRole("listitem")).toHaveCount(2)
  await queue
    .getByRole("button", { name: "上移 加密归档.dll", exact: true })
    .click()
  await expect(queue.getByRole("listitem").first()).toContainText(
    "加密归档.dll"
  )
  await queue.getByRole("button", { name: "选择等待项", exact: true }).click()
  await queue
    .getByRole("button", { name: "为所选等待项应用预设", exact: true })
    .click()
  const presets = page.getByRole("dialog", {
    name: "为等待项应用预设",
    exact: true,
  })
  await presets
    .getByRole("combobox", { name: "队列处理预设", exact: true })
    .click()
  await page.getByRole("option", { name: "资料处理", exact: true }).click()
  await presets
    .getByRole("button", { name: "确认应用到所选等待项", exact: true })
    .click()
  await expect(presets).not.toBeVisible()
  await expect
    .poll(async () => {
      const journal = await invoke("recovery_queue_load")
      return journal.items.map((item) => ({
        path: item.path,
        outputDirectory: item.options?.outputDirectory,
        computeMode: item.options?.computeMode,
        recursive: item.options?.recursive,
      }))
    })
    .toEqual(
      [encrypted, plain].map((path) => ({
        path,
        outputDirectory: join(data, "[测试分组] 扫描目录"),
        computeMode: "cpuOnly",
        recursive: true,
      }))
    )
  await queue
    .getByLabel("本批次优先密码（可选）", { exact: true })
    .fill(password)
  await queue
    .getByRole("button", { name: "按顺序处理 2 项", exact: true })
    .click()
  await queue
    .getByRole("button", { name: "当前项完成后暂停", exact: true })
    .click()
  await expect(
    queue.getByRole("button", { name: "继续处理 1 项", exact: true })
  ).toBeEnabled({ timeout: 60_000 })
  await expect
    .poll(async () =>
      (await invoke("recovery_queue_load")).items.map((item) => item.state)
    )
    .toEqual(["success", "waiting"])
  const completedBeforePause = await invoke("recovery_status", { taskId: null })
  assert.equal(completedBeforePause.success, true)
  assert.equal(completedBeforePause.running, false)
  assert.equal(completedBeforePause.cancelled, false)
  await page.screenshot({
    path: join(evidence, "native-queue-paused.png"),
    animations: "disabled",
  })
  await queue
    .getByRole("button", { name: "继续处理 1 项", exact: true })
    .click()
  await expect
    .poll(
      async () =>
        (await invoke("recovery_queue_load")).items.map((item) => item.state),
      { timeout: 60_000 }
    )
    .toEqual(["success", "success"])
  await expect(
    queue.getByRole("button", { name: "暂无待处理任务", exact: true })
  ).toBeDisabled()
  assert.ok(
    !(await readFile(join(data, "recovery-queue.json"), "utf8")).includes(
      password
    )
  )
  await page.screenshot({
    path: join(evidence, "native-queue-management.png"),
    animations: "disabled",
  })
  console.log(
    "PASS: real queue ordering, bulk removal, preset snapshots, finish-current pause, resume and secret-free journal"
  )
}
