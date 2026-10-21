import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { expect } from "@playwright/test"

export async function seedLongContent({
  invoke,
  root,
  evidence,
  sevenZip,
  historyCount = 16,
}) {
  const folder = join(
    root,
    "[测试分组] 中文 空格 长路径",
    "连续多层归档目录与版本资料"
  )
  await mkdir(folder, { recursive: true })
  const longName =
    "[布局验证] 多语言资料归档_" + "LongUnbrokenFileName0123456789".repeat(3)
  const longText =
    "连续无空格候选内容" + "LongUnbrokenText0123456789".repeat(12)
  const multiline = Array.from(
    { length: 80 },
    (_, i) => `${i + 1}-${longText}`
  ).join("\n")
  const sources = []
  for (let i = 0; i < 24; i++) {
    const source = join(folder, `${i}-${longName}.txt`)
    await writeFile(source, `通用测试内容 ${i}\n${longText}`)
    sources.push(source)
  }
  await invoke("dictionary_add", {
    candidates: Array.from({ length: 620 }, (_, i) => `${i}-${longText}`),
  })
  let ai
  for (let i = 0; i < 12; i++)
    ai = await invoke("ai_profile_upsert", {
      request: {
        name: `${i}-长配置名称_${"ModelConfiguration".repeat(3)}`,
        provider: "custom",
        baseUrl: "http://127.0.0.1:9/" + "long-path/".repeat(8) + "v1",
        model: "long-model-" + "ModelIdentifier".repeat(8),
        makeActive: true,
      },
    })
  await invoke("ai_settings_update", {
    request: {
      activeProfileId: ai.activeProfileId,
      renamePrompt: multiline.slice(0, 12000),
    },
  })
  for (let i = 0; i < historyCount; i++) {
    const archive = join(folder, `${i}-${longName}.7z`)
    assert.equal(
      spawnSync(
        sevenZip,
        ["a", "-t7z", "-pfixture-layout", archive, sources[i]],
        { windowsHide: true, stdio: "ignore" }
      ).status,
      0
    )
    const task = await invoke("recovery_start", {
      request: {
        archivePath: archive,
        outputDirectory: join(folder, `结果-${i}`),
        knownPassword: "fixture-layout",
        recursive: false,
        computeMode: "cpuOnly",
      },
    })
    await expect
      .poll(
        async () =>
          (await invoke("recovery_status", { taskId: task.taskId })).completed,
        { timeout: 30000, intervals: [100, 200, 400] }
      )
      .toBe(true)
    assert.equal(
      (await invoke("recovery_status", { taskId: task.taskId })).success,
      true
    )
  }
  const history = await invoke("history_list", {
    query: { skip: 0, take: 100 },
  })
  assert.ok(history.totalCount >= historyCount)
  await writeFile(
    join(evidence, "long-content-fixture.json"),
    JSON.stringify(
      {
        sourceCount: sources.length,
        historyCount: history.totalCount,
        dictionaryCount: 620,
        profileCount: 12,
        pathLength: sources[0].length,
        fileNameLength: longName.length,
        candidateLength: longText.length,
        multilineRows: 80,
      },
      null,
      2
    )
  )
  return { folder, longName, longText, multiline, sources }
}
