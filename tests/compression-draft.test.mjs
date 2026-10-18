import assert from "node:assert/strict"
import test from "node:test"

import {
  createCompressionDraft,
  parseAiReferenceExtensions,
  shouldAutoOpenCompletedTask,
  shouldForgetArchiveBaseName,
} from "../src/lib/compression-draft.ts"

test("file content reference is opt-in with editable text extensions", () => {
  const draft = createCompressionDraft()
  assert.equal(draft.useAiFileReference, false)
  assert.equal(draft.aiReferenceExtensions, "txt, md")
  assert.deepEqual(draft.aiCustomReferenceExtensions, [])
})

test("custom reference suffixes normalize dotted and wildcard forms without duplicates", () => {
  assert.deepEqual(parseAiReferenceExtensions(".TXT, *.md；txt rst，d.ts"), [
    "txt",
    "md",
    "rst",
    "d.ts",
  ])
  assert.deepEqual(parseAiReferenceExtensions(""), [])
  for (const suffix of ["*", "../txt", "txt/path", "json.", "x".repeat(33)]) {
    assert.throws(() => parseAiReferenceExtensions(suffix), /有效后缀/)
  }
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
