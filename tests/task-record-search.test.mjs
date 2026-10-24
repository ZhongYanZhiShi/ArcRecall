import test from "node:test"
import assert from "node:assert/strict"
import { buildRecordDateRange } from "../src/lib/task-record-search.ts"

test("记录日期范围包含结束当天，并拒绝无效日期和反向范围", () => {
  const result = buildRecordDateRange("2026-10-01", "2026-10-02")
  assert.equal(result.fromMs, new Date(2026, 9, 1).getTime())
  assert.equal(result.beforeMs, new Date(2026, 9, 3).getTime())
  assert.deepEqual(buildRecordDateRange("", ""), {
    fromMs: null,
    beforeMs: null,
  })
  assert.throws(() => buildRecordDateRange("2026-10-03", "2026-10-02"))
  assert.throws(() => buildRecordDateRange("2026-02-30", ""))
})
