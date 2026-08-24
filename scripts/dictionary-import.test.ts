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
