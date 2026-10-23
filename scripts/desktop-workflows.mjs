import assert from "node:assert/strict"
import { join } from "node:path"
import {
  readFile,
  mkdir,
  writeFile,
  access,
  readdir,
  unlink,
} from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { expect } from "@playwright/test"

// Uses the existing isolated desktop harness, real SQLite and real 7-Zip.
export async function verifyWorkflows({
  invoke,
  page,
  archive,
  password,
  data,
  evidence,
}) {
  await invoke("dictionary_add", {
    candidates: [password, "unrelated-candidate"],
  })
  const dictionary = await invoke("dictionary_list", {
    query: { searchText: "", skip: 0, take: 100 },
  })
  const matching = dictionary.entries.find((entry) => entry.value === password)
  await invoke("dictionary_group_assign", {
    name: "测试分组",
    ids: [matching.id],
  })
  const filtered = await invoke("dictionary_group_list", {
    name: "测试分组",
    query: { searchText: "", skip: 0, take: 100 },
  })
  assert.equal(filtered.matchedCount, 1)
  assert.equal(filtered.entries[0].value, password)
  await assert.rejects(
    invoke("archive_preview", { path: archive, password: "incorrect" })
  )
  const preview = await invoke("archive_preview", { path: archive, password })
  assert.ok(preview.totalEntries > 0)
  assert.ok(preview.entries.some((entry) => entry.path.endsWith(".txt")))
  const fixture = join(data, "选择性提取测试")
  const source = join(fixture, "输入")
  await mkdir(join(source, "[测试分组] 中文目录"), { recursive: true })
  await mkdir(join(source, "[测试分组] 中文目录-其他"))
  await writeFile(
    join(source, "[测试分组] 中文目录", "资料.txt"),
    "selected contents"
  )
  await writeFile(
    join(source, "[测试分组] 中文目录-其他", "保留.txt"),
    "unselected contents"
  )
  await writeFile(join(source, "@独立文件.txt"), "literal list prefix")
  const selectiveArchive = join(fixture, "加密归档.7z")
  const sevenZip =
    process.env.ARC_RECALL_TEST_7ZIP ?? "C:/Program Files/7-Zip/7z.exe"
  const created = spawnSync(
    sevenZip,
    ["a", "-t7z", "-mhe=on", `-p${password}`, selectiveArchive, "."],
    { cwd: source, windowsHide: true, encoding: "utf8" }
  )
  assert.equal(created.status, 0, created.stderr)
  const action = (args) =>
    invoke("archive_action_run", {
      id: crypto.randomUUID(),
      request: {
        path: selectiveArchive,
        password,
        selectedPaths: null,
        outputParent: fixture,
        ...args,
      },
    })
  assert.equal((await action({})).outputDirectory, null)
  await assert.rejects(action({ password: "incorrect" }))
  const listed = await invoke("archive_preview", {
    path: selectiveArchive,
    password,
  })
  const folder = listed.entries.find(
    (entry) => entry.directory && entry.path === "[测试分组] 中文目录"
  )
  assert.ok(folder)
  const extracted = await action({ selectedPaths: [folder.path] })
  assert.equal(
    await readFile(
      join(extracted.outputDirectory, folder.path, "资料.txt"),
      "utf8"
    ),
    "selected contents"
  )
  assert.deepEqual(await readdir(extracted.outputDirectory), [folder.path])
  const literal = await action({ selectedPaths: ["@独立文件.txt"] })
  assert.notEqual(literal.outputDirectory, extracted.outputDirectory)
  assert.deepEqual(await readdir(literal.outputDirectory), ["@独立文件.txt"])
  await assert.rejects(action({ selectedPaths: ["../outside.txt"] }))
  const beforeFailure = await readdir(fixture)
  await assert.rejects(
    action({ password: "incorrect", selectedPaths: [folder.path] })
  )
  assert.deepEqual(await readdir(fixture), beforeFailure)
  // ZIP exposes its directory even with a wrong password, exercising cleanup after output creation.
  const readableDirectoryArchive = join(fixture, "目录可读归档.zip")
  const zipCreated = spawnSync(
    sevenZip,
    ["a", "-tzip", `-p${password}`, readableDirectoryArchive, "."],
    { cwd: source, windowsHide: true, encoding: "utf8" }
  )
  assert.equal(zipCreated.status, 0, zipCreated.stderr)
  const beforeExtractionFailure = await readdir(fixture)
  await assert.rejects(
    action({
      path: readableDirectoryArchive,
      password: "incorrect",
      selectedPaths: ["@独立文件.txt"],
    })
  )
  assert.deepEqual(await readdir(fixture), beforeExtractionFailure)
  const damaged = join(fixture, "损坏归档.7z")
  const bytes = await readFile(selectiveArchive)
  await writeFile(damaged, bytes.subarray(0, Math.floor(bytes.length / 2)))
  await assert.rejects(action({ path: damaged }))
  const cancelled = await page.evaluate(
    async ({ path, password }) => {
      const id = crypto.randomUUID()
      const pending = window.__TAURI_INTERNALS__
        .invoke("archive_action_run", {
          id,
          request: { path, password, selectedPaths: null, outputParent: null },
        })
        .then(
          () => "completed",
          (error) => String(error)
        )
      await window.__TAURI_INTERNALS__.invoke("archive_action_cancel", { id })
      return pending
    },
    { path: selectiveArchive, password }
  )
  assert.match(cancelled, /取消/)
  await access(selectiveArchive)
  const split = join(fixture, "分卷归档.7z")
  const splitCreated = spawnSync(
    sevenZip,
    ["a", "-t7z", "-v100b", `-p${password}`, split, "."],
    { cwd: source, windowsHide: true, encoding: "utf8" }
  )
  assert.equal(splitCreated.status, 0, splitCreated.stderr)
  assert.equal((await action({ path: split + ".001" })).outputDirectory, null)
  const splitOutput = await action({
    path: split + ".001",
    selectedPaths: ["@独立文件.txt"],
  })
  assert.deepEqual(await readdir(splitOutput.outputDirectory), [
    "@独立文件.txt",
  ])
  const volumes = (await readdir(fixture))
    .filter((name) => /^分卷归档\.7z\.\d+$/.test(name))
    .sort()
  assert.ok(volumes.length > 1)
  await unlink(join(fixture, volumes.at(-1)))
  await assert.rejects(action({ path: split + ".001" }))
  await page.evaluate((path) => {
    const data = new DataTransfer()
    data.setData("text/plain", path)
    window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data }))
  }, selectiveArchive)
  // Verify the native WebView exposes the same controls as the renderer tests.
  await page.getByRole("button", { name: "预览内容", exact: true }).click()
  const previewDialog = page.getByRole("dialog", { name: "归档内容预览" })
  await expect(
    previewDialog.getByRole("button", { name: "检查完整性", exact: true })
  ).toBeVisible()
  await previewDialog
    .getByRole("button", { name: "检查完整性", exact: true })
    .click()
  await expect(previewDialog.getByRole("alert")).toContainText("检查未通过")
  await page.screenshot({
    path: join(evidence, "archive-integrity-result.png"),
    animations: "disabled",
  })
  await page.keyboard.press("Escape")
  console.log(
    "PASS: real whole-archive validation, wrong password/corruption rejection, selective directory/literal file extraction and isolated outputs"
  )
  const task = await invoke("recovery_start", {
    request: {
      archivePath: archive,
      recursive: true,
      computeMode: "cpuOnly",
      dictionaryGroup: "测试分组",
      avoidOutputCollision: true,
    },
  })
  await expect
    .poll(
      async () =>
        (await invoke("recovery_status", { taskId: task.taskId })).running,
      { timeout: 60000 }
    )
    .toBe(false)
  assert.equal(
    (await invoke("recovery_status", { taskId: task.taskId })).success,
    true
  )
  await expect
    .poll(
      async () =>
        (
          await invoke("task_records_list", { skip: 0, failedOnly: false })
        ).find((record) => record.taskId === task.taskId)?.state
    )
    .toBe("success")
  const rows = await invoke("task_records_list", { skip: 0, failedOnly: false })
  assert.equal(rows[0].dictionaryGroup, "测试分组")
  assert.ok(!JSON.stringify(rows).includes(password))
  assert.ok(
    !(await readFile(join(data, "task-records.db"))).includes(
      Buffer.from(password)
    )
  )
  await invoke("dictionary_group_delete", { name: "测试分组" })
  assert.equal(await invoke("dictionary_count"), 2)
  await assert.rejects(
    invoke("recovery_start", {
      request: { archivePath: archive, dictionaryGroup: "测试分组" },
    })
  )
  assert.ok(
    (await invoke("task_records_list", { skip: 0, failedOnly: true })).length >
      0
  )
  await page.getByRole("button", { name: "历史", exact: true }).click()
  await page.getByRole("button", { name: "任务记录", exact: true }).click()
  await expect(
    page.getByRole("dialog", { name: "任务记录与重试" })
  ).toBeVisible()
  await page.screenshot({
    path: join(evidence, "workflow-task-records.png"),
    animations: "disabled",
  })
  console.log(
    "PASS: real dictionary scope, encrypted preview, recovery record persistence and secret exclusion"
  )
}
