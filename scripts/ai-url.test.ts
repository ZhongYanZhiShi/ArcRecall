import assert from "node:assert/strict"
import test from "node:test"

import { validateAiServiceUrl } from "../src/lib/ai-url.ts"

test("AI 服务地址只允许本机明文 HTTP", () => {
  assert.equal(validateAiServiceUrl("http://127.0.0.1:11434/v1"), null)
  assert.equal(validateAiServiceUrl("http://[::1]:11434/v1"), null)
  assert.equal(validateAiServiceUrl("http://models.localhost:1234/v1"), null)
  assert.equal(validateAiServiceUrl("https://api.example.com/v1"), null)
  assert.match(
    validateAiServiceUrl("http://192.168.1.20:8080/v1") ?? "",
    /必须使用 https/
  )
})

test("AI 服务地址拒绝内嵌凭据", () => {
  assert.match(
    validateAiServiceUrl("https://user:secret@example.com/v1") ?? "",
    /不能包含用户名或密码/
  )
})
