import assert from "node:assert/strict"
import test from "node:test"

import {
  detectDictionaryEncoding,
  importDictionaryFile,
  listDictionary,
  MAX_DICTIONARY_CANDIDATE_BYTES,
} from "../src/lib/dictionary.ts"

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
