import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export const REPOSITORY = "ZhongYanZhiShi/ArcRecall"
export const OWNER = "ZhongYanZhiShi"
const TARGET = "x86_64-pc-windows-msvc"
const PLATFORM = "windows-x86_64"
const ROOT = fileURLToPath(new URL("../", import.meta.url))

export function parseArguments(args, { requireTag = true } = {}) {
  const options = { tag: "", dryRun: false, help: false }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--") continue
    if (args[i] === "--help") options.help = true
    else if (args[i] === "--dry-run") options.dryRun = true
    else if (args[i] === "--publish" && !options.publish) options.publish = true
    else if (args[i] === "--package-only" && !options.packageOnly)
      options.packageOnly = true
    else if (args[i] === "--tag" && !options.tag && args[i + 1]) {
      options.tag = args[++i]
    } else throw new Error(`未知或不完整的参数：${args[i]}`)
  }
  if (options.publish && options.packageOnly)
    throw new Error("--package-only 不能与 --publish 同时使用。")
  if (!options.help && (requireTag || options.tag)) versionFromTag(options.tag)
  return options
}

export function versionFromTag(tag) {
  const match =
    /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?)$/.exec(
      tag
    )
  if (!match || match[2]?.split(".").some((part) => /^0\d+$/.test(part))) {
    throw new Error("请用 --tag 指定版本，例如 v0.2.0 或 v0.2.0-beta.1。")
  }
  return match[1]
}

export function assertPlatform(platform, arch) {
  if (platform === "darwin" && arch === "arm64") {
    throw new Error(
      "已识别 M 系列 Mac（aarch64-apple-darwin）。macOS 引擎资源、历史密码保护和自动更新尚未适配，暂不允许正式发布。"
    )
  }
  if (platform !== "win32" || arch !== "x64") {
    throw new Error(
      "当前本地发布仅支持 Windows x64；macOS ARM64 待完成原生适配。"
    )
  }
}

export function execute(command, args, options = {}) {
  let executable = command
  let arguments_ = args
  if (command === "pnpm") {
    const entry = process.env.npm_execpath
    if (!entry || !existsSync(entry)) {
      throw new Error("请通过 pnpm release:local 启动，以使用同一版本的 pnpm。")
    }
    executable = entry.endsWith(".exe") ? entry : process.execPath
    arguments_ = entry.endsWith(".exe") ? args : [entry, ...args]
  }
  const result = spawnSync(executable, arguments_, {
    cwd: options.cwd ?? ROOT,
    env: {
      ...process.env,
      GH_HOST: "github.com",
      GH_PROMPT_DISABLED: "1",
      ...options.env,
    },
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error || result.status !== 0) {
    // Do not echo the environment or subprocess output: it may contain credentials.
    throw new Error(
      `${command} ${args[0] ?? ""} 执行失败（${result.error?.code ?? result.status}），发布已停止。`
    )
  }
  return result.stdout?.trim() ?? ""
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isDownloadUrl(value) {
  if (
    typeof value !== "string" ||
    !/^https:\/\//i.test(value) ||
    /\s/.test(value)
  ) {
    return false
  }
  try {
    const url = new URL(value)
    return (
      url.protocol === "https:" &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password
    )
  } catch {
    return false
  }
}

export function mergeUpdaterManifest(
  previous,
  { version, notes, signature, assetName }
) {
  // An absent asset is undefined; a downloaded JSON null is a damaged manifest.
  if (
    previous !== undefined &&
    (!isRecord(previous) ||
      previous.version !== version ||
      !isRecord(previous.platforms))
  ) {
    throw new Error("草稿中的 latest.json 版本或格式不匹配，拒绝覆盖。")
  }
  for (const entry of Object.values(previous?.platforms ?? {})) {
    if (
      !isRecord(entry) ||
      typeof entry.signature !== "string" ||
      !entry.signature.trim()
    ) {
      throw new Error("草稿中的 latest.json 含不完整的平台信息，拒绝覆盖。")
    }
    if (!isDownloadUrl(entry.url)) {
      throw new Error(
        "草稿中的 latest.json 下载地址必须是有效且不含账号密码的 HTTPS URL，拒绝覆盖。"
      )
    }
  }
  if (typeof signature !== "string" || !signature.trim()) {
    throw new Error("安装包签名为空或格式错误，发布已停止。")
  }
  return {
    ...previous,
    version,
    notes,
    pub_date: previous?.pub_date ?? new Date().toISOString(),
    platforms: {
      ...previous?.platforms,
      [PLATFORM]: {
        signature: signature.trim(),
        url: `https://github.com/${REPOSITORY}/releases/download/v${version}/${assetName}`,
      },
    },
  }
}

export function getRelease(read, tag) {
  const pages = JSON.parse(
    read("gh", ["api", `repos/${REPOSITORY}/releases`, "--paginate", "--slurp"])
  )
  return pages.flat().find((release) => release.tag_name === tag) ?? null
}

export function assertDraft(release, tag) {
  const version = versionFromTag(tag)
  const installerName = `ArcRecall_${version}_x64-setup.exe`
  if (release && !release.draft)
    throw new Error("该版本已正式发布，拒绝修改；请使用新版本号。")
  if (release && release.prerelease !== version.includes("-")) {
    throw new Error(
      `草稿的 Pre-release 标记与 ${tag} 不一致，请在 GitHub ${version.includes("-") ? "勾选" : "取消"} Pre-release 后重试。`
    )
  }
  if (
    release?.assets.some((asset) =>
      [installerName, `${installerName}.sig`].includes(asset.name)
    )
  ) {
    throw new Error(
      "草稿中已有同名 Windows 安装包或签名。请先检查并手动移除需要重传的草稿资产。"
    )
  }
}

export function releaseLocal(options, dependencies = {}) {
  const root = dependencies.root ?? ROOT
  const env = dependencies.env ?? process.env
  const command = dependencies.execute ?? execute
  const log = dependencies.log ?? console.log
  const run = (program, args, extra = {}) =>
    command(program, args, { cwd: root, ...extra })
  const read = (program, args) => run(program, args, { capture: true })
  const json = (relative) =>
    JSON.parse(readFileSync(path.join(root, relative), "utf8"))
  const version = versionFromTag(options.tag)
  const prerelease = version.includes("-")
  if (options.publish && options.packageOnly)
    throw new Error("本地打包模式不能正式发布。")
  assertPlatform(
    dependencies.platform ?? process.platform,
    dependencies.arch ?? process.arch
  )
  if (env.GITHUB_ACTIONS === "true") {
    throw new Error("此命令只允许本机手动执行，不用于 GitHub Actions。")
  }

  log(`检查本地发布：${options.tag} / ${PLATFORM}`)
  read("pnpm", ["--version"])
  read("cargo", ["--version"])
  read("powershell.exe", [
    "-NoProfile",
    "-Command",
    "$PSVersionTable.PSVersion.ToString()",
  ])
  if (!options.packageOnly) {
    const login = read("gh", ["api", "user", "--jq", ".login"])
    if (login.toLowerCase() !== OWNER.toLowerCase()) {
      throw new Error(
        `当前 GitHub 登录账号不是发布者 ${OWNER}。请先使用 gh auth login / gh auth switch 切换。`
      )
    }
    const origin = read("git", ["remote", "get-url", "origin"])
    if (
      !/^((git@github\.com:)|(https:\/\/github\.com\/))ZhongYanZhiShi\/ArcRecall(?:\.git)?$/i.test(
        origin
      )
    ) {
      throw new Error(`origin 必须指向 github.com/${REPOSITORY}。`)
    }
  }
  const assertSource = () => {
    if (read("git", ["status", "--porcelain", "--untracked-files=normal"])) {
      throw new Error(
        "工作区有未提交改动。请提交发布代码和说明，并在干净工作区检出待发布标签后重试。"
      )
    }
    const commit = read("git", ["rev-parse", "HEAD"])
    if (options.packageOnly) return commit
    if (
      commit !== read("git", ["rev-parse", `refs/tags/${options.tag}^{commit}`])
    ) {
      throw new Error("HEAD 与版本标签不一致，请先检出该标签。")
    }
    const remote = read("git", [
      "ls-remote",
      "origin",
      `refs/tags/${options.tag}`,
      `refs/tags/${options.tag}^{}`,
    ])
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.split(/\s+/))
    const remoteCommit =
      remote.find(([, ref]) => ref.endsWith("^{}"))?.[0] ?? remote[0]?.[0]
    if (commit !== remoteCommit) {
      throw new Error("远端标签不存在或与本地提交不一致。请先核对并推送标签。")
    }
    return commit
  }
  const commit = assertSource()
  const packageVersion = json("package.json").version
  const tauriVersion = json("src-tauri/tauri.conf.json").version
  const cargoVersion = /^version\s*=\s*"([^"]+)"/m.exec(
    readFileSync(path.join(root, "src-tauri/Cargo.toml"), "utf8")
  )?.[1]
  if (
    [packageVersion, tauriVersion, cargoVersion].some(
      (value) => value !== version
    )
  ) {
    throw new Error(
      "package.json、tauri.conf.json、src-tauri/Cargo.toml 的版本必须与标签一致。"
    )
  }
  const notesPath = path.join(root, `.github/release-notes/${options.tag}.md`)
  const notes = readFileSync(notesPath, "utf8")
  if (!notes.trim()) throw new Error("版本说明不能为空。")
  for (const name of [
    "TAURI_UPDATER_PUBLIC_KEY",
    "TAURI_SIGNING_PRIVATE_KEY",
  ]) {
    if (!env[name]?.trim())
      throw new Error(
        `缺少本机环境变量 ${name}，变量说明见 pnpm release:local --help。`
      )
  }

  const installerName = `ArcRecall_${version}_x64-setup.exe`
  const signatureName = `${installerName}.sig`
  const initialRelease = options.packageOnly
    ? null
    : getRelease(read, options.tag)
  if (!options.packageOnly) assertDraft(initialRelease, options.tag)
  log(
    `源码：${commit}；目标：${options.packageOnly ? "仅生成本地发布文件" : options.publish ? "上传完整附件后自动发布" : "上传草稿"}。`
  )
  if (options.dryRun) {
    log("预检查通过。未构建、未创建草稿、未上传文件。")
    return
  }

  run("pnpm", ["install", "--frozen-lockfile"])
  for (const check of ["format:check", "lint", "typecheck", "test"])
    run("pnpm", [check])
  // Both checks and builds use their own cache, leaving running development apps alone.
  const targetDirectory = path.join(root, "target", "local-release")
  const cargoEnvironment = { env: { CARGO_TARGET_DIR: targetDirectory } }
  run("cargo", ["fmt", "--all", "--", "--check"])
  run(
    "cargo",
    [
      "clippy",
      "--workspace",
      "--all-targets",
      "--all-features",
      "--",
      "-D",
      "warnings",
    ],
    cargoEnvironment
  )
  run(
    "cargo",
    ["test", "--workspace", "--all-targets", "--all-features"],
    cargoEnvironment
  )
  run("pnpm", ["engine-bundle:prepare"])
  run("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    "./scripts/prepare-updater-config.ps1",
  ])

  // Keep reusable Cargo output separate from development, and reject stale installers.
  const installer = path.join(
    targetDirectory,
    TARGET,
    "release",
    "bundle",
    "nsis",
    installerName
  )
  for (const file of [installer, `${installer}.sig`])
    rmSync(file, { force: true })
  run(
    "pnpm",
    [
      "exec",
      "tauri",
      "build",
      "--target",
      TARGET,
      "--bundles",
      "nsis",
      "--config",
      "src-tauri/tauri.updater.release.conf.json",
    ],
    { env: { CARGO_TARGET_DIR: targetDirectory } }
  )
  const signature = readFileSync(`${installer}.sig`, "utf8")
  if (assertSource() !== commit)
    throw new Error("构建期间源码发生变化，拒绝上传。")

  const outputRoot = path.join(root, "artifacts")
  mkdirSync(outputRoot, { recursive: true })
  const output = mkdtempSync(
    path.join(
      outputRoot,
      `${options.packageOnly ? "package" : "release"}-${options.tag}-`
    )
  )
  copyFileSync(installer, path.join(output, installerName))
  copyFileSync(`${installer}.sig`, path.join(output, signatureName))
  const manifestPath = path.join(output, "latest.json")
  const writeManifest = (previous) =>
    writeFileSync(
      manifestPath,
      JSON.stringify(
        mergeUpdaterManifest(previous, {
          version,
          notes,
          signature,
          assetName: installerName,
        }),
        null,
        2
      ) + "\n"
    )
  writeManifest(undefined)
  log(`已生成安装包、签名及 latest.json：${output}`)
  if (options.packageOnly) return output

  // Preserve complete local artifacts even if the subsequent upload fails.
  const currentRelease = getRelease(read, options.tag)
  assertDraft(currentRelease, options.tag)
  if (JSON.stringify(currentRelease) !== JSON.stringify(initialRelease)) {
    throw new Error(
      "构建期间 Release 已变化，请检查草稿后重试；不要同时发布同一版本。"
    )
  }
  const hasManifest = currentRelease?.assets.some(
    (asset) => asset.name === "latest.json"
  )
  if (hasManifest) {
    const previousManifestPath = path.join(output, "previous-latest.json")
    run("gh", [
      "release",
      "download",
      options.tag,
      "--repo",
      REPOSITORY,
      "--pattern",
      "latest.json",
      "--output",
      previousManifestPath,
    ])
    writeManifest(JSON.parse(readFileSync(previousManifestPath, "utf8")))
    rmSync(previousManifestPath)
  }
  if (!currentRelease) {
    run("gh", [
      "release",
      "create",
      options.tag,
      "--repo",
      REPOSITORY,
      "--draft",
      "--verify-tag",
      "--title",
      `ArcRecall ${options.tag}`,
      "--notes-file",
      notesPath,
      ...(prerelease ? ["--prerelease"] : []),
    ])
  }
  const draft = options.publish ? getRelease(read, options.tag) : null
  if (options.publish) {
    if (!draft?.id || (currentRelease && draft.id !== currentRelease.id))
      throw new Error("无法确认待上传的草稿，已停止发布。")
    assertDraft(draft, options.tag)
  }
  run("gh", [
    "release",
    "upload",
    options.tag,
    path.join(output, installerName),
    path.join(output, signatureName),
    "--repo",
    REPOSITORY,
  ])
  run("gh", [
    "release",
    "upload",
    options.tag,
    manifestPath,
    "--repo",
    REPOSITORY,
    ...(hasManifest ? ["--clobber"] : []),
  ])
  if (options.publish) {
    const uploaded = getRelease(read, options.tag)
    if (
      !draft?.id ||
      uploaded?.id !== draft.id ||
      !uploaded.draft ||
      uploaded.prerelease !== prerelease ||
      assertSource() !== commit
    ) {
      throw new Error("上传期间草稿或源码已变化，未执行正式发布。")
    }
    // GitHub computes digests for uploaded assets; require all three exact files.
    for (const name of [installerName, signatureName, "latest.json"]) {
      const contents = readFileSync(path.join(output, name))
      const assets = uploaded.assets.filter((asset) => asset.name === name)
      const digest = `sha256:${createHash("sha256").update(contents).digest("hex")}`
      if (
        assets.length !== 1 ||
        assets[0].state !== "uploaded" ||
        assets[0].size !== contents.length ||
        assets[0].digest !== digest
      ) {
        throw new Error(
          `草稿附件 ${name} 未通过完整性校验，保留草稿，未正式发布。`
        )
      }
    }
    run("gh", [
      "release",
      "edit",
      options.tag,
      "--repo",
      REPOSITORY,
      "--draft=false",
      "--verify-tag",
      `--latest=${!prerelease}`,
    ])
    const published = getRelease(read, options.tag)
    if (
      published?.id !== draft.id ||
      published.draft !== false ||
      published.prerelease !== prerelease
    )
      throw new Error("未能确认正式发布结果，请检查 GitHub Release 状态。")
    log(
      `已${prerelease ? "发布预发布版本" : "正式发布"}：https://github.com/${REPOSITORY}/releases/tag/${options.tag}`
    )
    return output
  }
  log(`已上传到草稿，尚未正式发布。本地产物：${output}`)
  log(`请在 https://github.com/${REPOSITORY}/releases 核对资产并手动发布。`)
  return output
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const options = parseArguments(process.argv.slice(2))
    if (options.help) {
      console.log(
        "用法：pnpm release:local --tag vX.Y.Z [--dry-run] [--publish | --package-only]\n默认上传草稿；--publish 在附件校验通过后自动发布；--package-only 仅生成安装包、签名和 latest.json。\n本地打包推荐使用 pnpm package，自动读取当前版本并隐藏输入密码。\n当前支持 Windows x64；M1/macOS ARM64 暂待原生适配。\n签名环境变量：\n  TAURI_UPDATER_PUBLIC_KEY：.pub 文件完整内容\n  TAURI_SIGNING_PRIVATE_KEY：私钥文件绝对路径或完整内容\n  TAURI_SIGNING_PRIVATE_KEY_PASSWORD：私钥密码，无密码时留空"
      )
    } else releaseLocal(options)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
