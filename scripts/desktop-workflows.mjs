import assert from "node:assert/strict"
import { join } from "node:path"
import { readFile } from "node:fs/promises"
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
