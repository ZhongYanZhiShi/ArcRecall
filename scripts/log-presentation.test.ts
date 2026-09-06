import assert from "node:assert/strict"
import test from "node:test"

import {
  formatBytes,
  isRoutineLogDetail,
  presentLogEntry,
} from "../src/components/home/log-presentation.ts"
import type { LogEntry } from "../src/lib/logging.ts"

function logEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    id: "log-1",
    timestampMs: 1,
    level: "info",
    source: "recovery",
    event: "custom.event",
    message: "默认日志消息。",
    context: {},
    ...overrides,
  }
}

test("恢复完成摘要集中呈现引擎与嵌套归档结果", () => {
  const presentation = presentLogEntry(
    logEntry({
      event: "recovery.completed",
      context: {
        engine: "7-Zip",
        nested_extracted: "4",
        nested_skipped: "2",
      },
    })
  )

  assert.equal(presentation.title, "恢复与解压完成")
  assert.equal(
    presentation.description,
    "使用 7-Zip · 处理了 4 个嵌套压缩包 · 2 个嵌套压缩包未处理"
  )
})

test("未知事件只展示允许的通用上下文且去掉句末标点", () => {
  const presentation = presentLogEntry(
    logEntry({
      message: "候选字典已更新。",
      context: {
        added_count: "3",
        duplicate_count: "2",
        secret: "不应展示",
      },
    })
  )

  assert.equal(presentation.title, "候选字典已更新")
  assert.equal(presentation.description, "新增 3 · 重复 2")
})

test("过程日志与调试日志由结构化字段识别", () => {
  assert.equal(
    isRoutineLogDetail(logEntry({ event: "archive.analyzed" })),
    true
  )
  assert.equal(isRoutineLogDetail(logEntry({ level: "debug" })), true)
  assert.equal(
    isRoutineLogDetail(logEntry({ event: "recovery.failed" })),
    false
  )
})

test("字节数使用稳定的二进制单位格式", () => {
  assert.equal(formatBytes(1024), "1.0 KiB")
  assert.equal(formatBytes(1024 * 1024), "1.0 MiB")
  assert.equal(formatBytes(Number.NaN), "0 B")
})
