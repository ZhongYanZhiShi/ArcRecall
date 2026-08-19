import assert from "node:assert/strict"
import test from "node:test"

import {
  importDictionaryFile,
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
