import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createInterface } from "node:readline/promises"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
  assertDraft,
  assertPlatform,
  execute,
  getRelease,
  OWNER,
  parseArguments,
  releaseLocal,
  REPOSITORY,
  versionFromTag,
} from "./release-local.mjs"

const ROOT = fileURLToPath(new URL("../", import.meta.url))
const VERSION_FILES = [
  "package.json",
  "src-tauri/tauri.conf.json",
  "src-tauri/Cargo.toml",
  "Cargo.lock",
]

export function suggestedVersion(current) {
  versionFromTag(`v${current}`)
  const [stable, prerelease] = current.split("-")
  const [major, minor, patch] = stable.split(".")
  return prerelease ? stable : `${major}.${minor}.${BigInt(patch) + 1n}`
}

export function compareVersions(left, right) {
  versionFromTag(`v${left}`)
  versionFromTag(`v${right}`)
  const parts = (value) => {
    const [stable, ...prerelease] = value.split("-")
    return [stable.split("."), prerelease.join("-").split(".").filter(Boolean)]
  }
  const [a, ap] = parts(left)
  const [b, bp] = parts(right)
  for (let i = 0; i < 3; i++) {
    if (BigInt(a[i]) !== BigInt(b[i]))
      return BigInt(a[i]) > BigInt(b[i]) ? 1 : -1
  }
  if (!ap.length || !bp.length) return Number(!ap.length) - Number(!bp.length)
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    if (ap[i] === bp[i]) continue
    if (ap[i] === undefined) return -1
    if (bp[i] === undefined) return 1
    const an = /^\d+$/.test(ap[i])
    const bn = /^\d+$/.test(bp[i])
    if (an && bn) return BigInt(ap[i]) > BigInt(bp[i]) ? 1 : -1
    if (an !== bn) return an ? -1 : 1
    return ap[i] > bp[i] ? 1 : -1
  }
  return 0
}

// Replace only the application version; leave dependency versions and formatting intact.
export function versionEdits(root, version) {
  versionFromTag(`v${version}`)
  const current = JSON.parse(
    readFileSync(path.join(root, VERSION_FILES[0]), "utf8")
  ).version
  const patterns = [
    /("version"\s*:\s*")[^"]+("\s*[,}])/,
    /("version"\s*:\s*")[^"]+("\s*[,}])/,
    /(^version\s*=\s*")[^"]+(")/m,
    /(\[\[package\]\]\r?\nname = "arc-recall-desktop"\r?\nversion = ")[^"]+(")/,
  ]
  return VERSION_FILES.map((file, i) => {
    const content = readFileSync(path.join(root, file), "utf8")
    const match = patterns[i].exec(content)
    if (!match || match[0] !== `${match[1]}${current}${match[2]}`) {
      throw new Error(`${file} 的版本与 package.json 不一致，请先修正并提交。`)
    }
    return [
      file,
      content.replace(
        patterns[i],
        (_, before, after) => `${before}${version}${after}`
      ),
    ]
  })
}

export async function releaseWizard(options, dependencies = {}) {
  const root = dependencies.root ?? ROOT
  const env = dependencies.env ?? process.env
  const command = dependencies.execute ?? execute
  const ask = dependencies.ask
  const log = dependencies.log ?? console.log
  const run = (program, args, extra = {}) =>
    command(program, args, { cwd: root, ...extra })
  const read = (program, args) => run(program, args, { capture: true })
  const clean = () => {
    if (read("git", ["status", "--porcelain", "--untracked-files=normal"])) {
      throw new Error(
        "工作区有未提交改动。请先检查并提交，再运行 pnpm release。"
      )
    }
  }
  assertPlatform(
    dependencies.platform ?? process.platform,
    dependencies.arch ?? process.arch
  )
  if (env.GITHUB_ACTIONS === "true")
    throw new Error("一键发布只允许在本机运行。")
  clean()
  if (read("git", ["branch", "--show-current"]) !== "main") {
    throw new Error("请先切换到 main 分支，一键发布仅从 main 执行。")
  }
  const head = read("git", ["rev-parse", "HEAD"])
  if (
    read("gh", ["api", "user", "--jq", ".login"]).toLowerCase() !==
    OWNER.toLowerCase()
  ) {
    throw new Error(`请先使用 gh auth login / gh auth switch 登录 ${OWNER}。`)
  }
  if (
    !/^((git@github\.com:)|(https:\/\/github\.com\/))ZhongYanZhiShi\/ArcRecall(?:\.git)?$/i.test(
      read("git", ["remote", "get-url", "origin"])
    )
  ) {
    throw new Error(`origin 必须指向 github.com/${REPOSITORY}。`)
  }
  read("pnpm", ["--version"])
  read("cargo", ["--version"])
  for (const key of ["TAURI_UPDATER_PUBLIC_KEY", "TAURI_SIGNING_PRIVATE_KEY"]) {
    if (!env[key]?.trim())
      throw new Error(`缺少 ${key}，请使用 pnpm release 启动。`)
  }
  // Validate the public key before creating a commit or a remote tag.
  run("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    "./scripts/prepare-updater-config.ps1",
  ])
  const current = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf8")
  ).version
  const suggested = suggestedVersion(current)
  const input =
    options.tag ??
    ((await ask(`新版本号 [${suggested}]：`)).trim() || suggested)
  const tag = input.startsWith("v") ? input : `v${input}`
  const version = versionFromTag(tag)
  const comparison = compareVersions(version, current)
  if (comparison < 0) throw new Error(`新版本必须高于当前版本 ${current}。`)
  const resume = comparison === 0
  const edits = versionEdits(root, version)
  const localTag = read("git", ["tag", "--list", tag])
  const remoteTag = read("git", [
    "ls-remote",
    "origin",
    `refs/tags/${tag}`,
    `refs/tags/${tag}^{}`,
  ])
  if (!resume && (localTag || remoteTag))
    throw new Error(`${tag} 已存在，请使用新版本号。`)
  if (
    localTag &&
    read("git", ["rev-parse", `refs/tags/${tag}^{commit}`]) !== head
  ) {
    throw new Error(`${tag} 与 HEAD 不一致，拒绝移动已有标签。`)
  }
  if (remoteTag) {
    const refs = remoteTag.split(/\r?\n/).map((line) => line.split(/\s+/))
    const remoteCommit =
      refs.find(([, ref]) => ref.endsWith("^{}"))?.[0] ?? refs[0][0]
    if (remoteCommit !== head)
      throw new Error(`${tag} 的远端标签与 HEAD 不一致。`)
  }
  assertDraft(getRelease(read, tag), tag)
  const notesFile = `.github/release-notes/${tag}.md`
  const notesPath = path.join(root, notesFile)
  let notes
  if (existsSync(notesPath)) {
    notes = readFileSync(notesPath, "utf8")
  } else {
    if (resume) throw new Error(`缺少 ${notesFile}，请补充并提交后重试。`)
    log("输入面向用户的更新说明，每行一项；单独输入 . 结束：")
    const lines = []
    for (;;) {
      const line = (await ask("> ")).trim()
      if (line === ".") break
      if (line) lines.push(line.startsWith("- ") ? line : `- ${line}`)
    }
    if (!lines.length) throw new Error("更新说明不能为空。")
    notes = `# ArcRecall ${tag}\n\n${lines.join("\n")}\n`
  }
  if (!notes.trim()) throw new Error("更新说明不能为空。")
  // Fetch only main; refuse to publish a branch that is behind or has diverged.
  run("git", ["fetch", "--no-tags", "origin", "main"])
  try {
    read("git", ["merge-base", "--is-ancestor", "FETCH_HEAD", "HEAD"])
  } catch {
    throw new Error(
      "本地 main 未包含远端最新提交，请先同步分支并解决冲突，再运行发布。"
    )
  }
  log(
    `\n${resume ? "继续发布" : "准备发布"} ${tag} → ${REPOSITORY}（草稿）\n${notes}`
  )
  log(
    resume
      ? "将核对并推送 main / 标签，然后检查、打包和上传。"
      : "将修改三个版本文件及 Cargo.lock，提交更新说明，推送 main / 标签，然后检查、打包和上传。"
  )
  if (!/^(y|yes)$/i.test((await ask("开始执行？[y/N]：")).trim())) {
    log("已取消，未修改版本文件、提交、推送或上传。")
    return
  }
  clean()
  if (
    read("git", ["rev-parse", "HEAD"]) !== head ||
    read("git", ["branch", "--show-current"]) !== "main"
  ) {
    throw new Error("准备期间分支或 HEAD 已变化，请重新运行。")
  }
  try {
    if (!resume) {
      for (const [file, content] of edits)
        writeFileSync(path.join(root, file), content)
      mkdirSync(path.dirname(notesPath), { recursive: true })
      writeFileSync(notesPath, notes)
      const files = [...VERSION_FILES, notesFile]
      run("pnpm", [
        "exec",
        "oxfmt",
        "package.json",
        "src-tauri/tauri.conf.json",
        notesFile,
      ])
      read("cargo", ["metadata", "--locked", "--format-version", "1"])
      const assertScope = () => {
        const changed = [
          read("git", ["diff", "--name-only"]),
          read("git", ["diff", "--cached", "--name-only"]),
          read("git", ["ls-files", "--others", "--exclude-standard"]),
        ]
          .join("\n")
          .split(/\r?\n/)
          .filter(Boolean)
        if (changed.some((file) => !files.includes(file))) {
          throw new Error(
            "出现发布文件以外的改动，请检查工作区；未自动提交这些改动。"
          )
        }
      }
      assertScope()
      run("git", ["add", "--", ...files])
      assertScope()
      run("git", [
        "commit",
        "-m",
        `chore(release): prepare ${tag} metadata and release notes`,
      ])
    }
    clean()
    if (!localTag) {
      if (remoteTag) {
        run("git", [
          "fetch",
          "--no-tags",
          "origin",
          `refs/tags/${tag}:refs/tags/${tag}`,
        ])
      } else run("git", ["tag", tag])
    }
    if (
      read("git", ["rev-parse", `refs/tags/${tag}^{commit}`]) !==
      read("git", ["rev-parse", "HEAD"])
    ) {
      throw new Error("版本标签与 HEAD 不一致，拒绝推送。")
    }
    run("git", [
      "push",
      "--atomic",
      "origin",
      "HEAD:refs/heads/main",
      `refs/tags/${tag}:refs/tags/${tag}`,
    ])
    const publish = dependencies.release ?? releaseLocal
    publish(
      { tag },
      {
        root,
        execute: command,
        env,
        log,
        platform: dependencies.platform,
        arch: dependencies.arch,
      }
    )
  } catch (error) {
    log(
      `流程已停止，保留现有文件、提交和标签。修复错误并确保工作区干净后，可运行 pnpm release --tag ${tag} 继续；草稿已有附件时需先检查。`
    )
    throw error
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  let terminal
  try {
    const args = process.argv.slice(2).filter((arg) => arg !== "--")
    if (args.includes("--help")) {
      console.log(
        "用法：pnpm release [--tag vX.Y.Z]\n输入版本号和更新说明，确认后自动提交版本文件、推送 main 和标签、检查、打包、上传草稿。\n要求：Windows x64、干净的 main 分支、维护者 GitHub 登录和已有签名密钥。\n默认读取 ~/.tauri/arc-recall.key 及 .pub；密码隐藏输入；可沿用 TAURI_* 环境变量。\n失败后使用同一个 --tag 重试；不会移动标签、覆盖同名附件或正式发布。"
      )
    } else {
      const options = args.length ? parseArguments(args) : {}
      if (options.dryRun)
        throw new Error(
          "预检查请使用 pnpm release:local --tag vX.Y.Z --dry-run。"
        )
      if (!process.stdin.isTTY)
        throw new Error("请在交互式终端运行 pnpm release。")
      terminal = createInterface({
        input: process.stdin,
        output: process.stdout,
      })
      await releaseWizard(options, {
        ask: (question) => terminal.question(question),
      })
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  } finally {
    terminal?.close()
  }
}
