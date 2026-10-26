// Real signed NSIS update in an isolated test product. Never uses release keys.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  access,
  readdir,
  unlink,
} from "node:fs/promises"
import { join, resolve } from "node:path"
import { chromium, expect } from "@playwright/test"

if (process.platform !== "win32") throw new Error("Windows + WebView2 required")
const root = await mkdtemp(resolve("target/update-acceptance-"))
const suffix = root.split("-").at(-1).toLowerCase()
const product = `ArcRecallUpdateTest-${suffix}`
const identifier = `io.arcrecall.update-test.${suffix}`
const evidence = resolve("artifacts/update-acceptance")
const install = join(root, "[测试分组] 中文 安装目录")
const data = join(root, "data")
const key = join(root, "test.key")
const binary = join(install, "arc-recall-desktop.exe")
const cli = resolve("node_modules/@tauri-apps/cli/tauri.js")
await access(resolve("out/index.html")) // Build the current frontend before this suite.
await Promise.all([
  mkdir(install),
  mkdir(data),
  mkdir(evidence, { recursive: true }),
])
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
async function run(program, args, options = {}) {
  const child = spawn(program, args, {
    windowsHide: true,
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
  })
  let output = ""
  child.stdout.on("data", (chunk) => {
    output += chunk
  })
  child.stderr.on("data", (chunk) => {
    output += chunk
  })
  const [code] = await once(child, "exit")
  if (code !== 0)
    throw new Error(`${program} failed (${code}): ${output.slice(-8000)}`)
  return output
}
const quote = (value) => `'${value.replaceAll("'", "''")}'`
async function installerRun(file, argumentsText) {
  // NSIS /D and _? must be last and unquoted, including paths containing spaces.
  return run("pwsh", [
    "-NoProfile",
    "-Command",
    `$p = Start-Process -FilePath ${quote(file)} -ArgumentList ${quote(argumentsText)} -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode`,
  ])
}
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex")
let manifest,
  packageBytes,
  old,
  browser,
  session,
  completed = false
const server = createServer((req, res) => {
  if (req.url === "/package") {
    res.setHeader("Content-Type", "application/octet-stream")
    res.end(packageBytes)
    return
  }
  res.setHeader("Content-Type", "application/json")
  res.end(JSON.stringify(manifest))
}).listen(0, "127.0.0.1")
await once(server, "listening")
const endpoint = `http://127.0.0.1:${server.address().port}`
// A unique cache identifier isolates updater sessions and WebView storage too.
const cache = join(process.env.LOCALAPPDATA, identifier, "update-sessions")
try {
  await run(process.execPath, [
    cli,
    "signer",
    "generate",
    "--ci",
    "--write-keys",
    key,
  ])
  const pubkey = (await readFile(`${key}.pub`, "utf8")).trim()
  for (const version of ["0.3.0", "0.3.1"]) {
    const config = join(root, `${version}.json`)
    await writeFile(
      config,
      JSON.stringify({
        productName: product,
        identifier,
        version,
        build: { beforeBuildCommand: "", devUrl: null },
        bundle: {
          publisher: product,
          createUpdaterArtifacts: false,
          resources: [],
          windows: { nsis: { installMode: "currentUser" } },
        },
        plugins: {
          updater: {
            pubkey,
            endpoints: [`${endpoint}/latest.json`],
            dangerousInsecureTransportProtocol: true,
          },
        },
      })
    )
    console.log(`Building isolated version ${version}…`)
    await run("pwsh", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve("scripts/build-update-acceptance.ps1"),
      "-Config",
      config,
      "-Bundle",
    ])
    if (version === "0.3.0") {
      await installerRun(
        resolve(`target/debug/bundle/nsis/${product}_0.3.0_x64-setup.exe`),
        `/S /NS /D=${install}`
      )
      await access(binary)
    }
  }
  const installer = resolve(
    `target/debug/bundle/nsis/${product}_0.3.1_x64-setup.exe`
  )
  await run(process.execPath, [
    cli,
    "signer",
    "sign",
    "--private-key-path",
    key,
    "--app-version",
    "0.3.1",
    installer,
  ])
  // Bundling patches the executable's bundle-type marker and then restores the
  // build output. Compare against the actual signed installer payload instead.
  const extracted = join(root, "expected-payload")
  await run(
    process.env.ARC_RECALL_TEST_7ZIP ?? "C:/Program Files/7-Zip/7z.exe",
    ["e", installer, "arc-recall-desktop.exe", `-o${extracted}`, "-y"]
  )
  const expectedBinary = digest(
    await readFile(join(extracted, "arc-recall-desktop.exe"))
  )
  packageBytes = await readFile(installer)
  manifest = {
    version: "0.3.1",
    notes: "隔离更新验收",
    platforms: {
      "windows-x86_64": {
        url: `${endpoint}/package`,
        signature: (await readFile(`${installer}.sig`, "utf8")).trim(),
      },
    },
  }
  await writeFile(
    join(data, "settings.json"),
    JSON.stringify({ autoUpdate: false })
  )
  await writeFile(join(data, "retained-fixture.txt"), "保留本地数据")
  const debugServer = createServer().listen(0, "127.0.0.1")
  await once(debugServer, "listening")
  const port = debugServer.address().port
  await new Promise((done) => debugServer.close(done))
  old = spawn(binary, [], {
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      ARC_RECALL_TEST_DATA_ROOT: data,
      WEBVIEW2_USER_DATA_FOLDER: join(root, "old-webview"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
  })
  for (let i = 0; i < 240; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break
    } catch {}
    assert.equal(old.exitCode, null, "Old application exited before connecting")
    await delay(250)
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  const page = browser.contexts()[0].pages()[0]
  await page.waitForFunction(() => Boolean(window.__TAURI_INTERNALS__))
  const invoke = (command, args = {}) =>
    page.evaluate(
      ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args),
      { command, args }
    )
  await expect
    .poll(async () => (await invoke("app_update_status")).phase, {
      timeout: 30000,
    })
    .toBe("available")
  assert.equal((await invoke("app_update_status")).currentVersion, "0.3.0")
  await invoke("app_update_download")
  assert.equal((await invoke("app_update_status")).phase, "ready")
  await page.screenshot({ path: join(evidence, "before.png") })
  console.log("Verified signed download; handing off to real updater…")
  // The parent exits during this IPC call; do not await its disappearing bridge.
  const installing = invoke("app_update_install", { theme: "dark" }).catch(
    () => {}
  )
  const phases = new Set()
  let last
  for (let i = 0; i < 600; i++) {
    try {
      session ??= join(
        cache,
        (await readdir(cache)).find((name) => name.startsWith("session-"))
      )
      last = JSON.parse(await readFile(join(session, "status.json"), "utf8"))
      phases.add(last.phase)
      if (last.phase === "failed" || last.phase === "unconfirmed")
        throw new Error(JSON.stringify(last))
      const ack = JSON.parse(
        await readFile(join(session, "started.json"), "utf8")
      )
      assert.equal(ack, "0.3.1")
      completed = true
      break
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof TypeError)) throw error
      // Successful startup cleans the session; seeing the new process below is also required.
      if (session && old.exitCode === 0 && last?.phase === "starting") {
        try {
          await readFile(join(session, "request.json"))
        } catch (e) {
          if (e.code === "ENOENT") {
            completed = true
            break
          }
        }
      }
    }
    await delay(100)
  }
  assert(
    completed,
    `Update did not acknowledge startup: ${JSON.stringify(last)}`
  )
  assert.equal(old.exitCode, 0, "Old process must exit normally")
  assert.equal(
    digest(await readFile(binary)),
    expectedBinary,
    "NSIS must replace the executable with the exact new build"
  )
  assert.equal(
    JSON.parse(await readFile(join(data, "settings.json"), "utf8")).autoUpdate,
    false
  )
  assert.equal(
    await readFile(join(data, "retained-fixture.txt"), "utf8"),
    "保留本地数据"
  )
  await installing
  // Connect to the restarted real frontend, not a mocked updater or helper window.
  await browser.close().catch(() => {})
  browser = undefined
  for (let i = 0; i < 80; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
      const next = browser.contexts()[0].pages()[0]
      const status = await next.evaluate(() =>
        window.__TAURI_INTERNALS__.invoke("app_update_status")
      )
      assert.equal(status.currentVersion, "0.3.1")
      await next.screenshot({ path: join(evidence, "after.png") })
      break
    } catch (e) {
      await browser?.close().catch(() => {})
      browser = undefined
      if (i === 79) throw e
      await delay(250)
    }
  }
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify(
      {
        product,
        root,
        from: "0.3.0",
        to: "0.3.1",
        phases: [...phases],
        signed: "ephemeral test key; Authenticode not exercised",
        installedBaseline: true,
        binaryHashMatched: true,
        nativeRestart: true,
        preservedData: true,
      },
      null,
      2
    )
  )
  console.log(
    `PASS: signed NSIS replacement and native frontend restart; phases: ${[...phases].join(", ")}`
  )
} finally {
  await Promise.all([
    unlink(key).catch(() => {}),
    unlink(`${key}.pub`).catch(() => {}),
  ])
  await browser?.close().catch(() => {})
  // Exact executable path identifies only processes created for this test product.
  const script = `$target = '${binary.replaceAll("'", "''")}'; Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $target } | ForEach-Object { $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; if ($p) { $p.Kill(); $p.WaitForExit() } }`
  await run("pwsh", ["-NoProfile", "-Command", script]).catch(() => {})
  if (session) {
    const helperPath = join(session, "ArcRecall-update.exe")
    await run("pwsh", [
      "-NoProfile",
      "-Command",
      `$target = ${quote(helperPath)}; Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $target } | ForEach-Object { $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; if ($p) { $p.Kill(); $p.WaitForExit() } }`,
    ])
  }
  try {
    await access(join(install, "uninstall.exe"))
    // Restart Manager can briefly retain a just-exited application's resources.
    for (let attempt = 0; ; attempt++) {
      try {
        await installerRun(
          join(install, "uninstall.exe"),
          `/S /UPDATE _?=${install}`
        )
        break
      } catch (error) {
        if (attempt >= 2) throw error
        await delay(1000)
      }
    }
    // Only the test product's remembered path remains after /UPDATE uninstall.
    await run("pwsh", [
      "-NoProfile",
      "-Command",
      `$key = ${quote(`HKCU:\\Software\\${product}\\${product}`)}; $item = Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue; if ($item -and $item.'(default)' -eq ${quote(install)}) { Remove-Item -LiteralPath $key -Recurse -Force }`,
    ])
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  await new Promise((done) => server.close(done))
  console.log(`Evidence: ${evidence}; isolated installation: ${install}`)
}
