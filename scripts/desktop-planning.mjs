import assert from "node:assert/strict"
import { join } from "node:path"
import { mkdir, writeFile, copyFile, readFile, symlink } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { expect } from "@playwright/test"

export async function verifyPlanning({
  invoke,
  page,
  archive,
  data,
  evidence,
}) {
  const root = join(data, "[测试分组] 扫描目录")
  await mkdir(join(root, "子目录"), { recursive: true })
  await copyFile(archive, join(root, "伪装归档.dll"))
  await copyFile(archive, join(root, "子目录", "嵌套归档.7z"))
  await writeFile(join(root, "说明.txt"), "ordinary file")
  await writeFile(join(root, "损坏归档.zip"), "broken")
  await symlink(root, join(root, "循环链接"), "junction")
  const sevenZip =
    process.env.ARC_RECALL_TEST_7ZIP ?? "C:/Program Files/7-Zip/7z.exe"
  const split = join(root, "分卷归档.7z")
  const created = spawnSync(
    sevenZip,
    ["a", "-t7z", "-v100b", split, join(root, "说明.txt")],
    { windowsHide: true, encoding: "utf8" }
  )
  assert.equal(created.status, 0, created.stderr)
  const scan = (includeSubfolders) =>
    invoke("archive_folder_scan", {
      id: crypto.randomUUID(),
      path: root,
      includeSubfolders,
    })
  const shallow = await scan(false)
  assert.equal(shallow.entries.length, 2)
  const deep = await scan(true)
  assert.equal(deep.entries.length, 3)
  assert.equal(deep.skippedLinks, 1)
  assert.equal(deep.warnings.length, 1)
  assert.ok(deep.entries.find((entry) => entry.path.endsWith(".dll")))
  assert.ok(
    deep.entries.find((entry) => entry.volumeCount > 1)?.volumePaths.length > 1
  )
  await assert.rejects(
    invoke("archive_folder_scan", {
      id: crypto.randomUUID(),
      path: join(root, "循环链接"),
      includeSubfolders: true,
    })
  )
  const preset = {
    name: "资料处理",
    outputDirectory: root,
    recursive: false,
    computeMode: "cpuOnly",
    dictionaryGroup: null,
    openWhenDone: false,
  }
  await invoke("processing_preset_save", { preset, overwrite: false })
  await assert.rejects(
    invoke("processing_preset_save", { preset, overwrite: false })
  )
  await assert.rejects(
    invoke("processing_preset_save", {
      preset: { ...preset, knownPassword: "do-not-store" },
      overwrite: true,
    })
  )
  assert.deepEqual(
    await invoke("processing_preset_apply", { name: preset.name }),
    preset
  )
  await invoke("processing_preset_save", {
    preset: { ...preset, recursive: true },
    overwrite: true,
  })
  assert.equal(
    (await invoke("processing_preset_apply", { name: preset.name })).recursive,
    true
  )
  await invoke("processing_preset_save", {
    preset: { ...preset, name: "失效分组", dictionaryGroup: "已删除分组" },
    overwrite: false,
  })
  await assert.rejects(invoke("processing_preset_apply", { name: "失效分组" }))
  await invoke("processing_preset_delete", { name: "失效分组" })
  await invoke("processing_preset_save", {
    preset: {
      ...preset,
      name: "失效输出",
      outputDirectory: join(root, "不存在"),
    },
    overwrite: false,
  })
  await assert.rejects(invoke("processing_preset_apply", { name: "失效输出" }))
  await invoke("processing_preset_delete", { name: "失效输出" })
  assert.ok(
    !(await readFile(join(data, "processing-presets.db"))).includes(
      Buffer.from("do-not-store")
    )
  )
  await page.keyboard.press("Escape")
  await page.getByRole("button", { name: "解压", exact: true }).click()
  await page.getByRole("button", { name: "处理预设", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "处理预设", exact: true })
  await dialog.getByRole("combobox", { name: "已保存预设" }).click()
  await page.getByRole("option", { name: "资料处理", exact: true }).click()
  await dialog.getByRole("button", { name: "应用预设", exact: true }).click()
  await expect(dialog).not.toBeVisible()
  await page.getByRole("button", { name: "处理预设", exact: true }).click()
  await expect(
    page
      .getByRole("dialog", { name: "处理预设", exact: true })
      .getByText("输出：" + root, { exact: false })
      .first()
  ).toBeVisible()
  await page.screenshot({
    path: join(evidence, "processing-presets.png"),
    animations: "disabled",
  })
  await page.keyboard.press("Escape")
  console.log(
    "PASS: real preset persistence, password rejection, invalid references, recursive scanning, disguised archives, volume grouping and junction exclusion"
  )
}
