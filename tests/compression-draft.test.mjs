import assert from "node:assert/strict"
import test from "node:test"

import {
  shouldAutoOpenCompletedTask,
  shouldForgetArchiveBaseName,
} from "../src/lib/compression-draft.ts"

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

test("enabling auto-open after completion does not reopen an old archive", () => {
  const observedCompletions = new Set()
  const task = { taskId: "done", completed: true, success: true }

  assert.equal(
    shouldAutoOpenCompletedTask(task, false, observedCompletions),
    false
  )
  assert.equal(
    shouldAutoOpenCompletedTask(task, true, observedCompletions),
    false
  )
})
