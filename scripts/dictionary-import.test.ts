import assert from "node:assert/strict"
import test from "node:test"

import {
  detectDictionaryEncoding,
  DictionaryImportError,
  importDictionaryFile,
  listDictionary,
  MAX_DICTIONARY_CANDIDATE_BYTES,
} from "../src/lib/dictionary.ts"

test("编码预检可取消，且不会提交任何候选", async () => {
  const controller = new AbortController()
  const file = new File(["cancel-preflight-only\n".repeat(10000)], "cancel.txt")
  await assert.rejects(
    importDictionaryFile(file, {
      signal: controller.signal,
      onProgress(progress) {
        assert.equal(progress.phase, "validating")
        assert.equal(progress.summary.addedCount, 0)
        if (progress.processedBytes > 0) controller.abort()
      },
    }),
    (error: unknown) =>
      error instanceof DictionaryImportError &&
      error.cancelled &&
      error.summary.addedCount === 0
  )
  assert.equal(
    (await listDictionary({ searchText: "cancel-preflight-only" }))
      .matchedCount,
    0
  )
})

test("导入中取消保留已提交批次并报告准确数量", async () => {
  const controller = new AbortController()
  const rows = Array.from(
    { length: 10000 },
    (_, index) => `cancel-after-commit-${index}`
  )
  let committed = 0
  await assert.rejects(
    importDictionaryFile(new File([rows.join("\n")], "cancel.txt"), {
      signal: controller.signal,
      onProgress(progress) {
        if (progress.phase === "importing" && progress.summary.addedCount > 0) {
          committed = progress.summary.addedCount
          controller.abort()
        }
      },
    }),
    (error: unknown) =>
      error instanceof DictionaryImportError &&
      error.cancelled &&
      error.summary.addedCount === committed
  )
  assert.equal(committed, 4096)
  assert.equal(
    (await listDictionary({ searchText: "cancel-after-commit-" })).matchedCount,
    committed
  )
  assert.equal(
    (await listDictionary({ searchText: "cancel-after-commit-9999" }))
      .matchedCount,
    0
  )
})

test("大字典逐片读取，后续读取失败仍返回已提交数量", async () => {
  const file = new File(
    [
      Array.from(
        { length: 12000 },
        (_, index) => `read-failure-after-commit-${index}`
      ).join("\n"),
    ],
    "partial.txt"
  )
  const slice = file.slice.bind(file)
  let failRead = false
  let committed = 0
  file.arrayBuffer = async () => {
    throw new Error("不得全量读取")
  }
  file.slice = (start, end, type) => {
    const blob = slice(start, end, type)
    if (failRead)
      blob.arrayBuffer = async () => {
        throw new Error("模拟读取失败")
      }
    return blob
  }
  await assert.rejects(
    importDictionaryFile(file, {
      onProgress(progress) {
        if (progress.summary.addedCount > 0) {
          committed = progress.summary.addedCount
          failRead = true
        }
      },
    }),
    (error: unknown) =>
      error instanceof DictionaryImportError &&
      !error.cancelled &&
      error.message === "模拟读取失败" &&
      error.summary.addedCount === committed
  )
  assert.ok(committed > 0 && committed < 12000)
  assert.equal(
    (await listDictionary({ searchText: "read-failure-after-commit-" }))
      .matchedCount,
    committed
  )
})

test("字典导入丢弃超大单行并继续处理后续候选", async () => {
  const file = new File(
    ["x".repeat(MAX_DICTIONARY_CANDIDATE_BYTES + 1), "\nvalid-candidate"],
    "oversized-line.txt",
    { type: "text/plain" }
  )

  const summary = await importDictionaryFile(file)

  assert.deepEqual(summary, {
    submittedCount: 2,
    addedCount: 1,
    duplicateCount: 0,
    invalidCount: 1,
  })
})

test("字典导入自动识别 GBK/GB18030 中文候选", async () => {
  const file = new File(
    [new Uint8Array([0xc3, 0xdc, 0xc2, 0xeb, 0x0a])],
    "gbk-dictionary.txt",
    { type: "text/plain" }
  )

  const summary = await importDictionaryFile(file)
  const result = await listDictionary({
    searchText: "密码",
    skip: 0,
    take: 10,
  })

  assert.equal(summary.addedCount, 1)
  assert.equal(result.matchedCount, 1)
  assert.equal(result.entries[0]?.value, "密码")
})

test("UTF-8 探测样本截断多字节字符时不会误判编码", async () => {
  const file = new File(
    ["x".repeat(64 * 1024 - 1), "密码\n"],
    "utf8-boundary.txt",
    { type: "text/plain" }
  )

  assert.equal(await detectDictionaryEncoding(file), "utf-8")
})

test("无换行结尾的 CRLF 字典不会把回车写入候选", async () => {
  const file = new File(["final-candidate\r"], "crlf-no-newline.txt", {
    type: "text/plain",
  })

  await importDictionaryFile(file)
  const result = await listDictionary({
    searchText: "final-candidate",
    skip: 0,
    take: 10,
  })

  assert.equal(result.entries[0]?.value, "final-candidate")
})

test("超过 64 KiB 的 ASCII 前缀后仍能正确导入 GB18030", async () => {
  const file = new File(
    [
      "prefix\n".repeat(12000),
      new Uint8Array([0xd6, 0xd0, 0xce, 0xc4, 0x90, 0x30, 0x81, 0x30]),
    ],
    "late-gb18030.txt"
  )
  assert.equal(await detectDictionaryEncoding(file), "gb18030")
  await importDictionaryFile(file)
  const result = await listDictionary({ searchText: "中文", skip: 0, take: 10 })
  assert.equal(result.entries[0]?.value, "中文𐀀")
})

test("BOM 字典保留 UTF-16 字符且拒绝损坏文件的所有批次", async () => {
  for (const [encoding, bytes] of [
    ["utf-16le", [0xff, 0xfe, 0x2d, 0x4e]],
    ["utf-16be", [0xfe, 0xff, 0x4e, 0x2d]],
  ] as const) {
    const file = new File([new Uint8Array(bytes)], `${encoding}.txt`)
    assert.equal(await detectDictionaryEncoding(file), encoding)
    await importDictionaryFile(file)
  }
  assert.equal(
    (
      await listDictionary({ searchText: "中", skip: 0, take: 10 })
    ).entries.some((row) => row.value === "中"),
    true
  )
  for (const bom of [[], [0xef, 0xbb, 0xbf]]) {
    const file = new File(
      [
        new Uint8Array(bom),
        "must-not-import\n".repeat(12000),
        new Uint8Array([0xff]),
      ],
      "invalid.txt"
    )
    await assert.rejects(importDictionaryFile(file), /尚未导入任何候选/)
    assert.equal(
      (
        await listDictionary({
          searchText: "must-not-import",
          skip: 0,
          take: 10,
        })
      ).matchedCount,
      0
    )
  }
})
