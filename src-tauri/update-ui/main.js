/* Minimal embedded updater UI: no remote assets, database or main-app runtime. */
const invoke = (command) => window.__TAURI_INTERNALS__.invoke(command)
const $ = (id) => document.getElementById(id)
let stopped = false
let lastError = ""
let readFailures = 0

function render(state) {
  document.documentElement.dataset.theme = state.theme
  $("version").textContent = state.preview ? "安全预览" : `v${state.version}`
  const terminal = ["failed", "unconfirmed", "complete"].includes(state.phase)
  $("heading").textContent =
    state.phase === "failed"
      ? "更新未完成"
      : state.phase === "unconfirmed"
        ? "请确认新版已打开"
        : "正在更新 ArcRecall"
  $("message").textContent = state.message
  $("retry").hidden = !state.retryable
  $("close").hidden = !terminal && !state.preview
  $("error").hidden = !state.error
  if (lastError !== (state.error ?? "")) {
    $("error").textContent = state.error ?? ""
    lastError = state.error ?? ""
  }
  const phases = ["waiting", "installing", "starting"]
  const current = phases.indexOf(state.phase)
  for (const [index, node] of [
    ...document.querySelectorAll("li[data-phase]"),
  ].entries()) {
    if (index === current) node.setAttribute("aria-current", "step")
    else node.removeAttribute("aria-current")
    node.dataset.complete = String(
      index < current || state.phase === "complete"
    )
  }
}

async function read() {
  if (stopped) return
  try {
    render(await invoke("helper_status"))
    readFailures = 0
  } catch {
    if (++readFailures >= 3) {
      $("message").textContent =
        "暂时无法读取更新状态，正在重新连接。请勿重复启动安装。"
    }
  }
  setTimeout(read, 350)
}

$("retry").addEventListener("click", async () => {
  $("retry").disabled = true
  try {
    await invoke("helper_start")
  } catch (error) {
    $("error").hidden = false
    $("error").textContent = String(error)
  } finally {
    $("retry").disabled = false
  }
})
$("close").addEventListener("click", async () => {
  try {
    await invoke("helper_close")
    stopped = true
  } catch (error) {
    $("error").hidden = false
    $("error").textContent = String(error)
  }
})
read()
// Handshake only after the updater document has had an opportunity to paint.
requestAnimationFrame(() =>
  requestAnimationFrame(() => {
    invoke("helper_start").catch((error) => {
      $("message").textContent = "更新程序启动失败，原应用将保持打开。"
      $("error").hidden = false
      $("error").textContent = String(error)
    })
  })
)
