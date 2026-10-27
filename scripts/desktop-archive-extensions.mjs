import assert from "node:assert/strict"
import {
  mkdir,
  writeFile,
  readFile,
  readdir,
  rename,
  access,
} from "node:fs/promises"
import { join, dirname } from "node:path"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { expect } from "@playwright/test"

export async function verifyArchiveExtensions({
  invoke,
  getPage,
  data,
  evidence,
  binary,
  archive,
  password,
  close,
  launch,
}) {
  let page = getPage()
  const work = join(data, "[测试分组] 中文目录")
  await mkdir(work, { recursive: true })
  const source = join(work, "资料.bin")
  const bytes = Buffer.alloc(2_500_000)
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251
  await writeFile(source, bytes)
  async function compress(request) {
    const started = await invoke("compression_start", { request })
    await expect
      .poll(
        async () =>
          (await invoke("compression_status", { taskId: started.taskId }))
            ?.completed,
        { timeout: 60000 }
      )
      .toBe(true)
    const result = await invoke("compression_status", {
      taskId: started.taskId,
    })
    assert.equal(result.success, true, result.message)
    return result
  }
  let split
  for (const format of ["sevenZip", "zip"]) {
    const result = await compress({
      sources: [source],
      baseName: "分卷归档",
      format,
      level: 0,
      outputDirectory: work,
      volumeSizeMib: 1,
      password,
      verifyAfterCompression: true,
    })
    assert.equal(result.verification, "passed")
    assert.match(result.outputPath, /\.001$/)
    const volumes = await readdir(dirname(result.outputPath))
    assert.equal(volumes.length, 3)
    const diagnosis = await invoke("archive_volume_diagnostics", {
      path: result.outputPath,
    })
    assert.equal(diagnosis.recognizable, true, JSON.stringify(diagnosis))
    assert.equal(diagnosis.existing.length, 3)
    const middle = join(
      dirname(result.outputPath),
      volumes.find((v) => v.endsWith(".002"))
    )
    await rename(middle, middle + ".missing")
    const missing = await invoke("archive_volume_diagnostics", {
      path: result.outputPath,
    })
    assert.ok(missing.missing.some((name) => name.endsWith(".002")))
    assert.equal(missing.recognizable, false)
    await rename(middle + ".missing", middle)
    assert.equal(
      (await invoke("archive_volume_diagnostics", { path: result.outputPath }))
        .recognizable,
      true
    )
    split = result.outputPath
  }
  const space = await invoke("archive_space_preflight", {
    path: split,
    output: work,
    password,
  })
  assert.ok(space.declaredBytes >= bytes.length)
  assert.ok(space.availableBytes > 0)
  const outer = await compress({
    sources: [archive],
    baseName: "外层归档",
    format: "sevenZip",
    level: 0,
    outputDirectory: work,
  })
  const extraction = join(work, "嵌套输出")
  const recovery = await invoke("recovery_start", {
    request: {
      archivePath: outer.outputPath,
      outputDirectory: extraction,
      knownPassword: password,
      recursive: true,
      computeMode: "cpuOnly",
    },
  })
  await expect
    .poll(
      async () =>
        (await invoke("recovery_status", { taskId: recovery.taskId }))
          ?.completed,
      { timeout: 60000 }
    )
    .toBe(true)
  const result = await invoke("recovery_status", { taskId: recovery.taskId })
  assert.equal(result.success, true, result.message)
  assert.equal(result.archiveTree.length, 2, JSON.stringify(result.archiveTree))
  const nested = result.archiveTree.find((node) => node.parent)
  assert.equal(
    nested.parent,
    result.archiveTree.find((node) => !node.parent).path
  )
  assert.equal(nested.state, "success")
  await access(nested.output)
  await page.reload()
  await expect(page.getByText("嵌套归档结果树（2）")).toBeVisible({
    timeout: 15000,
  })
  await page.screenshot({ path: join(evidence, "archive-result-tree.png") })
  await invoke("settings_update", {
    update: {
      kind: "extractionLimits",
      value: { maxGib: 1, maxEntries: 1, maxDepth: 2 },
    },
  })
  await assert.rejects(
    invoke("settings_update", {
      update: {
        kind: "extractionLimits",
        value: { maxGib: 0, maxEntries: 1, maxDepth: 2 },
      },
    })
  )
  const overLimit = await compress({
    sources: [source, archive],
    baseName: "条目上限归档",
    format: "zip",
    level: 0,
    outputDirectory: work,
  })
  assert.equal(
    (
      await invoke("archive_space_preflight", {
        path: overLimit.outputPath,
        output: work,
        password: null,
      })
    ).exceedsLimit,
    true
  )
  const blocked = await invoke("recovery_start", {
    request: {
      archivePath: overLimit.outputPath,
      outputDirectory: join(work, "限制输出"),
      recursive: true,
      computeMode: "cpuOnly",
    },
  })
  await expect
    .poll(
      async () =>
        (await invoke("recovery_status", { taskId: blocked.taskId }))
          ?.completed,
      { timeout: 15000 }
    )
    .toBe(true)
  const blockedResult = await invoke("recovery_status", {
    taskId: blocked.taskId,
  })
  assert.equal(blockedResult.success, false)
  assert.match(blockedResult.message, /预算|超出|超过|限制/)
  // Register/unregister through the real settings UI; debug uses a private registry key.
  await page.getByRole("button", { name: "设置", exact: true }).click()
  await page.getByRole("tab", { name: "应用", exact: true }).click()
  const menu = page.getByLabel("开启 Windows 右键菜单（推荐）")
  await expect(menu).toBeChecked()
  await menu.uncheck()
  await page.getByRole("button", { name: "保存右键菜单设置" }).click()
  await expect
    .poll(async () => (await invoke("desktop_integration_status")).contextMenu)
    .toBe(false)
  await page.screenshot({ path: join(evidence, "archive-settings.png") })
  await page.getByRole("button", { name: "解压", exact: true }).click()
  const secondary = spawn(binary, ["--shell-action", "queue", "--", split], {
    windowsHide: true,
    env: { ...process.env, ARC_RECALL_TEST_DATA_ROOT: data },
    stdio: "ignore",
  })
  const [exit] = await once(secondary, "exit")
  assert.equal(exit, 0)
  await expect
    .poll(async () => (await invoke("desktop_launch_list")).length)
    .toBe(0)
  await expect(
    page.getByRole("region", { name: "批次队列", exact: true })
  ).toContainText("分卷归档")
  for (const action of ["open", "check", "focus"]) {
    const extra = spawn(
      binary,
      action === "focus" ? [] : ["--shell-action", action, "--", split],
      {
        windowsHide: true,
        env: { ...process.env, ARC_RECALL_TEST_DATA_ROOT: data },
        stdio: "ignore",
      }
    )
    assert.equal((await once(extra, "exit"))[0], 0)
    await expect
      .poll(async () => (await invoke("desktop_launch_list")).length)
      .toBe(0)
    if (action === "check") {
      const dialog = page.getByRole("dialog", {
        name: "批量完整性检查",
        exact: true,
      })
      await expect(dialog).toBeVisible()
      await dialog.getByRole("button", { name: "关闭", exact: true }).click()
      await page.getByRole("button", { name: "关闭入口", exact: true }).click()
    } else {
      await expect(
        page.getByRole("button", { name: "预览内容", exact: true })
      ).toBeVisible()
    }
  }
  // The diagnostic retry starts a fresh native task with the current password.
  await page.getByRole("button", { name: "打开解压选项" }).click()
  await page.getByRole("switch", { name: "完成后打开输出文件夹" }).uncheck()
  await page.keyboard.press("Escape")
  await page.getByLabel("已知密码（可选）", { exact: true }).fill(password)
  await page
    .getByRole("button", { name: "分卷诊断／补卷重试", exact: true })
    .click()
  const diagnostics = page.getByRole("dialog", {
    name: "归档诊断",
    exact: true,
  })
  const prior = (await invoke("recovery_status", { taskId: null })).taskId
  await diagnostics
    .getByRole("button", { name: "按当前选项重试解压", exact: true })
    .click()
  await expect
    .poll(
      async () => {
        const latest = await invoke("recovery_status", { taskId: null })
        return latest?.taskId !== prior && latest?.completed && latest?.success
      },
      { timeout: 60000 }
    )
    .toBe(true)
  // Persist actual queue via UI and verify password-free restart recovery.
  await page.getByRole("button", { name: "压缩", exact: true }).click()
  await page
    .getByRole("button", { name: "每个来源分别压缩", exact: true })
    .click()
  await page.getByRole("switch", { name: "完成后打开", exact: true }).uncheck()
  await invoke("plugin:event|emit_to", {
    target: { kind: "Webview", label: "main" },
    event: "tauri://drag-drop",
    payload: { paths: [source], position: { x: 0, y: 0 } },
  })
  await page.getByLabel("分卷大小（MiB，可选）").fill("1")
  await page
    .getByRole("button", { name: "加入压缩队列，稍后开始", exact: true })
    .click()
  await page.getByRole("button", { name: "压缩队列（1）", exact: true }).click()
  await page.getByLabel("记住压缩队列", { exact: true }).click()
  await expect
    .poll(async () => (await invoke("compression_queue_load")).enabled)
    .toBe(true)
  const checkpoint = JSON.parse(
    await readFile(join(data, "compression-queue.json"), "utf8")
  )
  assert.equal(checkpoint.items[0].request.volumeSizeMib, 1)
  assert.ok(!JSON.stringify(checkpoint).includes(password))
  await close()
  await launch()
  page = getPage()
  assert.equal(
    (await invoke("settings_get")).recovery.extractionLimits.maxDepth,
    2
  )
  assert.equal(
    (await invoke("desktop_integration_status")).setupCompleted,
    true
  )
  await page.getByRole("button", { name: "压缩", exact: true }).click()
  await page.getByRole("button", { name: "压缩队列（1）", exact: true }).click()
  const panel = page.getByRole("dialog", { name: "批量压缩队列", exact: true })
  await expect(panel.getByText(/已恢复 1 项/)).toBeVisible()
  await panel
    .getByRole("button", { name: "开始／继续队列", exact: true })
    .click()
  await expect(panel.getByText(/1\. 资料\.bin · 完成/)).toBeVisible({
    timeout: 60000,
  })
  await page.screenshot({ path: join(evidence, "archive-queue-restored.png") })
  await page.getByLabel("记住压缩队列", { exact: true }).click()
  await expect
    .poll(async () => (await invoke("compression_queue_load")).enabled)
    .toBe(false)
  console.log(
    "PASS: native split 7z/ZIP verification, missing-volume detection/recheck, disk preflight, nested result tree, first-run setup, menu toggle, second-instance handoff, compression queue restart and limits persistence"
  )
}
