// Drives the real Tauri WebView, Rust workers and isolated 7-Zip processes.
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import {
  open,
  writeFile,
  mkdir,
  readdir,
  access,
  copyFile,
  readFile,
  unlink,
  stat,
} from "node:fs/promises"
import { join } from "node:path"
import { expect } from "@playwright/test"

export async function verifyNativeLifecycle({
  page,
  invoke,
  pastePaths,
  root,
  data,
  evidence,
  sevenZip,
  close,
  errors,
}) {
  const records = []
  const nav = (name) =>
    page
      .getByRole("navigation")
      .getByRole("button", { name, exact: true })
      .click()
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const processes = () => {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "$items = @(Get-CimInstance Win32_Process -Filter \"Name = '7z.exe'\" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($env:ARC_LIFECYCLE_ROOT, [StringComparison]::OrdinalIgnoreCase) } | Select-Object ProcessId,ParentProcessId,ExecutablePath); ConvertTo-Json -InputObject $items -Compress",
      ],
      {
        windowsHide: true,
        encoding: "utf8",
        env: { ...process.env, ARC_LIFECYCLE_ROOT: root },
      }
    )
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout || "[]")
  }
  const noWorkers = async () => {
    await expect.poll(processes, { timeout: 15000 }).toEqual([])
  }
  const logs = async () =>
    (await readFile(join(data, "logs", "arcrecall.log"), "utf8"))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  let baseline = 0
  const instrument = async () => {
    baseline = (await logs()).length
  }
  const count = async (command) =>
    (await logs())
      .slice(baseline)
      .filter(
        (entry) =>
          entry.event ===
          command
            .replace(/_start$/, ".started")
            .replace(/_cancel$/, ".cancel_requested")
      ).length
  const shot = (name) =>
    page.screenshot({ path: join(evidence, `native-${name}.png`) })
  const terminal = async (command, id) => {
    await expect
      .poll(async () => (await invoke(command, { taskId: id }))?.running, {
        timeout: 30000,
      })
      .toBe(false)
    const status = await invoke(command, { taskId: id })
    assert.equal(status.taskId, id)
    assert.equal(status.cancelled, true)
    assert.equal(status.success, false)
    await noWorkers()
    return status
  }
  const doubleClick = (locator) =>
    locator.evaluate((element) => {
      element.click()
      element.click()
    })
  console.log("Preparing isolated native cancellation fixtures")
  const source = join(root, "[测试分组] 中文目录")
  await mkdir(source)
  const payload = join(source, "压缩取消测试.bin")
  const file = await open(payload, "w")
  try {
    // A 256 MiB random file keeps a real compression worker busy across navigation.
    for (let i = 0; i < 64; i++) await file.write(randomBytes(4 * 1024 * 1024))
  } finally {
    await file.close()
  }
  await instrument()
  const compression = await invoke("compression_start", {
    request: {
      sources: [source],
      outputDirectory: root,
      baseName: "取消压缩验证",
      format: "sevenZip",
      level: 9,
      encryptFileNames: false,
    },
  })
  await nav("压缩")
  await expect(
    page.getByRole("button", { name: "取消压缩", exact: true })
  ).toBeVisible({ timeout: 15000 })
  const compressionWorkers = processes()
  assert.ok(
    compressionWorkers.length > 0,
    "Compression must reach a real 7-Zip worker"
  )
  await nav("字典")
  assert.equal(
    (await invoke("compression_status", { taskId: compression.taskId }))
      .running,
    true
  )
  await nav("压缩")
  await doubleClick(page.getByRole("button", { name: "取消压缩", exact: true }))
  await nav("历史")
  const compressionDone = await terminal(
    "compression_status",
    compression.taskId
  )
  await nav("压缩")
  await expect(
    page.getByRole("button", { name: "取消压缩", exact: true })
  ).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: "开始压缩", exact: true })
  ).toBeVisible()
  assert.equal(await count("compression_start"), 1)
  assert.equal(await count("compression_cancel"), 1)
  await assert.rejects(access(compression.outputPath))
  await shot("compression-cancelled-returned")
  records.push({
    scenario: "compression",
    workers: compressionWorkers,
    status: compressionDone,
    startCalls: 1,
    cancelCalls: 1,
  })
  console.log(
    "PASS compression: real worker cancelled, navigation synchronized, no duplicate or output residue"
  )

  await unlink(payload)
  const expanded = join(root, "解压写出测试.bin")
  const large = await open(expanded, "w")
  const block = Buffer.alloc(4 * 1024 * 1024)
  const pattern = randomBytes(65536)
  for (let offset = 0; offset < block.length; offset += pattern.length)
    pattern.copy(block, offset)
  try {
    for (let i = 0; i < 512; i++) await large.write(block)
  } finally {
    await large.close()
  }
  const writeArchive = join(root, "大文件归档.7z")
  const pack = spawn(
    sevenZip,
    ["a", "-t7z", "-mx=1", "-mmt=1", writeArchive, expanded],
    { windowsHide: true, stdio: "ignore" }
  )
  assert.equal((await once(pack, "exit"))[0], 0)
  await unlink(expanded)
  await instrument()
  const extracting = await invoke("recovery_start", {
    request: {
      archivePath: writeArchive,
      outputDirectory: join(root, "大文件输出"),
      recursive: false,
      computeMode: "cpuOnly",
      avoidOutputCollision: true,
    },
  })
  await page.reload()
  await expect(
    page.getByRole("button", { name: "取消任务", exact: true })
  ).toBeVisible({ timeout: 15000 })
  await expect
    .poll(
      async () =>
        (await invoke("recovery_status", { taskId: extracting.taskId }))?.phase,
      { timeout: 15000 }
    )
    .toBe("extracting")
  await nav("历史")
  const liveExtraction = await invoke("recovery_status", {
    taskId: extracting.taskId,
  })
  assert.equal(liveExtraction.running, true)
  assert.equal(liveExtraction.taskId, extracting.taskId)
  await nav("解压")
  await doubleClick(page.getByRole("button", { name: "取消任务", exact: true }))
  await nav("字典")
  const extractionDone = await terminal("recovery_status", extracting.taskId)
  await nav("解压")
  await expect(
    page.getByRole("button", { name: "取消任务", exact: true })
  ).toHaveCount(0)
  assert.equal(await count("recovery_start"), 1)
  assert.equal(await count("recovery_cancel"), 1)
  const outputEntries = async (directory) => {
    const entries = []
    for (const item of await readdir(directory, { withFileTypes: true }).catch(
      () => []
    )) {
      const path = join(directory, item.name)
      if (item.isDirectory()) entries.push(...(await outputEntries(path)))
      else {
        const info = await stat(path)
        entries.push({ path, size: info.size, mtimeMs: info.mtimeMs })
      }
    }
    return entries
  }
  const stoppedOutput = await outputEntries(join(root, "大文件输出"))
  await delay(1000)
  assert.deepEqual(
    await outputEntries(join(root, "大文件输出")),
    stoppedOutput,
    "Cancelled extraction must not keep writing files"
  )
  await shot("extraction-write-cancelled-returned")
  records.push({
    scenario: "extraction-write",
    livePhase: liveExtraction.phase,
    status: extractionDone,
    stableOutput: true,
    startCalls: 1,
    cancelCalls: 1,
  })
  console.log(
    "PASS extraction write: real decoding cancelled, no continued writes or worker residue"
  )

  // Encrypted archive + wrong dictionary keeps actual 7-Zip password attempts running.
  const archive = join(root, "加密归档.7z")
  const small = join(root, "归档内容.txt")
  await writeFile(small, "取消与切页验证\n")
  const fixture = spawn(
    sevenZip,
    ["a", "-t7z", "-mhe=on", "-pfixture-secret", archive, small],
    { windowsHide: true, stdio: "ignore" }
  )
  assert.equal((await once(fixture, "exit"))[0], 0)
  await invoke("dictionary_add", {
    candidates: Array.from({ length: 1000 }, (_, i) => `wrong-candidate-${i}`),
  })
  const request = {
    archivePath: archive,
    outputDirectory: join(root, "解压结果"),
    recursive: false,
    computeMode: "cpuOnly",
    avoidOutputCollision: true,
  }
  const recovery = await invoke("recovery_start", { request })
  await page.reload()
  await instrument()
  await expect(
    page.getByRole("button", { name: "取消任务", exact: true })
  ).toBeVisible({ timeout: 15000 })
  await expect
    .poll(
      async () =>
        (await invoke("recovery_status", { taskId: recovery.taskId }))
          ?.dictionaryProgress?.currentIndex ?? 0,
      { timeout: 15000 }
    )
    .toBeGreaterThan(0)
  await nav("设置")
  assert.equal(
    (await invoke("recovery_status", { taskId: recovery.taskId })).running,
    true
  )
  await nav("解压")
  await doubleClick(page.getByRole("button", { name: "取消任务", exact: true }))
  await nav("历史")
  const recoveryDone = await terminal("recovery_status", recovery.taskId)
  await nav("解压")
  await expect(
    page.getByRole("button", { name: "取消任务", exact: true })
  ).toHaveCount(0)
  assert.equal(await count("recovery_cancel"), 1)
  assert.equal(
    await count("recovery_start"),
    0,
    "Navigation must not start another recovery"
  )
  await shot("recovery-cancelled-returned")
  records.push({ scenario: "recovery", status: recoveryDone, cancelCalls: 1 })
  console.log(
    "PASS recovery: real password attempts cancelled across navigation"
  )

  await page.getByRole("button", { name: "打开解压选项" }).click()
  await expect(page.getByLabel("记住任务队列")).toBeEnabled()
  await page.getByLabel("记住任务队列").click()
  await expect(page.getByLabel("记住任务队列")).toBeChecked()
  await page.getByRole("switch", { name: "完成后打开输出文件夹" }).uncheck()
  await page.keyboard.press("Escape")
  const waiting = join(root, "等待归档.7z")
  await copyFile(archive, waiting)
  await pastePaths([archive, waiting])
  await expect(
    page.getByRole("button", { name: "按顺序处理 2 项" })
  ).toBeEnabled()
  await instrument()
  await doubleClick(page.getByRole("button", { name: "按顺序处理 2 项" }))
  await expect
    .poll(
      async () => (await invoke("recovery_status", { taskId: null }))?.running,
      { timeout: 15000 }
    )
    .toBe(true)
  const batch = await invoke("recovery_status", { taskId: null })
  await nav("字典")
  await nav("解压")
  await doubleClick(page.getByRole("button", { name: "停止批次", exact: true }))
  await nav("设置")
  const batchDone = await terminal("recovery_status", batch.taskId)
  await nav("解压")
  await expect(
    page.getByRole("button", { name: "按顺序处理 1 项" })
  ).toBeEnabled({ timeout: 15000 })
  assert.equal(await count("recovery_start"), 1)
  assert.equal(await count("recovery_cancel"), 1)
  await delay(1500)
  assert.equal(
    (await invoke("recovery_status", { taskId: null })).taskId,
    batch.taskId
  )
  await noWorkers()
  await expect
    .poll(async () =>
      JSON.parse(
        await readFile(join(data, "recovery-queue.json"), "utf8")
      ).items.map((item) => item.state)
    )
    .toEqual(["cancelled", "waiting"])
  await page.getByRole("region", { name: "批次队列" }).scrollIntoViewIfNeeded()
  await shot("batch-cancelled-waiting-preserved")
  records.push({
    scenario: "batch",
    persistedStates: ["cancelled", "waiting"],
    status: batchDone,
    startCalls: 1,
    cancelCalls: 1,
  })
  console.log(
    "PASS batch: only first item started; stop retained waiting item across navigation"
  )

  if (process.argv.includes("--with-retries")) {
    const { verifyNativeRetries } = await import("./desktop-retries.mjs")
    await verifyNativeRetries({
      page,
      invoke,
      pastePaths,
      root,
      data,
      evidence,
      sevenZip,
      records,
      nav,
      instrument,
      count,
      doubleClick,
      noWorkers,
    })
  }

  // Verify real application shutdown also joins active workers.
  await invoke("recovery_start", { request })
  await close()
  await noWorkers()
  const sessionRoot = join(data, "temp", "recovery-sessions")
  for (const name of await readdir(sessionRoot)) {
    if (name.startsWith("session-"))
      assert.deepEqual(await readdir(join(sessionRoot, name)), ["owner.lock"])
    else assert.equal(name, "cleanup.lock")
  }
  assert.deepEqual(errors, [])
  await writeFile(
    join(evidence, "native-lifecycle-results.json"),
    JSON.stringify(
      {
        runtime: "Windows Tauri + WebView2 + Rust IPC + real 7-Zip",
        root,
        records,
        workersAfterClose: [],
        gracefulClose: true,
      },
      null,
      2
    )
  )
  console.log(
    "PASS shutdown: worker processes exited and temporary sessions cleaned"
  )
}
