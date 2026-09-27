import assert from "node:assert/strict"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  assertPlatform,
  execute,
  mergeUpdaterManifest,
  parseArguments,
  releaseLocal,
} from "./release-local.mjs"

const VERSION = "0.2.0"
const TAG = `v${VERSION}`
const COMMIT = "a".repeat(40)
const ASSET = `ArcRecall_${VERSION}_x64-setup.exe`
const MAC_ENTRY = {
  url: "https://example.com/mac.app.tar.gz",
  signature: "mac-signature",
}

function fixture(t, overrides = {}) {
  const version = overrides.version ?? VERSION
  const tag = `v${version}`
  const asset = `ArcRecall_${version}_x64-setup.exe`
  const root = mkdtempSync(path.join(os.tmpdir(), "arcrecall-release-test-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const write = (relative, contents) => {
    const destination = path.join(root, relative)
    mkdirSync(path.dirname(destination), { recursive: true })
    writeFileSync(destination, contents)
  }
  write("package.json", JSON.stringify({ version }))
  write("src-tauri/tauri.conf.json", JSON.stringify({ version }))
  write("src-tauri/Cargo.toml", `[package]\nversion = "${version}"\n`)
  write(
    `.github/release-notes/${tag}.md`,
    "Release notes with `code` and $literal values.\n"
  )
  const calls = []
  let releaseReads = 0
  const execute = (command, args) => {
    calls.push({ command, args })
    if (overrides.fail?.(command, args))
      throw new Error("simulated command failure")
    if (command === "git") {
      if (args[0] === "status") return overrides.dirty ? " M package.json" : ""
      if (args[0] === "remote")
        return "git@github.com:ZhongYanZhiShi/ArcRecall.git"
      if (args[0] === "rev-parse")
        return args[1] === "HEAD" ? COMMIT : (overrides.tagCommit ?? COMMIT)
      if (args[0] === "ls-remote")
        return `${overrides.remoteCommit ?? COMMIT}\trefs/tags/${tag}^{}`
    }
    if (command === "gh" && args[0] === "api") {
      if (args[1] === "user") return overrides.login ?? "ZhongYanZhiShi"
      releaseReads++
      const release =
        overrides.changedRelease && releaseReads > 1
          ? overrides.changedRelease
          : overrides.release
      return JSON.stringify([release ? [release] : []])
    }
    if (command === "pnpm" && args.includes("tauri")) {
      const installer = `target/local-release/x86_64-pc-windows-msvc/release/bundle/nsis/${asset}`
      write(installer, "fresh installer")
      if (!overrides.missingSignature)
        write(`${installer}.sig`, "windows-signature\n")
    }
    if (command === "gh" && args[1] === "download") {
      writeFileSync(
        args[args.indexOf("--output") + 1],
        JSON.stringify(overrides.manifest)
      )
    }
    return ""
  }
  return {
    root,
    write,
    calls,
    publish: (options = {}) =>
      releaseLocal(
        { tag, ...options },
        {
          root,
          execute,
          log: () => {},
          platform: "win32",
          arch: "x64",
          env: {
            TAURI_UPDATER_PUBLIC_KEY: "test-public-key",
            TAURI_SIGNING_PRIVATE_KEY: "test-private-key",
          },
        }
      ),
  }
}

function mutations(calls) {
  return calls.filter(
    ({ command, args }) =>
      command === "gh" &&
      args[0] === "release" &&
      ["create", "upload", "edit", "delete"].includes(args[1])
  )
}

test("版本参数拒绝注入、路径和不合法预发布编号", () => {
  for (const tag of [
    "",
    "v01.2.0",
    "v1.0.0-beta.01",
    "v1.0.0;echo",
    "../v1.0.0",
  ]) {
    assert.throws(() => parseArguments(["--tag", tag]))
  }
  assert.deepEqual(
    parseArguments(["--", "--tag", "v1.0.0-beta.1", "--dry-run"]),
    {
      tag: "v1.0.0-beta.1",
      dryRun: true,
      help: false,
    }
  )
  assert.throws(() => parseArguments(["--tag", TAG, "--skip-checks"]))
})

test("M1 在原生兼容完成前明确阻止发布", () => {
  assert.throws(() => assertPlatform("darwin", "arm64"), /历史密码保护/)
  assert.throws(() => assertPlatform("linux", "x64"), /Windows x64/)
})

test("子进程参数不经过 shell 展开", () => {
  const literal = 'a b;$(echo secret)&quote"'
  assert.equal(
    execute(
      process.execPath,
      ["-e", "process.stdout.write(process.argv[1])", literal],
      { capture: true }
    ),
    literal
  )
})

for (const [name, overrides, expected] of [
  ["非发布者", { login: "collaborator" }, /不是发布者/],
  ["未提交源码", { dirty: true }, /未提交改动/],
  ["HEAD 与标签不一致", { tagCommit: "b".repeat(40) }, /HEAD/],
  ["远端标签不一致", { remoteCommit: "b".repeat(40) }, /远端标签/],
  [
    "已发布版本",
    { release: { tag_name: TAG, draft: false, prerelease: false, assets: [] } },
    /已正式发布/,
  ],
  [
    "同名资产",
    {
      release: {
        tag_name: TAG,
        draft: true,
        prerelease: false,
        assets: [{ name: ASSET }],
      },
    },
    /同名/,
  ],
]) {
  test(`${name}在构建和远端写入之前终止`, (t) => {
    const f = fixture(t, overrides)
    assert.throws(() => f.publish(), expected)
    assert.equal(mutations(f.calls).length, 0)
    assert.ok(
      !f.calls.some(
        ({ command, args }) => command === "pnpm" && args[0] === "install"
      )
    )
  })
}

test("dry-run 只做预检查，不安装、构建或上传", (t) => {
  const f = fixture(t)
  f.publish({ dryRun: true })
  assert.equal(mutations(f.calls).length, 0)
  assert.ok(
    !f.calls.some(
      ({ command, args }) => command === "pnpm" && args[0] === "install"
    )
  )
})

for (const [version, prerelease] of [
  ["0.2.0-beta.1", false],
  [VERSION, true],
]) {
  test(`${version} 与草稿预发布标记不匹配时在构建前终止`, (t) => {
    for (const dryRun of [false, true]) {
      const f = fixture(t, {
        version,
        release: {
          tag_name: `v${version}`,
          draft: true,
          prerelease,
          assets: [],
        },
      })
      assert.throws(() => f.publish({ dryRun }), /Pre-release/)
      assert.equal(mutations(f.calls).length, 0)
      assert.ok(
        !f.calls.some(
          ({ command, args }) => command === "pnpm" && args[0] === "install"
        )
      )
    }
  })
}

test("正确标记的 beta 草稿可复用，新建 beta 草稿自动标记预发布", (t) => {
  const version = "0.2.0-beta.1"
  const existing = fixture(t, {
    version,
    release: {
      tag_name: `v${version}`,
      draft: true,
      prerelease: true,
      assets: [],
    },
  })
  existing.publish()
  assert.deepEqual(
    mutations(existing.calls).map(({ args }) => args[1]),
    ["upload", "upload"]
  )
  const fresh = fixture(t, { version })
  fresh.publish()
  assert.ok(mutations(fresh.calls)[0].args.includes("--prerelease"))
})

test("构建期间取消 beta 草稿的预发布标记会阻止上传", (t) => {
  const version = "0.2.0-beta.1"
  const release = {
    tag_name: `v${version}`,
    draft: true,
    prerelease: true,
    assets: [],
  }
  const f = fixture(t, {
    version,
    release,
    changedRelease: { ...release, prerelease: false },
  })
  assert.throws(() => f.publish(), /Pre-release/)
  assert.ok(
    f.calls.some(
      ({ command, args }) => command === "pnpm" && args.includes("tauri")
    )
  )
  assert.equal(mutations(f.calls).length, 0)
})

test("校验或构建失败不会创建 Release", (t) => {
  for (const fail of [
    (command, args) => command === "cargo" && args[0] === "test",
    (command, args) => command === "pnpm" && args.includes("tauri"),
  ]) {
    const f = fixture(t, { fail })
    assert.throws(() => f.publish(), /simulated/)
    assert.equal(mutations(f.calls).length, 0)
  }
})

test("缺失签名时不能使用上一次构建残留的签名", (t) => {
  const f = fixture(t, { missingSignature: true })
  f.write(
    `target/local-release/x86_64-pc-windows-msvc/release/bundle/nsis/${ASSET}.sig`,
    "stale signature"
  )
  assert.throws(() => f.publish(), /ENOENT/)
  assert.equal(mutations(f.calls).length, 0)
})

test("构建过程中 Release 状态变化会阻止上传", (t) => {
  const f = fixture(t, {
    changedRelease: {
      tag_name: TAG,
      draft: true,
      prerelease: false,
      assets: [],
    },
  })
  assert.throws(() => f.publish(), /Release 已变化/)
  assert.equal(mutations(f.calls).length, 0)
})

test("成功构建只创建草稿，安装包先于更新清单上传", (t) => {
  const f = fixture(t)
  f.publish()
  const writes = mutations(f.calls)
  assert.deepEqual(
    writes.map(({ args }) => args[1]),
    ["create", "upload", "upload"]
  )
  assert.ok(writes[0].args.includes("--draft"))
  assert.ok(writes[0].args.includes("--verify-tag"))
  assert.ok(writes[0].args.includes("--notes-file"))
  assert.ok(writes[1].args[3].endsWith(ASSET))
  assert.ok(!writes[1].args.includes("--clobber"))
  const manifest = JSON.parse(readFileSync(writes[2].args[3], "utf8"))
  assert.equal(manifest.version, VERSION)
  assert.equal(
    manifest.platforms["windows-x86_64"].signature,
    "windows-signature"
  )
  assert.ok(
    manifest.platforms["windows-x86_64"].url.endsWith(`/${TAG}/${ASSET}`)
  )
})

test("追加 Windows 产物保留同一草稿的 macOS 更新入口", (t) => {
  const f = fixture(t, {
    release: {
      tag_name: TAG,
      draft: true,
      prerelease: false,
      assets: [{ name: "latest.json" }, { name: "Mac.dmg" }],
    },
    manifest: { version: VERSION, platforms: { "darwin-aarch64": MAC_ENTRY } },
  })
  f.publish()
  const writes = mutations(f.calls)
  assert.deepEqual(
    writes.map(({ args }) => args[1]),
    ["upload", "upload"]
  )
  assert.ok(writes[1].args.includes("--clobber"))
  const manifest = JSON.parse(readFileSync(writes[1].args[3], "utf8"))
  assert.deepEqual(manifest.platforms["darwin-aarch64"], MAC_ENTRY)
})

test("更新清单拒绝跨版本合并、损坏的平台数据和空签名", () => {
  const next = {
    version: VERSION,
    notes: "notes",
    signature: "signature",
    assetName: ASSET,
  }
  assert.throws(
    () => mergeUpdaterManifest({ version: "0.1.0", platforms: {} }, next),
    /版本/
  )
  assert.throws(
    () =>
      mergeUpdaterManifest({ version: VERSION, platforms: { mac: {} } }, next),
    /不完整/
  )
  assert.throws(
    () => mergeUpdaterManifest(undefined, { ...next, signature: " " }),
    /签名为空/
  )
})

test("更新清单必须是对象，platforms 和各平台条目不能是数组或标量", () => {
  const next = {
    version: VERSION,
    notes: "notes",
    signature: "signature",
    assetName: ASSET,
  }
  for (const previous of [
    null,
    false,
    0,
    "",
    [],
    ...[null, [], 7, "platforms"].map((platforms) => ({
      version: VERSION,
      platforms,
    })),
    ...[null, [], true, "entry"].map((entry) => ({
      version: VERSION,
      platforms: { "darwin-aarch64": entry },
    })),
  ]) {
    assert.throws(() => mergeUpdaterManifest(previous, next), /latest.json/)
  }
})

test("更新清单拒绝类型错误、空白签名和无效下载地址", () => {
  const next = {
    version: VERSION,
    notes: "notes",
    signature: "signature",
    assetName: ASSET,
  }
  for (const entry of [
    { ...MAC_ENTRY, url: 123 },
    { ...MAC_ENTRY, signature: true },
    { ...MAC_ENTRY, signature: " \n" },
    ...[
      "",
      "invalid",
      "/relative/path",
      "http://example.com/mac.tar.gz",
      "file:///tmp/mac.tar.gz",
      "https:example.com/mac.tar.gz",
      "https://",
      "https://example.com:invalid/file",
      "https://user:password@example.com/file",
      " https://example.com/file",
      "https://exa\nmple.com/file",
    ].map((url) => ({ ...MAC_ENTRY, url })),
  ]) {
    assert.throws(
      () =>
        mergeUpdaterManifest(
          { version: VERSION, platforms: { "darwin-aarch64": entry } },
          next
        ),
      /latest.json/
    )
  }
})

test("有效 HTTPS 下载地址和其他平台信息保持不变", () => {
  const entry = {
    ...MAC_ENTRY,
    url: "https://downloads.example.com:8443/mac%20app.tar.gz?version=0.2.0",
  }
  const previous = { version: VERSION, platforms: { "darwin-aarch64": entry } }
  const merged = mergeUpdaterManifest(previous, {
    version: VERSION,
    notes: "notes",
    signature: "signature",
    assetName: ASSET,
  })
  assert.deepEqual(merged.platforms["darwin-aarch64"], entry)
  assert.deepEqual(Object.keys(previous.platforms), ["darwin-aarch64"])
})

test("下载到损坏清单时不上传任何资产", (t) => {
  for (const manifest of [
    null,
    {
      version: VERSION,
      platforms: { "darwin-aarch64": { url: 123, signature: true } },
    },
  ]) {
    const f = fixture(t, {
      release: {
        tag_name: TAG,
        draft: true,
        prerelease: false,
        assets: [{ name: "latest.json" }],
      },
      manifest,
    })
    assert.throws(() => f.publish(), /latest.json/)
    assert.equal(mutations(f.calls).length, 0)
  }
})
