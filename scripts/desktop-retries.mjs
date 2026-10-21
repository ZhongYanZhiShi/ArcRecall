import assert from "node:assert/strict"
import { randomBytes, createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { readFile, writeFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { expect } from "@playwright/test"

export async function verifyNativeRetries({
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
}) {
  const journal = async () =>
    JSON.parse(await readFile(join(data, "recovery-queue.json"), "utf8"))
  const states = async () => (await journal()).items.map((item) => item.state)
  const latest = () => invoke("recovery_status", { taskId: null })
  const waitStates = (expected) =>
    expect.poll(states, { timeout: 60000 }).toEqual(expected)
  const shot = (name) =>
    page.screenshot({ path: join(evidence, `native-${name}.png`) })
  const digest = (buffer) => createHash("sha256").update(buffer).digest("hex")
  const files = async (dir) => {
    const result = []
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) result.push(...(await files(path)))
      else result.push(path)
    }
    return result
  }
  const verifyOutput = async (status, expected) => {
    assert.equal(status.success, true)
    assert.equal(status.running, false)
    assert.equal(status.cancelled, false)
    const paths = await files(status.outputDirectory)
    assert.ok(paths.length > 0)
    assert.ok(
      (
        await Promise.all(
          paths.map(async (path) => digest(await readFile(path)))
        )
      ).includes(digest(expected)),
      "Extracted payload must match source bytes"
    )
    await noWorkers()
  }
  const options = async (recursive) => {
    await page.getByRole("button", { name: "打开解压选项" }).click()
    await page
      .getByRole("switch", { name: "递归解密", exact: true })
      .setChecked(recursive)
    await page.keyboard.press("Escape")
  }
  const before = await journal()
  await page.getByLabel("本批次优先密码（可选）").fill("fixture-secret")
  await instrument()
  await doubleClick(
    page.getByRole("button", { name: "按顺序处理 1 项", exact: true })
  )
  await nav("字典")
  await waitStates(["cancelled", "success"])
  const continued = await latest()
  await verifyOutput(continued, await readFile(join(root, "归档内容.txt")))
  await nav("解压")
  await expect(
    page.getByRole("button", { name: "暂无待处理任务" })
  ).toBeDisabled()
  assert.equal(await count("recovery_start"), 1)
  assert.equal((await journal()).items[0].id, before.items[0].id)
  assert.equal(continued.archivePath, before.items[1].path)
  await shot("batch-continued-success")
  records.push({
    scenario: "batch-continue",
    taskId: continued.taskId,
    startCalls: 1,
    states: await states(),
    payloadVerified: true,
  })
  console.log(
    "PASS batch continue: only waiting item starts; successful payload and UI synchronized"
  )

  // Retrying an old item must retain its original recursion/compute options.
  await options(false)
  await page.getByRole("button", { name: "将失败与取消项重新排队" }).click()
  await instrument()
  await doubleClick(
    page.getByRole("button", { name: "按顺序处理 1 项", exact: true })
  )
  await nav("设置")
  await waitStates(["success", "success"])
  const resumed = await latest()
  assert.notEqual(resumed.taskId, continued.taskId)
  assert.equal(resumed.archivePath, before.items[0].path)
  assert.equal(resumed.recursiveEnabled, before.items[0].options.recursive)
  assert.equal(resumed.computeMode, before.items[0].options.computeMode)
  await verifyOutput(resumed, await readFile(join(root, "归档内容.txt")))
  assert.equal(await count("recovery_start"), 1)
  await nav("解压")
  await expect(
    page.getByRole("button", { name: "暂无待处理任务" })
  ).toBeDisabled()
  await shot("cancelled-item-restarted-success")
  records.push({
    scenario: "cancelled-item-retry",
    taskId: resumed.taskId,
    startCalls: 1,
    recursive: resumed.recursiveEnabled,
    computeMode: resumed.computeMode,
    states: await states(),
  })
  console.log(
    "PASS cancelled retry: original per-item settings survive changed page defaults"
  )

  // A separate password prevents cached successful passwords from masking failure.
  for (;;) {
    const list = await invoke("dictionary_list", {
      query: { searchText: "", skip: 0, take: 500 },
    })
    if (!list.entries.length) break
    await invoke("dictionary_delete", {
      ids: list.entries.map((entry) => entry.id),
    })
  }
  const failedArchive = join(root, "失败重试归档.7z")
  const packed = spawnSync(
    sevenZip,
    [
      "a",
      "-t7z",
      "-mhe=on",
      "-pretry-secret",
      failedArchive,
      join(root, "归档内容.txt"),
    ],
    { windowsHide: true, encoding: "utf8" }
  )
  assert.equal(packed.status, 0, packed.stderr)
  await pastePaths([failedArchive, before.items[0].path])
  await page.getByLabel("本批次优先密码（可选）").fill("wrong-password")
  await instrument()
  await doubleClick(
    page.getByRole("button", { name: "按顺序处理 1 项", exact: true })
  )
  await waitStates(["success", "success", "failed"])
  const failed = await latest()
  assert.equal(failed.success, false)
  assert.equal(failed.cancelled, false)
  assert.equal(await count("recovery_start"), 1)
  const failedOptions = (await journal()).items[2].options
  await options(true)
  await page.getByLabel("本批次优先密码（可选）").fill("retry-secret")
  await page.getByRole("button", { name: "将失败与取消项重新排队" }).click()
  await instrument()
  await doubleClick(
    page.getByRole("button", { name: "按顺序处理 1 项", exact: true })
  )
  await nav("历史")
  await waitStates(["success", "success", "success"])
  const retried = await latest()
  assert.notEqual(retried.taskId, failed.taskId)
  assert.equal(retried.recursiveEnabled, failedOptions.recursive)
  assert.equal(retried.computeMode, failedOptions.computeMode)
  await verifyOutput(retried, await readFile(join(root, "归档内容.txt")))
  assert.equal(await count("recovery_start"), 1)
  await nav("解压")
  await expect(
    page.getByRole("button", { name: "将失败与取消项重新排队" })
  ).toHaveCount(0)
  await page.getByRole("region", { name: "批次队列" }).scrollIntoViewIfNeeded()
  await shot("failed-item-retry-success")
  records.push({
    scenario: "failed-retry",
    failedId: failed.taskId,
    retryId: retried.taskId,
    startCalls: 1,
    states: await states(),
    recursive: retried.recursiveEnabled,
    payloadVerified: true,
  })
  console.log(
    "PASS failed retry: corrected password applies; original options retained; completed items not repeated"
  )

  await page.getByRole("button", { name: "清空队列", exact: true }).click()
  await page.getByRole("button", { name: "打开解压选项" }).click()
  await expect(page.getByLabel("记住任务队列")).toBeEnabled()
  await page.getByLabel("记住任务队列").click()
  await expect(page.getByLabel("记住任务队列")).not.toBeChecked()
  await page.getByRole("switch", { name: "递归解密", exact: true }).uncheck()
  await page.keyboard.press("Escape")
  const singleArchive = join(root, "单项重新开始.7z")
  assert.equal(
    spawnSync(
      sevenZip,
      [
        "a",
        "-t7z",
        "-mhe=on",
        "-psingle-secret",
        singleArchive,
        join(root, "归档内容.txt"),
      ],
      { windowsHide: true, stdio: "ignore" }
    ).status,
    0
  )
  await invoke("dictionary_add", {
    candidates: Array.from({ length: 1000 }, (_, i) => `single-wrong-${i}`),
  })
  await pastePaths([singleArchive])
  await page
    .getByLabel("已知密码（可选）", { exact: true })
    .fill("single-wrong")
  await instrument()
  await doubleClick(
    page.getByRole("button", { name: "开始恢复并解压", exact: true })
  )
  await expect(
    page.getByRole("button", { name: /^(取消任务|取消)$/ })
  ).toBeVisible()
  const single = await latest()
  await expect
    .poll(async () => (await latest())?.dictionaryProgress?.currentIndex ?? 0, {
      timeout: 15000,
    })
    .toBeGreaterThan(0)
  await doubleClick(page.getByRole("button", { name: /^(取消任务|取消)$/ }))
  await expect.poll(async () => (await latest())?.cancelled).toBe(true)
  await nav("字典")
  await nav("解压")
  await page.getByText("重新解压 / 修改密码与策略", { exact: true }).click()
  await expect(
    page.getByLabel("已知密码（可选）", { exact: true })
  ).toHaveValue("single-wrong")
  await page
    .getByLabel("已知密码（可选）", { exact: true })
    .fill("single-secret")
  await doubleClick(
    page.getByRole("button", { name: "开始恢复并解压", exact: true })
  )
  await nav("历史")
  await expect
    .poll(async () => (await latest())?.success, { timeout: 30000 })
    .toBe(true)
  const restarted = await latest()
  assert.notEqual(restarted.taskId, single.taskId)
  assert.equal(restarted.archivePath, single.archivePath)
  assert.equal(restarted.recursiveEnabled, false)
  assert.equal(restarted.computeMode, "cpuOnly")
  await verifyOutput(restarted, await readFile(join(root, "归档内容.txt")))
  assert.equal(await count("recovery_start"), 2)
  assert.equal(await count("recovery_cancel"), 1)
  await nav("解压")
  await expect(
    page.getByRole("button", { name: "取消任务", exact: true })
  ).toHaveCount(0)
  await shot("single-extraction-restarted-success")
  records.push({
    scenario: "single-extraction-restart",
    cancelledId: single.taskId,
    retryId: restarted.taskId,
    startCalls: 2,
    cancelCalls: 1,
    recursive: false,
    computeMode: "cpuOnly",
    payloadVerified: true,
  })
  console.log(
    "PASS single extraction restart: draft retained, corrected password and original settings applied"
  )

  await nav("压缩")
  const source = join(root, "重新压缩测试.bin")
  const payload = randomBytes(32 * 1024 * 1024)
  await writeFile(source, payload)
  await invoke("plugin:event|emit_to", {
    target: { kind: "Webview", label: "main" },
    event: "tauri://drag-drop",
    payload: { paths: [source], position: { x: 0, y: 0 } },
  })
  await expect(
    page
      .getByTestId("compress-source-scroll")
      .getByText("重新压缩测试.bin", { exact: true })
  ).toBeVisible()
  await page.getByRole("switch", { name: "完成后打开", exact: true }).uncheck()
  await page.getByLabel("归档基础名称", { exact: true }).fill("保留设置重启")
  await page
    .getByLabel("密码（可选）", { exact: true })
    .fill("compression-secret")
  await page
    .getByLabel("确认新密码", { exact: true })
    .fill("compression-secret")
  await page.getByRole("switch", { name: "加密文件名", exact: true }).check()
  const level = await page
    .getByRole("combobox", { name: "压缩级别", exact: true })
    .innerText()
  await instrument()
  await doubleClick(page.getByRole("button", { name: "开始压缩", exact: true }))
  await expect(
    page.getByRole("button", { name: "取消压缩", exact: true })
  ).toBeVisible()
  const first = await invoke("compression_status", { taskId: null })
  await doubleClick(page.getByRole("button", { name: "取消压缩", exact: true }))
  await expect
    .poll(
      async () =>
        (await invoke("compression_status", { taskId: first.taskId })).cancelled
    )
    .toBe(true)
  await nav("设置")
  await nav("压缩")
  await expect(page.getByLabel("归档基础名称", { exact: true })).toHaveValue(
    "保留设置重启"
  )
  await expect(page.getByLabel("密码（可选）", { exact: true })).toHaveValue(
    "compression-secret"
  )
  await expect(page.getByLabel("确认新密码", { exact: true })).toHaveValue(
    "compression-secret"
  )
  await expect(
    page.getByRole("switch", { name: "加密文件名", exact: true })
  ).toBeChecked()
  await expect
    .poll(() =>
      page.getByRole("combobox", { name: "压缩级别", exact: true }).innerText()
    )
    .toBe(level)
  await expect(
    page.getByRole("switch", { name: "完成后打开", exact: true })
  ).not.toBeChecked()
  await doubleClick(page.getByRole("button", { name: "开始压缩", exact: true }))
  await nav("字典")
  await expect
    .poll(
      async () =>
        (await invoke("compression_status", { taskId: null }))?.success,
      { timeout: 90000 }
    )
    .toBe(true)
  const success = await invoke("compression_status", { taskId: null })
  assert.notEqual(success.taskId, first.taskId)
  assert.equal(success.outputPath, first.outputPath)
  assert.equal(await count("compression_start"), 2)
  assert.equal(await count("compression_cancel"), 1)
  const content = spawnSync(
    sevenZip,
    ["x", "-so", "-pcompression-secret", success.outputPath],
    { windowsHide: true, maxBuffer: 40 * 1024 * 1024 }
  )
  assert.equal(content.status, 0)
  assert.equal(digest(content.stdout), digest(payload))
  await noWorkers()
  await nav("压缩")
  await expect(page.getByText("压缩完成", { exact: true })).toBeVisible()
  await page.getByText("压缩完成", { exact: true }).scrollIntoViewIfNeeded()
  await shot("compression-restarted-success")
  records.push({
    scenario: "compression-retry",
    cancelledId: first.taskId,
    retryId: success.taskId,
    startCalls: 2,
    cancelCalls: 1,
    outputPath: success.outputPath,
    payloadVerified: true,
  })
  console.log(
    "PASS compression restart: source/name/password/level retained; only one new task; archive content verified"
  )
}
