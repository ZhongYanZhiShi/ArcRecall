// Real WebView2, SQLite, queue checkpoints, DPAPI and 7-Zip in the smoke runner's
// isolated data root. Browser windowing tests complement, not replace, this run.
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { spawnSync } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { expect } from "@playwright/test"

export async function verifyNativePerformance({
  page,
  invoke,
  root,
  evidence,
  sevenZip,
  errors,
}) {
  const candidates = Array.from(
    { length: 20_000 },
    (_, index) => `candidate-${index + 1}`
  )
  for (let start = 0; start < candidates.length; start += 4096) {
    const result = await invoke("dictionary_add", {
      candidates: candidates.slice(start, start + 4096),
    })
    assert.equal(result.addedCount, Math.min(4096, candidates.length - start))
  }
  await page.getByRole("button", { name: "字典", exact: true }).click()
  await page.getByRole("combobox", { name: "每页条数" }).click()
  await page.getByRole("option", { name: "自定义", exact: true }).click()
  const size = page.getByRole("spinbutton", { name: "自定义每页条数" })
  await size.fill("20000")
  const started = performance.now()
  await size.press("Enter")
  const table = page.getByRole("table")
  await expect(table).toHaveAttribute("aria-rowcount", "20001")
  const rows = table.locator("[data-dictionary-index]")
  await expect.poll(() => rows.count()).toBeLessThan(80)
  const metrics = {
    candidates: 20_000,
    mountedRows: await rows.count(),
    changePageSizeMs: Math.round(performance.now() - started),
  }
  assert.ok(metrics.mountedRows > 0)
  await page.getByRole("checkbox", { name: "全选当前列表" }).check()
  await expect(page.getByRole("group", { name: "所选候选操作" })).toContainText(
    "20000"
  )
  await page.getByRole("button", { name: "取消选择", exact: true }).click()
  await page
    .locator('.table-scroll-fade [data-slot="scroll-area-viewport"]')
    .evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
  await expect(
    page.getByRole("button", {
      name: "复制候选 #20000 的完整密码",
      exact: true,
    })
  ).toBeInViewport()
  await page.screenshot({
    path: join(evidence, "native-dictionary-large-page.png"),
  })

  const query = { searchText: "嵌套归档", skip: 0, take: 1 }
  assert.equal((await invoke("history_list", { query })).totalCount, 0)
  const source = join(root, "payload.bin")
  const volumes = join(root, "[测试分组] 中文目录")
  await mkdir(volumes)
  const content = randomBytes(2 * 1024 * 1024)
  await writeFile(source, content)
  const zip = join(volumes, "嵌套归档.zip")
  const outer = join(root, "顶层归档.7z")
  const password = "native-performance-fixture"
  const create = (args) => {
    const result = spawnSync(sevenZip, args, {
      windowsHide: true,
      encoding: "utf8",
    })
    assert.equal(result.status, 0, result.stderr)
  }
  create(["a", "-tzip", "-mx0", "-v32k", zip, source])
  create(["a", "-t7z", "-mx0", "-mhe=on", `-p${password}`, outer, volumes])
  await invoke("recovery_queue_save", {
    enabled: true,
    items: [{ id: 1, path: outer, state: "waiting" }],
  })
  const task = await invoke("recovery_start", {
    request: {
      archivePath: outer,
      outputDirectory: join(root, "解压结果"),
      knownPassword: password,
      recursive: true,
      computeMode: "cpuOnly",
      queueEntryId: 1,
    },
  })
  await expect
    .poll(
      async () =>
        (await invoke("recovery_status", { taskId: task.taskId })).completed,
      { timeout: 60_000 }
    )
    .toBe(true)
  const status = await invoke("recovery_status", { taskId: task.taskId })
  assert.equal(status.success, true, status.message)
  assert.equal(status.extractedNestedArchiveCount, 1)
  await expect
    .poll(async () => (await invoke("recovery_queue_load")).items[0].state)
    .toBe("success")
  const history = await invoke("history_list", { query })
  assert.equal(history.totalCount, 1)
  assert.equal(history.matchedCount, 1)
  assert.equal(history.entries[0].children.length, 1)
  const child = history.entries[0].children[0]
  assert.ok(child.volumeCount > 60)
  assert.deepEqual(
    await readFile(join(child.outputDirectory, "payload.bin")),
    content
  )
  assert.equal(
    await invoke("history_reveal_password", { id: history.entries[0].id }),
    password
  )
  assert.deepEqual(await invoke("history_list", { query }), history)
  assert.equal(
    await invoke("history_delete", { id: history.entries[0].id }),
    true
  )
  const orphan = await invoke("history_list", { query })
  assert.equal(orphan.totalCount, 1)
  assert.equal(orphan.entries[0].id, child.id)
  assert.equal(orphan.passwordCount, 0)
  assert.equal(await invoke("history_delete", { id: child.id }), true)
  const empty = await invoke("history_list", { query })
  assert.equal(empty.totalCount, 0)
  assert.equal(empty.matchedCount, 0)
  assert.equal(empty.passwordCount, 0)
  assert.deepEqual(errors, [])
  await writeFile(
    join(evidence, "performance.json"),
    JSON.stringify(metrics, null, 2)
  )
  console.log(
    `PASS: native large dictionary / split ZIP extraction / cache invalidation / DPAPI / queue completion. ${JSON.stringify(metrics)}`
  )
}
