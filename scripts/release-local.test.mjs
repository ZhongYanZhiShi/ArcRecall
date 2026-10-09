import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
const ASSET = `ArcRecall_${VERSION}_x64-basic-setup.exe`
const FULL_ASSET = `ArcRecall_${VERSION}_x64-full-setup.exe`
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
  let remoteRelease = overrides.release
    ? { id: 1, ...structuredClone(overrides.release) }
    : null
  const execute = (command, args, options) => {
    calls.push({ command, args, options })
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
          : remoteRelease
      return JSON.stringify([release ? [release] : []])
    }
    if (command === "pnpm" && args.includes("tauri")) {
      const edition = args.includes("src-tauri/tauri.windows.basic.conf.json")
        ? "basic"
        : "full"
      const installer = `target/local-release/x86_64-pc-windows-msvc/release/bundle/nsis/${asset}`
      write(installer, `fresh ${edition} installer`)
      if (
        overrides.missingSignature !== true &&
        overrides.missingSignature !== edition
      )
        write(
          `${installer}.sig`,
          overrides.emptySignature === edition
            ? " \n"
            : `${edition}-signature\n`
        )
    }
    if (command === "gh" && args[1] === "download") {
      writeFileSync(
        args[args.indexOf("--output") + 1],
        JSON.stringify(overrides.manifest)
      )
    }
    if (command === "gh" && args[1] === "create") {
      remoteRelease = {
        id: 1,
        tag_name: tag,
        draft: true,
        prerelease: args.includes("--prerelease"),
        assets: [],
      }
    }
    if (command === "gh" && args[1] === "upload") {
      for (const file of args.slice(3, args.indexOf("--repo"))) {
        const contents = readFileSync(file)
        const name = path.basename(file)
        const asset = {
          name,
          state: "uploaded",
          size: contents.length,
          digest: `sha256:${createHash("sha256").update(contents).digest("hex")}`,
        }
        overrides.changeAsset?.(asset)
        remoteRelease.assets = remoteRelease.assets.filter(
          (existing) => existing.name !== name
        )
        remoteRelease.assets.push(asset)
      }
      overrides.afterUpload?.(remoteRelease)
    }
    if (command === "gh" && args[1] === "edit" && !overrides.unconfirmedPublish)
      remoteRelease.draft = false
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

test(
  "签名配置只添加共用公钥和签名开关，不给基础版混入完整版资源",
  {
    skip: process.platform !== "win32",
  },
  (t) => {
    const root = mkdtempSync(
      path.join(os.tmpdir(), "arcrecall-signing-config-")
    )
    t.after(() => rmSync(root, { recursive: true, force: true }))
    mkdirSync(path.join(root, "scripts"))
    mkdirSync(path.join(root, "src-tauri"))
    const script = path.join(root, "scripts", "prepare-updater-config.ps1")
    writeFileSync(
      script,
      readFileSync(new URL("./prepare-updater-config.ps1", import.meta.url))
    )
    const pubkey = Buffer.from(
      `untrusted comment: test key\n${Buffer.alloc(42).toString("base64")}\n`
    ).toString("base64")
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
      {
        encoding: "utf8",
        windowsHide: true,
        env: {
          ...process.env,
          TAURI_UPDATER_PUBLIC_KEY: pubkey,
          TAURI_SIGNING_PRIVATE_KEY: "unused-test-key",
        },
      }
    )
    assert.equal(result.status, 0, result.stderr)
    const config = JSON.parse(
      readFileSync(
        path.join(root, "src-tauri", "tauri.updater.release.conf.json"),
        "utf8"
      ).replace(/^\uFEFF/, "")
    )
    assert.deepEqual(config.bundle, { createUpdaterArtifacts: true })
    assert.equal(config.plugins.updater.pubkey, pubkey)
  }
)

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
  for (const publish of [false, true]) {
    const f = fixture(t)
    f.publish({ publish, dryRun: true })
    assert.equal(mutations(f.calls).length, 0)
    assert.ok(
      !f.calls.some(
        ({ command, args }) => command === "pnpm" && args[0] === "install"
      )
    )
  }
})

test("自动发布参数可以单独交给向导，本地打包与自动发布不能混用", () => {
  assert.equal(
    parseArguments(["--publish"], { requireTag: false }).publish,
    true
  )
  assert.throws(() => parseArguments(["--publish"]), /指定版本/)
  assert.throws(
    () => parseArguments(["--tag", TAG, "--publish", "--package-only"]),
    /不能/
  )
})

test("仅本地打包生成两版安装包、各自签名和基础版更新清单，不访问 GitHub", (t) => {
  const f = fixture(t, {
    login: "someone",
    remoteCommit: "b".repeat(40),
    tagCommit: "c".repeat(40),
  })
  const output = f.publish({ packageOnly: true })
  assert.deepEqual(
    readdirSync(output).sort(),
    [
      ASSET,
      `${ASSET}.sig`,
      FULL_ASSET,
      `${FULL_ASSET}.sig`,
      "latest.json",
    ].sort()
  )
  const manifest = JSON.parse(
    readFileSync(path.join(output, "latest.json"), "utf8")
  )
  assert.equal(manifest.version, VERSION)
  assert.equal(
    manifest.platforms["windows-x86_64"].signature,
    "basic-signature"
  )
  assert.ok(manifest.platforms["windows-x86_64"].url.endsWith(`/${ASSET}`))
  for (const [edition, name] of [
    ["basic", ASSET],
    ["full", FULL_ASSET],
  ]) {
    assert.equal(
      readFileSync(path.join(output, name), "utf8"),
      `fresh ${edition} installer`
    )
    assert.equal(
      readFileSync(path.join(output, `${name}.sig`), "utf8"),
      `${edition}-signature\n`
    )
  }
  const builds = f.calls.filter(
    ({ command, args }) => command === "pnpm" && args.includes("tauri")
  )
  assert.equal(builds.length, 2)
  for (const [index, edition] of ["basic", "full"].entries()) {
    assert.ok(
      builds[index].args.includes(
        `src-tauri/tauri.windows.${edition}.conf.json`
      )
    )
    assert.ok(
      builds[index].args.includes("src-tauri/tauri.updater.release.conf.json")
    )
  }
  assert.ok(!f.calls.some(({ command }) => command === "gh"))
  assert.ok(
    !f.calls.some(
      ({ command, args }) =>
        command === "git" &&
        ["ls-remote", "push", "tag", "commit"].includes(args[0])
    )
  )
  for (const check of ["clippy", "test"]) {
    assert.equal(
      f.calls.find(
        ({ command, args }) => command === "cargo" && args[0] === check
      ).options.env.CARGO_TARGET_DIR,
      path.join(f.root, "target", "local-release")
    )
  }
})

test("自动发布必须等两版安装包、两份签名和清单全部上传并验证通过", (t) => {
  const f = fixture(t)
  f.publish({ publish: true })
  const writes = mutations(f.calls)
  assert.deepEqual(
    writes.map(({ args }) => args[1]),
    ["create", "upload", "upload", "edit"]
  )
  assert.ok(writes[0].args.includes("--draft"))
  assert.deepEqual(
    writes[1].args
      .slice(3, writes[1].args.indexOf("--repo"))
      .map((file) => path.basename(file)),
    [ASSET, `${ASSET}.sig`, FULL_ASSET, `${FULL_ASSET}.sig`]
  )
  assert.ok(writes[2].args[3].endsWith("latest.json"))
  assert.ok(writes[3].args.includes("--draft=false"))
  assert.ok(writes[3].args.includes("--latest=true"))
})

test("自动发布 beta 保留预发布标记且不设为 Latest", (t) => {
  const f = fixture(t, { version: "0.2.0-beta.1" })
  f.publish({ publish: true })
  const writes = mutations(f.calls)
  assert.ok(writes[0].args.includes("--prerelease"))
  assert.ok(writes.at(-1).args.includes("--latest=false"))
})

test("任一附件上传失败都不正式发布，并保留完整本地产物", (t) => {
  for (const name of [ASSET, FULL_ASSET, "latest.json"]) {
    const f = fixture(t, {
      fail: (command, args) =>
        command === "gh" &&
        args[1] === "upload" &&
        args.some((arg) => arg.endsWith(name)),
    })
    assert.throws(() => f.publish({ publish: true }), /simulated/)
    assert.ok(!mutations(f.calls).some(({ args }) => args[1] === "edit"))
    const output = path.join(
      f.root,
      "artifacts",
      readdirSync(path.join(f.root, "artifacts"))[0]
    )
    assert.equal(
      JSON.parse(readFileSync(path.join(output, "latest.json"), "utf8"))
        .version,
      VERSION
    )
  }
})

test("任一远端附件哈希、大小或上传状态不正确都保留草稿", (t) => {
  for (const name of [
    ASSET,
    `${ASSET}.sig`,
    FULL_ASSET,
    `${FULL_ASSET}.sig`,
    "latest.json",
  ]) {
    for (const [field, value] of [
      ["digest", "sha256:wrong"],
      ["size", 0],
      ["state", "new"],
    ]) {
      const f = fixture(t, {
        changeAsset: (asset) => {
          if (asset.name === name) asset[field] = value
        },
      })
      assert.throws(() => f.publish({ publish: true }), /完整性校验/)
      assert.ok(!mutations(f.calls).some(({ args }) => args[1] === "edit"))
    }
  }
})

test("上传期间草稿被替换或公开时停止自动发布", (t) => {
  for (const afterUpload of [
    (release) => {
      release.id = 2
    },
    (release) => {
      release.draft = false
    },
  ]) {
    const f = fixture(t, { afterUpload })
    assert.throws(() => f.publish({ publish: true }), /草稿或源码已变化/)
    assert.ok(!mutations(f.calls).some(({ args }) => args[1] === "edit"))
  }
})

test("发布结果不确定时不报成功", (t) => {
  const uncertain = fixture(t, { unconfirmedPublish: true })
  assert.throws(() => uncertain.publish({ publish: true }), /未能确认/)
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

test("正确标记的 beta 草稿可复用", (t) => {
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
    (command, args) =>
      command === "pnpm" &&
      args.includes("src-tauri/tauri.windows.full.conf.json"),
  ]) {
    const f = fixture(t, { fail })
    assert.throws(() => f.publish(), /simulated/)
    assert.equal(mutations(f.calls).length, 0)
  }
})

test("缺失签名时不能使用上一次构建残留的签名", (t) => {
  const f = fixture(t, { missingSignature: true })
  f.write(
    `target/local-release/x86_64-pc-windows-msvc/release/bundle/nsis/ArcRecall_${VERSION}_x64-setup.exe.sig`,
    "stale signature"
  )
  assert.throws(() => f.publish(), /ENOENT/)
  assert.equal(mutations(f.calls).length, 0)
})

test("完整版缺失或签名为空时不能沿用基础版签名或上传不完整产物", (t) => {
  for (const overrides of [
    { missingSignature: "full" },
    { emptySignature: "basic" },
    { emptySignature: "full" },
  ]) {
    const f = fixture(t, overrides)
    assert.throws(() => f.publish(), /ENOENT|签名为空/)
    assert.equal(mutations(f.calls).length, 0)
  }
})

test("草稿中任一版本的安装包或签名已存在时在构建之前停止", (t) => {
  for (const name of [
    ASSET,
    `${ASSET}.sig`,
    FULL_ASSET,
    `${FULL_ASSET}.sig`,
    `ArcRecall_${VERSION}_x64-setup.exe`,
    `ArcRecall_${VERSION}_x64-setup.exe.sig`,
  ]) {
    const f = fixture(t, {
      release: {
        tag_name: TAG,
        draft: true,
        prerelease: false,
        assets: [{ name }],
      },
    })
    assert.throws(() => f.publish(), /同名/)
    assert.equal(mutations(f.calls).length, 0)
    assert.ok(!f.calls.some(({ args }) => args.includes("tauri")))
    assert.ok(
      !f.calls.some(
        ({ command, args }) => command === "pnpm" && args[0] === "install"
      )
    )
  }
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
    "basic-signature"
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
