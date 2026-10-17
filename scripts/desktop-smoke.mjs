// Real Windows Tauri + WebView2 + Rust IPC + 7-Zip. No mocked native commands.
// CDP setup follows https://playwright.dev/docs/webview2 .
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import {
  mkdtemp,
  mkdir,
  copyFile,
  writeFile,
  readFile,
  readdir,
  access,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createServer } from "node:net"
import { chromium, expect } from "@playwright/test"

if (process.platform !== "win32")
  throw new Error("This suite requires Windows and WebView2.")
const binary = resolve(
  process.env.ARC_RECALL_TEST_BINARY ??
    "target/native-e2e/debug/arc-recall-desktop.exe"
)
const sevenZip =
  process.env.ARC_RECALL_TEST_7ZIP ?? "C:/Program Files/7-Zip/7z.exe"
await access(binary)
await access(sevenZip)
const root = await mkdtemp(join(tmpdir(), "arc-recall-desktop-e2e-"))
const evidence = resolve("test-results/native")
await mkdir(evidence, { recursive: true })
const data = join(root, "data")
const tools = join(data, "tools", "7zip", "26.02")
await mkdir(tools, { recursive: true })
await copyFile(sevenZip, join(tools, "7z.exe"))
await copyFile(join(sevenZip, "..", "7z.dll"), join(tools, "7z.dll"))
await writeFile(
  join(data, "settings.json"),
  JSON.stringify({
    autoUpdate: false,
    recovery: { computeMode: "cpuOnly", scanMaxFilesPerDirectory: 0 },
  })
)
const payload = join(root, "payload.txt")
const archive = join(root, "literal-password.7z")
const pending = join(root, "pending.7z")
const changed = join(root, "changed.7z")
const password = "$HEX[616263]"
await writeFile(payload, "ArcRecall isolated native test\n")
const created = spawnSync(
  sevenZip,
  ["a", "-t7z", "-mhe=on", `-p${password}`, archive, payload],
  { windowsHide: true, encoding: "utf8" }
)
assert.equal(created.status, 0, created.stderr)
await copyFile(archive, pending)
await copyFile(archive, changed)

let child, browser, page
const errors = []
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
const invoke = (command, args = {}) =>
  page.evaluate(
    ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args),
    { command, args }
  )
async function launch() {
  const server = createServer().listen(0, "127.0.0.1")
  await once(server, "listening")
  const port = server.address().port
  await new Promise((done) => server.close(done))
  child = spawn(binary, [], {
    windowsHide: true,
    env: {
      ...process.env,
      ARC_RECALL_TEST_DATA_ROOT: data,
      WEBVIEW2_USER_DATA_FOLDER: join(root, `webview-${port}`),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
    stdio: "ignore",
  })
  child.on("error", (error) => errors.push(error.message))
  let ready = false
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null)
      throw new Error(`Desktop exited: ${child.exitCode}`)
    try {
      ready = (await fetch(`http://127.0.0.1:${port}/json/version`)).ok
    } catch {
      /* WebView startup */
    }
    if (ready) break
    await delay(200)
  }
  assert.ok(ready, "WebView2 CDP did not start")
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  const context = browser.contexts()[0]
  page =
    context
      .pages()
      .find((candidate) => /tauri|localhost/.test(candidate.url())) ??
    context.pages()[0] ??
    (await context.waitForEvent("page"))
  page.on("pageerror", (error) => errors.push(error.message))
  await expect(page.getByLabel("记住任务队列")).toBeEnabled({ timeout: 30_000 })
  const info = await invoke("database_info")
  assert.equal(
    resolve(info.rootPath),
    resolve(data),
    "Refusing to test against a non-isolated data root"
  )
}
async function close(requireGraceful = true) {
  if (!child) return
  const exit = once(child, "exit")
  // Exercise the real native close event without broadening production IPC permissions.
  spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `[Diagnostics.Process]::GetProcessById(${child.pid}).CloseMainWindow()`,
    ],
    { windowsHide: true, stdio: "ignore" }
  )
  await Promise.race([exit, delay(8000)])
  const forced = child.exitCode === null
  if (forced) {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    })
    await exit
  }
  await browser?.close().catch(() => {})
  child = null
  browser = null
  page = null
  if (requireGraceful)
    assert.equal(forced, false, "Desktop did not finish graceful shutdown")
}
async function pastePaths(paths) {
  await page.evaluate((paths) => {
    const clipboardData = new DataTransfer()
    clipboardData.setData("text/plain", paths.join("\n"))
    window.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData,
        bubbles: true,
        cancelable: true,
      })
    )
  }, paths)
}

try {
  await launch()
  assert.equal((await invoke("recovery_queue_load")).enabled, false)
  await page.getByLabel("记住任务队列").click()
  await expect(page.getByLabel("记住任务队列")).toBeChecked()
  await pastePaths([archive, pending, changed])
  await expect(
    page.getByRole("button", { name: "按顺序处理 3 项" })
  ).toBeEnabled()
  await expect
    .poll(
      async () =>
        JSON.parse(await readFile(join(data, "recovery-queue.json"), "utf8"))
          .items.length
    )
    .toBe(3)
  await close()
  await writeFile(
    changed,
    Buffer.concat([await readFile(changed), Buffer.from("changed")])
  )
  await launch()
  await expect(page.getByText(/已找回 3 项/)).toBeVisible()
  await expect(
    page.getByText("源文件或分卷的大小、修改时间已改变，请移除后重新添加。")
  ).toBeVisible()
  await page
    .getByRole("button", { name: "移除 changed.7z", exact: true })
    .click()
  assert.equal(
    await invoke("recovery_status", { taskId: null }),
    null,
    "Restored queue must not start itself"
  )
  await page.getByRole("button", { name: "打开解压选项" }).click()
  await page.getByRole("switch", { name: "完成后打开输出文件夹" }).uncheck()
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "关闭", exact: true })
    .click()
  await page.getByLabel("本批次优先密码（可选）").fill(password)
  await page.getByRole("button", { name: "按顺序处理 2 项" }).click()
  await expect
    .poll(
      async () => {
        const journal = JSON.parse(
          await readFile(join(data, "recovery-queue.json"), "utf8")
        )
        return journal.items.map((item) => item.state)
      },
      { timeout: 60_000 }
    )
    .toEqual(["success", "success"])
  const status = await invoke("recovery_status", { taskId: null })
  assert.equal(status.success, true)
  assert.equal(status.recoveredPassword, password)
  assert.equal(
    await readFile(join(status.outputDirectory, "payload.txt"), "utf8"),
    "ArcRecall isolated native test\n"
  )
  assert.ok(
    !(await readFile(join(data, "recovery-queue.json"), "utf8")).includes(
      password
    )
  )
  await page.getByRole("button", { name: "复制恢复密码", exact: true }).click()
  await expect(
    page
      .locator("[data-sonner-toaster]")
      .getByText("密码已复制", { exact: true })
  ).toBeVisible()
  await page.getByRole("button", { name: "导出任务报告", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "导出 JSON", exact: true })
  ).toBeVisible()
  await page.getByRole("button", { name: "导出 JSON", exact: true }).click()
  await expect(page.getByText(/报告文件：/)).toBeVisible()
  await page.getByRole("button", { name: "导出 CSV", exact: true }).click()
  await expect(page.getByText(/报告文件：.*\.csv/)).toBeVisible()
  for (const name of await readdir(join(data, "exports"))) {
    const content = await readFile(join(data, "exports", name), "utf8")
    assert.ok(!content.includes(password), "Report contains password")
    assert.ok(
      !content.includes("literal-password"),
      "Default report contains source path"
    )
    if (name.endsWith(".json"))
      assert.equal(JSON.parse(content).summary.status, "success")
  }
  await page.screenshot({ path: join(evidence, "native-result.png") })
  const history = await invoke("history_list", {
    query: { searchText: "literal-password", skip: 0, take: 100 },
  })
  assert.equal(
    history.totalCount,
    1,
    "Identical archive contents share a history record"
  )
  assert.equal(history.matchedCount, 1)
  const savedArchive = history.entries[0]
  assert.equal(
    savedArchive.archiveName,
    "literal-password.7z",
    "Keep the first recorded name after a renamed copy succeeds"
  )
  assert.equal(resolve(savedArchive.archivePath), resolve(pending))
  assert.equal(
    resolve(savedArchive.outputDirectory),
    resolve(status.outputDirectory)
  )
  await close()
  await launch()
  await page.getByRole("button", { name: "历史", exact: true }).click()
  const historyTable = page.getByRole("table")
  await expect(
    historyTable.getByText("literal-password.7z", { exact: true })
  ).toBeVisible()
  await expect(
    historyTable.getByText(savedArchive.archivePath, { exact: true })
  ).toBeVisible()
  await expect(
    historyTable.getByText(savedArchive.outputDirectory, { exact: true })
  ).toBeVisible()
  await page.getByRole("button", { name: "查看密码", exact: true }).click()
  await expect(
    historyTable.locator("code").filter({ hasText: password })
  ).toBeVisible()
  const historySearch = page.getByRole("searchbox", {
    name: "搜索压缩包名称或路径",
  })
  await historySearch.fill("pending.7z")
  await historySearch.press("Enter")
  await expect(
    historyTable.getByText("literal-password.7z", { exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "查看密码", exact: true })
  ).toBeVisible()
  await page
    .getByRole("button", { name: "复制压缩包路径", exact: true })
    .click()
  await expect(
    page
      .locator("[data-sonner-toaster]")
      .getByText("路径已复制", { exact: true })
  ).toBeVisible()
  await page.screenshot({ path: join(evidence, "native-history.png") })
  await page.getByRole("button", { name: "解压", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "暂无待处理任务", exact: true })
  ).toBeDisabled()
  await page.getByLabel("记住任务队列").click()
  await expect(page.getByLabel("记住任务队列")).not.toBeChecked()
  await expect
    .poll(async () => {
      try {
        await access(join(data, "recovery-queue.json"))
        return true
      } catch {
        return false
      }
    })
    .toBe(false)
  // Exercise the real setting, IPC and filesystem cleanup for nested outputs.
  const cleanupSource = join(root, "cleanup-source")
  const cleanupInput = join(root, "cleanup-input")
  await mkdir(join(cleanupSource, "empty", "a", "b"), { recursive: true })
  await mkdir(join(cleanupSource, "keep"), { recursive: true })
  await writeFile(join(cleanupSource, "keep", ".hidden"), "keep hidden file")
  await writeFile(join(cleanupSource, "zero.txt"), "")
  await mkdir(join(cleanupInput, "empty", "a", "b"), { recursive: true })
  const cleanupArchive = join(root, "cleanup.7z")
  for (const [archivePath, source] of [
    [join(cleanupInput, "inner.7z"), cleanupSource],
    [cleanupArchive, cleanupInput],
  ]) {
    const packed = spawnSync(sevenZip, ["a", "-t7z", archivePath, source], {
      windowsHide: true,
      encoding: "utf8",
    })
    assert.equal(packed.status, 0, packed.stderr)
  }
  await page.getByRole("button", { name: "设置", exact: true }).click()
  const cleanupSwitch = page.getByRole("switch", { name: "智能清理空文件夹" })
  await expect(cleanupSwitch).toBeEnabled()
  await expect(cleanupSwitch).toBeChecked()
  const flattenSwitch = page.getByRole("switch", { name: "去除多层无效嵌套" })
  await expect(flattenSwitch).toBeChecked()
  // Exercise explicit opt-out while verifying empty-folder cleanup separately.
  await flattenSwitch.click()
  await expect
    .poll(
      async () =>
        (await invoke("settings_get")).recovery.flattenOutputDirectories
    )
    .toBe(false)
  await expect(flattenSwitch).toBeEnabled()
  for (const enabled of [false, true]) {
    // Verify keyboard activation as well as the pointer interaction.
    if (enabled) await cleanupSwitch.click()
    else {
      await cleanupSwitch.focus()
      await cleanupSwitch.press("Space")
    }
    await expect
      .poll(
        async () =>
          (await invoke("settings_get")).recovery.removeEmptyDirectories
      )
      .toBe(enabled)
    await expect(cleanupSwitch).toBeEnabled()
    const outputDirectory = join(root, `cleanup-output-${enabled}`)
    await mkdir(join(outputDirectory, "cleanup-input", "existing", "empty"), {
      recursive: true,
    })
    const started = await invoke("recovery_start", {
      request: {
        archivePath: cleanupArchive,
        outputDirectory,
        recursive: true,
        computeMode: "cpuOnly",
        avoidOutputCollision: false,
      },
    })
    await expect
      .poll(
        async () =>
          (await invoke("recovery_status", { taskId: started.taskId }))
            .completed,
        { timeout: 30_000 }
      )
      .toBe(true)
    const cleaned = await invoke("recovery_status", { taskId: started.taskId })
    assert.equal(cleaned.success, true, cleaned.message)
    assert.equal(cleaned.extractedNestedArchiveCount, 1)
    const nested = join(
      outputDirectory,
      "cleanup-input",
      "inner",
      "cleanup-source"
    )
    for (const empty of [
      join(outputDirectory, "cleanup-input", "empty"),
      join(nested, "empty"),
    ]) {
      if (enabled) await assert.rejects(access(empty), { code: "ENOENT" })
      else await access(join(empty, "a", "b"))
    }
    await access(join(outputDirectory, "cleanup-input", "existing", "empty"))
    assert.equal(
      await readFile(join(nested, "keep", ".hidden"), "utf8"),
      "keep hidden file"
    )
    assert.equal((await readFile(join(nested, "zero.txt"))).length, 0)
    if (enabled) assert.match(cleaned.message, /已清理 6 个空文件夹/)
  }
  await expect(flattenSwitch).not.toBeChecked()
  await flattenSwitch.click()
  await expect
    .poll(
      async () =>
        (await invoke("settings_get")).recovery.flattenOutputDirectories
    )
    .toBe(true)
  await expect(flattenSwitch).toBeEnabled()
  const flatOutput = join(root, "flatten-output")
  const flatTask = await invoke("recovery_start", {
    request: {
      archivePath: cleanupArchive,
      outputDirectory: flatOutput,
      recursive: true,
      computeMode: "cpuOnly",
      avoidOutputCollision: true,
    },
  })
  await expect
    .poll(
      async () =>
        (await invoke("recovery_status", { taskId: flatTask.taskId }))
          .completed,
      { timeout: 30_000 }
    )
    .toBe(true)
  const flatResult = await invoke("recovery_status", {
    taskId: flatTask.taskId,
  })
  assert.equal(flatResult.success, true, flatResult.message)
  assert.equal(flatResult.extractedNestedArchiveCount, 1)
  assert.equal(
    await readFile(
      join(
        flatOutput,
        "cleanup-input",
        "inner",
        "cleanup-source",
        "keep",
        ".hidden"
      ),
      "utf8"
    ),
    "keep hidden file"
  )
  assert.equal(
    (
      await readFile(
        join(flatOutput, "cleanup-input", "inner", "cleanup-source", "zero.txt")
      )
    ).length,
    0
  )
  await access(join(flatOutput, "cleanup-input", "inner.7z"))
  assert.match(flatResult.message, /已去除 0 层多余嵌套/)
  for (const path of flatResult.contentDirectories) await access(path)
  // Exact repeated archive names may fold, but one original name and all
  // meaningful child paths must remain. Verify both settings against real IPC.
  const repeatedSource = join(root, "repeated")
  const innerSource = join(root, "inner")
  const innerContent = join(innerSource, "inner", "src", "main", "java")
  const photos = join(repeatedSource, "repeated", "照片", "2026", "旅行")
  const contents = Buffer.from([0, 255, 1, 128, 0, 42])
  await mkdir(innerContent, { recursive: true })
  await writeFile(join(innerContent, "data.bin"), contents)
  await writeFile(join(innerContent, "zero.txt"), "")
  await mkdir(join(innerSource, "inner", "empty", "leaf"), { recursive: true })
  await mkdir(photos, { recursive: true })
  await writeFile(join(photos, "photo.bin"), contents)
  await mkdir(join(repeatedSource, "repeated", "empty", "leaf"), {
    recursive: true,
  })
  const innerArchive = join(repeatedSource, "repeated", "inner.7z")
  const repeatedArchive = join(root, "repeated.7z")
  for (const [archivePath, source] of [
    [innerArchive, innerSource],
    [repeatedArchive, repeatedSource],
  ]) {
    const packed = spawnSync(sevenZip, ["a", "-t7z", archivePath, source], {
      windowsHide: true,
      encoding: "utf8",
    })
    assert.equal(packed.status, 0, packed.stderr)
  }
  const archiveBytes = await readFile(repeatedArchive)
  const innerBytes = await readFile(innerArchive)
  for (const enabled of [false, true]) {
    await flattenSwitch.click()
    await expect
      .poll(
        async () =>
          (await invoke("settings_get")).recovery.flattenOutputDirectories
      )
      .toBe(enabled)
    await expect(flattenSwitch).toBeEnabled()
    const outputDirectory = join(root, `repeated-output-${enabled}`)
    const started = await invoke("recovery_start", {
      request: {
        archivePath: repeatedArchive,
        outputDirectory,
        recursive: true,
        computeMode: "cpuOnly",
        avoidOutputCollision: true,
      },
    })
    await expect
      .poll(
        async () =>
          (await invoke("recovery_status", { taskId: started.taskId }))
            .completed,
        { timeout: 30_000 }
      )
      .toBe(true)
    const result = await invoke("recovery_status", { taskId: started.taskId })
    assert.equal(result.success, true, result.message)
    assert.equal(result.extractedNestedArchiveCount, 1)
    const outer = enabled
      ? join(outputDirectory, "repeated")
      : join(outputDirectory, "repeated", "repeated")
    const inner = enabled
      ? join(outer, "inner", "inner")
      : join(outer, "inner", "inner", "inner")
    assert.deepEqual(
      await readFile(join(outer, "照片", "2026", "旅行", "photo.bin")),
      contents
    )
    assert.deepEqual(
      await readFile(join(inner, "src", "main", "java", "data.bin")),
      contents
    )
    assert.equal(
      (await readFile(join(inner, "src", "main", "java", "zero.txt"))).length,
      0
    )
    assert.deepEqual(await readFile(join(outer, "inner.7z")), innerBytes)
    assert.deepEqual(await readFile(repeatedArchive), archiveBytes)
    assert.match(result.message, /已清理 4 个空文件夹/)
    assert.match(result.message, enabled ? /已去除 2 层多余嵌套/ : /已清理/)
    for (const path of result.contentDirectories) await access(path)
  }
  await page.screenshot({
    path: join(evidence, "native-empty-folder-settings.png"),
  })
  await close()
  await launch()
  assert.equal(
    (await invoke("settings_get")).recovery.removeEmptyDirectories,
    true
  )
  assert.equal(
    (await invoke("settings_get")).recovery.flattenOutputDirectories,
    true
  )
  // A distinct archive avoids successful-history reuse and stays busy on wrong candidates.
  const cancellable = join(root, "cancellable.7z")
  assert.equal(
    spawnSync(
      sevenZip,
      [
        "a",
        "-t7z",
        "-mhe=on",
        "-punknown-fixture-password",
        cancellable,
        payload,
      ],
      { windowsHide: true }
    ).status,
    0
  )
  await invoke("dictionary_add", {
    candidates: Array.from({ length: 500 }, (_, index) => `wrong-${index}`),
  })
  const request = {
    archivePath: cancellable,
    outputDirectory: join(root, "cancel-output"),
    recursive: false,
    computeMode: "cpuOnly",
    avoidOutputCollision: true,
  }
  const cancelTask = await invoke("recovery_start", { request })
  assert.equal(
    await invoke("recovery_cancel", { taskId: cancelTask.taskId }),
    true
  )
  await expect
    .poll(
      async () =>
        (await invoke("recovery_status", { taskId: cancelTask.taskId }))
          ?.cancelled,
      { timeout: 15_000 }
    )
    .toBe(true)
  // Window close must cancel and join the active native worker before deleting its workspace.
  await invoke("recovery_start", { request })
  await close()
  const sessionRoot = join(data, "temp", "recovery-sessions")
  for (const name of await readdir(sessionRoot)) {
    if (name.startsWith("session-"))
      assert.deepEqual(await readdir(join(sessionRoot, name)), ["owner.lock"])
    else assert.equal(name, "cleanup.lock")
  }
  assert.deepEqual(errors, [])
  console.log(
    `PASS: native UI / Rust IPC / restart / changed source / real 7-Zip / report files / empty-folder cleanup / wrapper flattening / cancellation / close cleanup. Screenshots: ${evidence}`
  )
} catch (error) {
  console.error(error)
  if (page)
    console.error(
      await page
        .locator("body")
        .innerText()
        .catch(() => "Page unavailable")
    )
  if (page)
    await page
      .screenshot({ path: join(evidence, "failure.png") })
      .catch(() => {})
  throw error
} finally {
  await close(false)
  // Keep isolated evidence for inspection. Never delete arbitrary user-provided paths.
  console.log(`Isolated test data: ${root}`)
}
