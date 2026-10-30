import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { expect } from "@playwright/test"

export async function verifyBackground({
  invoke,
  getPage,
  root,
  evidence,
  sevenZip,
  close,
  launch,
}) {
  const payload = join(root, "内容.txt")
  const inner = join(root, "嵌套归档.zip")
  const outer = join(root, "外层归档.zip")
  await writeFile(payload, "嵌套持久化验证")
  for (const [target, source] of [
    [inner, payload],
    [outer, inner],
  ]) {
    const result = spawnSync(sevenZip, ["a", "-tzip", target, source], {
      windowsHide: true,
      encoding: "utf8",
    })
    assert.equal(result.status, 0, result.stderr)
  }
  const started = await invoke("recovery_start", {
    request: {
      archivePath: outer,
      outputDirectory: join(root, "输出"),
      recursive: true,
      computeMode: "cpuOnly",
    },
  })
  await invoke("plugin:window|close", { label: "main" })
  await expect
    .poll(() => invoke("plugin:window|is_visible", { label: "main" }))
    .toBe(false)
  await expect
    .poll(
      async () =>
        (await invoke("recovery_status", { taskId: started.taskId }))
          ?.completed,
      { timeout: 60000 }
    )
    .toBe(true)
  const result = await invoke("recovery_status", { taskId: started.taskId })
  assert.equal(result.success, true, result.message)
  assert.equal(result.archiveTree.length, 2)
  const records = () =>
    invoke("task_records_list", { skip: 0, failedOnly: false, operation: null })
  await expect
    .poll(
      async () =>
        (await records()).find((r) => r.taskId === started.taskId)?.archiveTree
          ?.length
    )
    .toBe(2)
  await invoke("notify_task_finished", { success: true })
  await invoke("background_show")
  await expect
    .poll(() => invoke("plugin:window|is_visible", { label: "main" }))
    .toBe(true)
  if (process.env.ARC_RECALL_TEST_UI_HOLD === "1") {
    console.log("Ready for tray and notification UI verification")
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Number(process.env.ARC_RECALL_TEST_UI_HOLD_MS ?? 90000)
      )
    )
  }
  await close()
  await launch()
  const persisted = (await records()).find((r) => r.taskId === started.taskId)
  assert.deepEqual(persisted.archiveTree, result.archiveTree)
  const page = getPage()
  await page.getByRole("button", { name: "历史", exact: true }).click()
  await page.getByRole("button", { name: "任务记录", exact: true }).click()
  await expect(page.getByText("嵌套归档结果树（2）")).toBeVisible()
  await page.screenshot({
    path: join(evidence, "persistent-tree-after-restart.png"),
  })
  await writeFile(
    join(evidence, "background-verification.json"),
    JSON.stringify(
      {
        treePersistedAcrossRestart: true,
        hiddenWindowTaskCompleted: true,
        showHandler: true,
        gracefulExit: true,
        notificationApiAccepted: true,
        notificationVisualDelivery:
          "Requires Windows notification UI verification",
      },
      null,
      2
    )
  )
}
