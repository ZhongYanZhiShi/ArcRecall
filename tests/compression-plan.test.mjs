import assert from "node:assert/strict"
import test from "node:test"
import { buildCompressionPlan } from "../src/lib/compression-plan.ts"
import { createCompressionDraft } from "../src/lib/compression-draft.ts"

test("单次与分别压缩共享输出和凭据校验，重试必须重新输入密码", () => {
  for (const packagingMode of ["combined", "separate"]) {
    const draft = {
      ...createCompressionDraft(),
      sources: ["C:/资料"],
      baseName: "归档",
      packagingMode,
    }
    assert.throws(
      () => buildCompressionPlan({ ...draft, outputMode: "custom" }, false),
      /输出目录/
    )
    assert.throws(
      () => buildCompressionPlan({ ...draft, encryptFileNames: true }, false),
      /设置密码/
    )
    assert.throws(
      () =>
        buildCompressionPlan(
          { ...draft, password: "测试", passwordConfirmation: "不同" },
          false
        ),
      /不一致/
    )
    assert.throws(
      () =>
        buildCompressionPlan({ ...draft, retryPasswordRequired: true }, true),
      /重新输入密码/
    )
    assert.doesNotThrow(() =>
      buildCompressionPlan({ ...draft, encryptFileNames: true }, true)
    )
  }
})

test("批量计划保留来源顺序与本地日期，待入队请求不包含密码", () => {
  const draft = {
    ...createCompressionDraft(),
    packagingMode: "separate",
    sources: ["C:/[测试分组] 中文目录/", "C:/资料/{date}.txt"],
    password: "会话密码",
    passwordConfirmation: "会话密码",
    batchNameTemplate: "{name}-{date}",
  }
  const plan = buildCompressionPlan(draft, false, new Date(2026, 0, 2))
  assert.equal(plan.separate, true)
  assert.deepEqual(
    plan.requests.map((request) => request.baseName),
    ["[测试分组] 中文目录-2026-01-02", "{date}.txt-2026-01-02"]
  )
  assert.deepEqual(
    plan.requests.map((request) => request.sources),
    draft.sources.map((source) => [source])
  )
  assert.equal(JSON.stringify(plan.requests).includes("会话密码"), false)
  assert.equal(plan.passwordRequired, true)
  assert.equal(plan.credentials.password, "会话密码")
  const combined = buildCompressionPlan(
    { ...draft, packagingMode: "combined", baseName: "  合并  " },
    false
  )
  assert.deepEqual(combined.requests[0].sources, draft.sources)
  assert.equal(combined.requests[0].baseName, "合并")
})
