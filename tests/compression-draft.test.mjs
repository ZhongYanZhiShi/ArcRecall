import assert from "node:assert/strict"
import test from "node:test"

import {
  forgetCompletedArchiveBaseName,
  shouldForgetArchiveBaseName,
} from "../src/lib/compression-draft.ts"

test("a completed archive name is not carried into the next archive", () => {
  const nextDraft = forgetCompletedArchiveBaseName({
    baseName: "内部项目资料",
    format: "sevenZip",
  })

  assert.deepEqual(nextDraft, {
    baseName: "",
    format: "sevenZip",
  })
})

test("only an observed running task forgets its name after success", () => {
  const awaitingCompletion = new Set()

  assert.equal(
    shouldForgetArchiveBaseName(
      { taskId: "historical", running: false, completed: true, success: true },
      awaitingCompletion
    ),
    false
  )
  assert.equal(
    shouldForgetArchiveBaseName(
      { taskId: "current", running: true, completed: false, success: false },
      awaitingCompletion
    ),
    false
  )
  assert.equal(
    shouldForgetArchiveBaseName(
      { taskId: "current", running: false, completed: true, success: true },
      awaitingCompletion
    ),
    true
  )
})
