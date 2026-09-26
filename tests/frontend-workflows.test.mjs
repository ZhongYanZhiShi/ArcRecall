import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import ts from "typescript"

const root = fileURLToPath(new URL("../", import.meta.url))
const deferred = () => {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

// Execute the real event handlers and JSX with only React's lifecycle and IPC
// replaced. These regressions do not start Tauri, a browser, or write user data.
function sourceHarness(overrides) {
  const slots = []
  const pendingEffects = []
  let cursor = 0
  const same = (a, b) =>
    a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
  const effect = (setup, deps) => {
    const index = cursor++
    const previous = slots[index]
    if (!previous || previous.hidden || !same(previous.deps, deps)) {
      pendingEffects.push(() => {
        previous?.cleanup?.()
        slots[index] = { deps, cleanup: setup(), effect: true }
      })
    }
  }
  const memo = (compute, deps) => {
    const index = cursor++
    if (!slots[index] || !same(slots[index].deps, deps))
      slots[index] = { value: compute(), deps }
    return slots[index].value
  }
  const React = {
    createContext() {
      return { Provider: "ContextProvider" }
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot()
    },
    useState(initial) {
      const index = cursor++
      if (!(index in slots))
        slots[index] = {
          value: typeof initial === "function" ? initial() : initial,
        }
      return [
        slots[index].value,
        (next) => {
          slots[index].value =
            typeof next === "function" ? next(slots[index].value) : next
        },
      ]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
    useMemo: memo,
    useCallback(fn, deps) {
      return memo(() => fn, deps)
    },
    forwardRef(render) {
      return (props) => render(props, props.ref)
    },
    useImperativeHandle(ref, create, deps) {
      effect(() => {
        if (!ref) return
        ref.current = create()
        return () => {
          ref.current = null
        }
      }, deps)
    },
    useEffect: effect,
    useLayoutEffect: effect,
  }
  const ui = new Proxy({}, { get: (_, key) => key })
  const jsx = (type, props, key) => ({ type, props, key })
  const modules = new Map()
  const mocks = {
    react: React,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "@/lib/utils": { cn: () => "" },
    ...overrides,
  }
  function load(relative) {
    if (modules.has(relative)) return modules.get(relative)
    const source = fs.readFileSync(path.join(root, relative), "utf8")
    const code = ts.transpileModule(source, {
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText
    const compiledModule = { exports: {} }
    new Function("require", "module", "exports", code)(
      (name) => {
        if (name in mocks) return mocks[name]
        if (name.startsWith("@/lib/")) return load(`src/${name.slice(2)}.ts`)
        if (name.startsWith("@/hooks/")) return load(`src/${name.slice(2)}.ts`)
        if (name === "@/components/home/ai-settings-draft")
          return load("src/components/home/ai-settings-draft.ts")
        if (name === "@/components/home/compress-page-view")
          return load("src/components/home/compress-page-view.tsx")
        if (name === "@/components/home/log-presentation")
          return load("src/components/home/log-presentation.ts")
        return ui
      },
      compiledModule,
      compiledModule.exports
    )
    modules.set(relative, compiledModule.exports)
    return compiledModule.exports
  }
  return {
    load,
    render(Component, props = {}) {
      cursor = 0
      const tree = Component(props)
      pendingEffects.splice(0).forEach((run) => run())
      return tree
    },
    hide() {
      for (const slot of slots) {
        if (slot?.effect) {
          slot.cleanup?.()
          slot.cleanup = undefined
          slot.hidden = true
        }
      }
    },
  }
}

function find(node, predicate) {
  if (!node || typeof node !== "object") return null
  if (predicate(node)) return node
  for (const value of Object.values(node.props ?? node)) {
    if (typeof value === "object") {
      const found = find(value, predicate)
      if (found) return found
    }
  }
  return null
}
const button = (tree, text) =>
  find(
    tree,
    (node) =>
      node.type === "Button" && [node.props.children].flat().includes(text)
  )

test("自动更新启动与定时检查不会自动安装，重复操作不会并发提交", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] })
  const calls = []
  const checking = deferred()
  let pending = false
  const harness = sourceHarness({
    "@/lib/dictionary": { isDesktopRuntime: () => true },
    "@/lib/settings": {},
    "@tauri-apps/api/core": {
      invoke: async (command, args) => {
        calls.push([command, args])
        if (command === "app_update_status")
          return { phase: "idle", version: null }
        if (pending) await checking.promise
      },
    },
  })
  t.after(() => harness.hide())
  const Provider = harness.load(
    "src/components/update-provider.tsx"
  ).UpdateProvider
  harness.render(Provider)
  t.mock.timers.tick(0)
  await settle()
  assert.ok(
    calls.some(
      ([command, args]) =>
        command === "app_update_check" && args.reason === "startup"
    )
  )
  pending = true
  const context = harness.render(Provider).props.value
  const first = context.check()
  const second = context.download()
  await settle()
  assert.equal(
    calls.filter(([command]) => command === "app_update_download").length,
    0
  )
  checking.resolve()
  await Promise.all([first, second])
  pending = false
  t.mock.timers.tick(6 * 60 * 60 * 1000)
  await settle()
  assert.equal(
    calls.filter(
      ([command, args]) =>
        command === "app_update_check" && args.reason === "scheduled"
    ).length,
    1
  )
  assert.equal(
    calls.filter(([command]) => command === "app_update_install").length,
    0
  )
})

test("关闭自动更新后每次重启仍检查并提示新版本，不自动下载", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] })
  const checks = []
  for (let launch = 0; launch < 2; launch += 1) {
    const harness = sourceHarness({
      "@/lib/dictionary": { isDesktopRuntime: () => true },
      "@/lib/settings": {},
      "@tauri-apps/api/core": {
        invoke: async (command, args) => {
          if (command === "app_update_status")
            return { phase: "available", version: "0.2.0", autoUpdate: false }
          checks.push([command, args])
        },
      },
    })
    const Provider = harness.load(
      "src/components/update-provider.tsx"
    ).UpdateProvider
    harness.render(Provider)
    t.mock.timers.tick(0)
    await settle()
    const tree = harness.render(Provider)
    const notice = find(tree, (node) => node.props?.role === "status")
    assert.match(notice.props.children[0].props.children, /发现新版本 0.2.0/)
    button(tree, "知道了").props.onClick()
    assert.equal(
      find(harness.render(Provider), (node) => node.props?.role === "status"),
      null
    )
    harness.hide()
  }
  assert.deepEqual(checks, [
    ["app_update_check", { reason: "startup" }],
    ["app_update_check", { reason: "startup" }],
  ])
})

test("自动更新偏好保存失败时不开始下载，安装失败保留已下载版本并允许重试", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] })
  const calls = []
  const ready = { phase: "ready", version: "0.2.0", autoUpdate: false }
  const harness = sourceHarness({
    "@/lib/dictionary": { isDesktopRuntime: () => true },
    "@/lib/settings": {
      updateSettings: async () => {
        throw new Error("disk full")
      },
    },
    "@tauri-apps/api/core": {
      invoke: async (command) => {
        calls.push(command)
        if (command === "app_update_status") return ready
        if (command === "app_update_install") throw new Error("task running")
      },
    },
  })
  t.after(() => harness.hide())
  const Provider = harness.load(
    "src/components/update-provider.tsx"
  ).UpdateProvider
  await harness.render(Provider).props.value.setAutomatic(true)
  assert.equal(calls.length, 0)
  assert.match(
    harness.render(Provider).props.value.error,
    /保存自动更新设置失败/
  )
  await harness.render(Provider).props.value.install()
  const context = harness.render(Provider).props.value
  assert.equal(context.status.phase, "ready")
  assert.equal(context.busy, false)
  assert.match(context.error, /task running/)
  await context.install()
  assert.equal(
    calls.filter((command) => command === "app_update_install").length,
    2
  )
})

test("恢复数据库后重建字典和历史视图，保留其他工作台状态", (t) => {
  const previousWindow = globalThis.window
  globalThis.window = {
    matchMedia: () => ({ matches: true }),
    requestIdleCallback: () => 1,
    cancelIdleCallback: () => {},
  }
  const names = [
    "ExtractPage",
    "CompressPage",
    "DictionaryPage",
    "HistoryPage",
    "LogsPage",
    "SettingsPage",
  ]
  const harness = sourceHarness({
    "next/dynamic": { default: () => names.shift(), __esModule: true },
  })
  t.after(() => {
    harness.hide()
    globalThis.window = previousWindow
  })
  const Page = harness.load("src/app/page.tsx").default
  const view = (tree, name) => find(tree, (node) => node.type === name)
  let tree = harness.render(Page)
  for (const nav of ["dictionary", "history", "compress", "settings"]) {
    view(tree, "AppShell").props.onNavChange(nav)
    tree = harness.render(Page)
  }
  const dictionaryKey = view(tree, "DictionaryPage").key
  const historyKey = view(tree, "HistoryPage").key
  const draft = view(tree, "CompressPage").props.draft
  view(tree, "SettingsPage").props.onDatabaseRestored()
  tree = harness.render(Page)
  assert.notEqual(view(tree, "DictionaryPage").key, dictionaryKey)
  assert.notEqual(view(tree, "HistoryPage").key, historyKey)
  assert.equal(view(tree, "CompressPage").props.draft, draft)
})

test("批次接收全部拖入和粘贴路径，恢复启动期间拒绝并发操作", async (t) => {
  const previousWindow = globalThis.window
  const previousElement = globalThis.Element
  let paste
  globalThis.Element = class {}
  globalThis.window = {
    addEventListener: (name, callback) => {
      if (name === "paste") paste = callback
    },
    removeEventListener: () => {},
  }
  let drop
  let task = null
  let starts = 0
  const runningRef = { current: false }
  const setTask = (next) => {
    task = typeof next === "function" ? next(task) : next
    runningRef.current = Boolean(task?.running)
  }
  const starting = deferred()
  const archivePicker = deferred()
  const outputPicker = deferred()
  const analyzed = []
  const harness = sourceHarness({
    "@tauri-apps/api/webview": {
      getCurrentWebview: () => ({
        onDragDropEvent: async (fn) => {
          drop = fn
          return () => {}
        },
      }),
    },
    "@/lib/dictionary": {
      isDesktopRuntime: () => true,
      countDictionary: async () => 0,
    },
    "@/lib/recovery": {
      getRecoveryCapabilities: async () => ({ methods: [] }),
      pickArchivePath: () => archivePicker.promise,
      pickOutputDirectory: () => outputPicker.promise,
      analyzeArchive: async (path) => {
        analyzed.push(path)
        return { archivePath: path, suggestedOutputDirectory: path + ".out" }
      },
      startRecovery: () => {
        starts += 1
        return starts === 1
          ? starting.promise
          : Promise.reject(new Error("synthetic failure"))
      },
    },
    "@/lib/settings": { getSettings: async () => ({}) },
    "@/lib/sensitive-clipboard": {},
    "@/hooks/use-desktop-task": {
      useDesktopTask: () => ({
        task,
        running: runningRef.current,
        runningRef,
        setTask,
      }),
    },
  })
  t.after(() => {
    harness.hide()
    globalThis.window = previousWindow
    globalThis.Element = previousElement
  })
  const { ExtractPage } = harness.load("src/components/home/extract-page.tsx")
  const props = { onOpenEngineSettings: () => {} }
  harness.render(ExtractPage, props)
  await settle()
  const { recoveryQueue } = harness.load("src/lib/recovery-queue-session.ts")
  drop({
    payload: { type: "drop", paths: ["C:\\batch-a.zip", "C:\\batch-b.zip"] },
  })
  assert.equal(recoveryQueue.getSnapshot().items.length, 2)
  assert.equal(analyzed.length, 0)
  recoveryQueue.clear()
  paste({
    target: null,
    clipboardData: {
      getData: () => '"C:\\batch-a.zip"\r\nC:\\batch-b.zip\r\nC:/batch-a.zip',
    },
    preventDefault: () => {},
  })
  assert.equal(recoveryQueue.getSnapshot().items.length, 2)
  recoveryQueue.clear()
  drop({ payload: { type: "drop", paths: ["C:\\A.7z"] } })
  await settle()
  let view = harness.render(ExtractPage, props)
  const oldArchive = view.props.handlePickArchive()
  const oldOutput = view.props.handlePickOutputDir()
  const launch = view.props.handleStart()
  await view.props.handleStart()
  drop({ payload: { type: "drop", paths: ["C:\\B.7z"] } })
  paste({
    target: null,
    clipboardData: { getData: () => "C:\\C.7z" },
    preventDefault: () => {},
  })
  await settle()
  view = harness.render(ExtractPage, props)
  assert.equal(view.props.busy, true)
  assert.deepEqual(analyzed, ["C:\\A.7z"])
  assert.equal(starts, 1)
  starting.resolve({ taskId: "A", archivePath: "C:\\A.7z", running: true })
  await launch
  view = harness.render(ExtractPage, props)
  assert.equal(view.props.analysis.archivePath, view.props.task.archivePath)
  setTask({ ...task, running: false })
  archivePicker.resolve("C:\\stale.7z")
  outputPicker.resolve("C:\\stale-output")
  await Promise.all([oldArchive, oldOutput])
  view = harness.render(ExtractPage, props)
  assert.equal(view.props.analysis.archivePath, "C:\\A.7z")
  assert.equal(view.props.outputDir, null)
  await view.props.handleStart()
  view = harness.render(ExtractPage, props)
  assert.equal(view.props.busy, false)
  assert.match(view.props.error, /synthetic failure/)
  drop({ payload: { type: "drop", paths: ["C:\\D.7z"] } })
  await settle()
  assert.equal(
    harness.render(ExtractPage, props).props.analysis.archivePath,
    "C:\\D.7z"
  )
})

test("数据库恢复必须先预览确认，并阻止不可解密密码的恢复", async () => {
  for (const unreadablePasswordCount of [0, 1]) {
    const calls = []
    let refreshed = false
    const harness = sourceHarness({
      "@tauri-apps/plugin-dialog": {
        open: async () => "C:\\synthetic-backup.db",
      },
      "@tauri-apps/api/core": {
        invoke: async (command, payload) => {
          calls.push(command)
          if (command === "database_restore_preview")
            return {
              token: "verified-snapshot",
              candidateCount: 10,
              historyCount: 2,
              passwordCount: 1,
              unreadablePasswordCount,
            }
          assert.equal(command, "database_restore_apply")
          assert.equal(payload.token, "verified-snapshot")
          return { safetyBackupPath: "C:\\safety.db" }
        },
      },
      "@/lib/dictionary": {
        isDesktopRuntime: () => true,
        isDictionaryImportRunning: () => false,
      },
      "@/lib/recovery-queue-session": {
        recoveryQueue: { getSnapshot: () => ({ running: false }) },
      },
      "@/lib/logging": {},
    })
    const { DatabaseRestorePanel } = harness.load(
      "src/components/home/database-restore-panel.tsx"
    )
    const render = () =>
      harness.render(DatabaseRestorePanel, {
        onRestored: () => {
          refreshed = true
        },
      })
    button(render(), "从备份恢复").props.onClick()
    await settle()
    const confirm = find(render(), (node) => node.type === "AlertDialogAction")
    assert.deepEqual(calls, ["database_restore_preview"])
    assert.equal(confirm.props.disabled, unreadablePasswordCount > 0)
    if (unreadablePasswordCount === 0) {
      confirm.props.onClick()
      await settle()
      assert.equal(refreshed, true)
      assert.deepEqual(calls, [
        "database_restore_preview",
        "database_restore_apply",
      ])
      assert.ok(find(render(), (node) => node.props?.role === "status"))
    }
    harness.hide()
  }
})

test("扫描上限和解密方式提交单项更新，校验和保存失败保留编辑", async (t) => {
  const saved = {
    recovery: { computeMode: "cpuOnly" },
  }
  const updates = []
  let rejectSave = false
  const harness = sourceHarness({
    "@/lib/recovery": {
      getRecoveryCapabilities: async () => ({ methods: [] }),
      refreshRecoveryCapabilities: async () => ({ methods: [] }),
    },
    "@/lib/settings": {
      DEFAULT_SCAN_MAX_FILES_PER_DIRECTORY: 10,
      MAX_SCAN_MAX_FILES_PER_DIRECTORY: 0xffffffff,
      getFullEngineBundleStatus: async () => ({}),
      getHashcatStatus: async () => ({}),
      getJohnPerlStatus: async () => ({}),
      getSettings: async () => structuredClone(saved),
      updateSettings: async (update) => {
        updates.push(structuredClone(update))
        if (rejectSave) throw new Error("disk unavailable")
        const field =
          update.kind === "recoveryComputeMode"
            ? "computeMode"
            : "scanMaxFilesPerDirectory"
        saved.recovery[field] = update.value
        return structuredClone(saved)
      },
    },
  })
  t.after(() => harness.hide())
  const { EngineSettingsPanel } = harness.load(
    "src/components/home/engine-settings-panel.tsx"
  )
  const card = () =>
    find(
      harness.render(EngineSettingsPanel),
      (node) => node.type === "DefaultRecoveryCard"
    ).props
  card()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await settle()
  assert.equal(card().scanLimitValue, "10")
  for (const invalid of ["", "-1", "1.5", "4294967296"]) {
    card().onScanLimitChange(invalid)
    card().onSaveScanLimit()
    await settle()
    assert.equal(card().messageError, true)
    assert.equal(updates.length, 0)
  }
  card().onScanLimitChange("0")
  card().onSaveScanLimit()
  await settle()
  assert.deepEqual(updates, [{ kind: "scanMaxFilesPerDirectory", value: 0 }])
  card().onChange("gpuPreferred")
  await settle()
  assert.deepEqual(updates, [
    { kind: "scanMaxFilesPerDirectory", value: 0 },
    { kind: "recoveryComputeMode", value: "gpuPreferred" },
  ])
  rejectSave = true
  card().onScanLimitChange("25")
  card().onSaveScanLimit()
  await settle()
  assert.equal(updates.length, 3)
  assert.deepEqual(updates[2], { kind: "scanMaxFilesPerDirectory", value: 25 })
  assert.equal(card().scanLimitValue, "25")
  assert.equal(card().messageError, true)
  assert.match(card().message, /disk unavailable/)
  rejectSave = false
  card().onSaveScanLimit()
  await settle()
  assert.equal(updates.length, 4)
  assert.deepEqual(updates[3], { kind: "scanMaxFilesPerDirectory", value: 25 })
  assert.equal(card().messageError, false)
  assert.equal(card().scanLimitValue, "25")
})

test("保存 John / Perl 后刷新界面和共享能力缓存", async (t) => {
  let available = false
  let probes = 0
  const john = () => ({
    ready: available,
    johnCpuReady: available,
    johnToolsDirectory: "C:\\John",
    perlPath: "C:\\Perl\\perl.exe",
  })
  const harness = sourceHarness({
    "@tauri-apps/api/core": {
      invoke: async (command) => {
        assert.equal(command, "recovery_capabilities")
        probes += 1
        return { cpuAvailable: available, gpuAvailable: false, methods: [] }
      },
    },
    "@tauri-apps/plugin-dialog": {},
    "@/lib/dictionary": { isDesktopRuntime: () => true },
    "@/lib/settings": {
      getFullEngineBundleStatus: async () => ({}),
      getHashcatStatus: async () => ({}),
      getJohnPerlStatus: async () => john(),
      getSettings: async () => ({}),
      setJohnPerl: async () => {
        available = !available
        return john()
      },
    },
  })
  t.after(() => harness.hide())
  const { EngineSettingsPanel } = harness.load(
    "src/components/home/engine-settings-panel.tsx"
  )
  const recovery = harness.load("src/lib/recovery.ts")
  harness.render(EngineSettingsPanel)
  await new Promise((resolve) => setTimeout(resolve, 0))
  await settle()
  assert.equal((await recovery.getRecoveryCapabilities()).cpuAvailable, false)
  for (const expected of [true, false]) {
    find(
      harness.render(EngineSettingsPanel),
      (node) => node.type === "JohnPerlCard"
    ).props.onSave()
    await settle()
    await settle()
    const tree = harness.render(EngineSettingsPanel)
    assert.equal(
      find(tree, (node) => node.type === "JohnPerlCard").props.status.ready,
      expected
    )
    assert.equal(
      find(tree, (node) => node.type === "DefaultRecoveryCard").props
        .capabilities.cpuAvailable,
      expected
    )
    assert.equal(
      (await recovery.getRecoveryCapabilities()).cpuAvailable,
      expected
    )
  }
  assert.equal(probes, 3)
})

test("AI 准备阶段锁住实际输入、拖放和异步文件选择结果", async () => {
  const ai = deferred()
  const files = deferred()
  const output = deferred()
  let drop
  let submitted
  let credentialSaves = 0
  let task = null
  const runningRef = { current: false }
  const harness = sourceHarness({
    "@tauri-apps/api/webview": {
      getCurrentWebview: () => ({
        onDragDropEvent: async (listener) => {
          drop = listener
          return () => {}
        },
      }),
    },
    "@/lib/dictionary": { isDesktopRuntime: () => true },
    "@/lib/ai": {
      listAiProfiles: async () => ({
        profiles: [{ id: "local", name: "local" }],
        activeProfileId: "local",
      }),
      generateAiArchiveName: () => ai.promise,
    },
    "@/lib/compression": {
      getPermanentCompressionPasswordStatus: async () => ({
        hasPassword: false,
      }),
      pickCompressionFiles: () => files.promise,
      pickCompressionOutputDirectory: () => output.promise,
      savePermanentCompressionPassword: async () => {
        credentialSaves += 1
      },
      startCompression: async (request) => {
        submitted = request
        return { taskId: "test", running: true }
      },
    },
    "@/lib/settings": {},
    "@/hooks/use-desktop-task": {
      useDesktopTask: () => ({
        task,
        running: runningRef.current,
        runningRef,
        setTask: (next) => {
          task = next
          runningRef.current = next.running
        },
      }),
    },
  })
  const { CompressPage } = harness.load("src/components/home/compress-page.tsx")
  let draft = {
    ...harness.load("src/lib/compression-draft.ts").createCompressionDraft(),
    sources: ["C:\\first.txt", "C:\\second.txt"],
    baseName: "original",
    useAiRename: true,
  }
  const props = () => ({
    draft,
    onDraftChange: (next) => {
      draft = typeof next === "function" ? next(draft) : next
    },
    onOpenAiSettings: () => {},
  })
  harness.render(CompressPage, props())
  await settle()
  const ready = harness.render(CompressPage, props())
  const picked = ready.props.handlePickFiles()
  const pickedOutput = ready.props.handlePickOutput()
  const operation = ready.props.handleStart()
  await ready.props.handleStart() // The synchronous lock also rejects double starts.
  const waiting = harness.render(CompressPage, props())
  const view = waiting.type(waiting.props)
  for (const id of [
    "archive-name",
    "compression-password",
    "compress-ai-rename",
  ]) {
    assert.equal(
      find(view, (node) => node.props?.id === id).props.disabled,
      true,
      id
    )
  }
  assert.equal(
    find(view, (node) => node.type === "Select" && node.props.value === "5")
      .props.disabled,
    true
  )
  waiting.props.updateDraft("password", "unexpected")
  waiting.props.onRemoveSource(0)
  await waiting.props.handleSavePermanentPassword()
  drop({ payload: { type: "drop", paths: ["C:\\dropped.txt"] } })
  files.resolve(["C:\\picked.txt"])
  await picked
  assert.equal(draft.password, "")
  assert.equal(draft.sources.length, 2)
  assert.equal(credentialSaves, 0)
  ai.resolve("AI_name")
  await operation
  assert.equal(submitted.sources.length, 2)
  assert.equal(submitted.password, undefined)
  assert.equal(draft.baseName, "AI_name")
  // A picker opened before the task must not apply even after that task ends.
  runningRef.current = false
  output.resolve("C:\\late-output")
  await pickedOutput
  assert.equal(draft.outputDirectory, null)
  harness.hide()
})

test("返回压缩页保留永久密码选择，凭据删除后取消使用", async (t) => {
  let hasPassword = true
  const starts = []
  const harness = sourceHarness({
    "@/lib/dictionary": { isDesktopRuntime: () => false },
    "@/lib/ai": { listAiProfiles: async () => ({ profiles: [] }) },
    "@/lib/compression": {
      getPermanentCompressionPasswordStatus: async () => ({ hasPassword }),
      startCompression: async (request) => {
        starts.push(request)
        return { running: false }
      },
    },
    "@/hooks/use-desktop-task": {
      useDesktopTask: () => ({
        task: null,
        running: false,
        runningRef: { current: false },
        setTask: () => {},
      }),
    },
  })
  t.after(() => harness.hide())
  const { CompressPage } = harness.load("src/components/home/compress-page.tsx")
  const draft = {
    ...harness.load("src/lib/compression-draft.ts").createCompressionDraft(),
    sources: ["C:\\fixture.txt"],
    baseName: "fixture",
  }
  const render = () =>
    harness.render(CompressPage, {
      draft,
      onDraftChange: () => {},
      onOpenAiSettings: () => {},
    })
  render()
  await settle()
  assert.equal(render().props.usePermanentPassword, true)
  render().props.setUsePermanentPassword(false)
  harness.hide()
  render()
  await settle()
  assert.equal(render().props.usePermanentPassword, false)
  await render().props.handleStart()
  assert.equal(starts[0].usePermanentPassword, false)
  render().props.setUsePermanentPassword(true)
  hasPassword = false
  harness.hide()
  render()
  await settle()
  assert.equal(render().props.usePermanentPassword, false)
})

test("新密码未确认时阻止压缩与永久保存，确认时保留空格", async (t) => {
  const starts = []
  const saves = []
  const harness = sourceHarness({
    "@/lib/dictionary": { isDesktopRuntime: () => false },
    "@/lib/ai": { listAiProfiles: async () => ({ profiles: [] }) },
    "@/lib/compression": {
      getPermanentCompressionPasswordStatus: async () => ({
        hasPassword: true,
      }),
      startCompression: async (request) => {
        starts.push(request)
        return { running: false }
      },
      savePermanentCompressionPassword: async (password) => {
        saves.push(password)
        return { hasPassword: true }
      },
    },
    "@/hooks/use-desktop-task": {
      useDesktopTask: () => ({
        task: null,
        running: false,
        runningRef: { current: false },
        setTask: () => {},
      }),
    },
  })
  t.after(() => harness.hide())
  const { CompressPage } = harness.load("src/components/home/compress-page.tsx")
  let draft = {
    ...harness.load("src/lib/compression-draft.ts").createCompressionDraft(),
    sources: ["C:\\fixture.txt"],
    baseName: "fixture",
    password: " secret ",
  }
  const render = () =>
    harness.render(CompressPage, {
      draft,
      onDraftChange: (next) => {
        draft = typeof next === "function" ? next(draft) : next
      },
      onOpenAiSettings: () => {},
    })
  render()
  await settle()
  for (const confirmation of ["", "secret"]) {
    draft = { ...draft, passwordConfirmation: confirmation }
    let view = render()
    await view.props.handleStart()
    await view.props.handleSavePermanentPassword()
    view = render()
    assert.match(view.props.passwordError, /不一致/)
    const input = find(
      view.type(view.props),
      (node) => node.props?.id === "compression-password-confirmation"
    )
    assert.equal(input.props["aria-invalid"], true)
  }
  assert.equal(starts.length, 0)
  assert.equal(saves.length, 0)
  draft = { ...draft, passwordConfirmation: " secret " }
  await render().props.handleStart()
  assert.equal(starts[0].password, " secret ")
  await render().props.handleSavePermanentPassword()
  assert.deepEqual(saves, [" secret "])
  assert.equal(draft.password, "")
  assert.equal(draft.passwordConfirmation, "")
  await render().props.handleStart()
  assert.equal(starts[1].password, undefined)
  assert.equal(starts[1].usePermanentPassword, true)
})

function enableClock(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 })
  const previous = globalThis.window
  globalThis.window = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  }
  t.after(() => {
    globalThis.window = previous
  })
}

const logResult = (entries, total, skip = 0, take = 200) => ({
  entries,
  totalCount: total,
  matchedCount: total,
  hasMore: skip + take < total,
  stats: {},
  directory: "preview",
})

test("日志固定分页可到达第 1001 条以后，并暂停非首页自动刷新", async (t) => {
  enableClock(t)
  const queries = []
  const all = Array.from({ length: 1201 }, (_, id) => ({
    id: String(id),
    level: "warn",
    context: {},
  }))
  const harness = sourceHarness({
    "@/lib/logging": {
      listLogs: async (query) => {
        queries.push(query)
        return logResult(
          all.slice(query.skip, query.skip + Math.min(1000, query.take)),
          all.length,
          query.skip,
          query.take
        )
      },
    },
  })
  const { LogsPage } = harness.load("src/components/home/logs-page.tsx")
  let tree = harness.render(LogsPage)
  const seen = new Set()
  for (let page = 0; page <= 6; page += 1) {
    t.mock.timers.tick(0)
    await settle()
    tree = harness.render(LogsPage)
    const list = find(tree, (node) => node.props?.["aria-label"] === "日志事件")
    list.props.children.forEach((node) => seen.add(node.props.entry.id))
    assert.equal(queries.at(-1).skip, page * 200)
    assert.equal(queries.at(-1).take, 200)
    if (page < 6) {
      button(tree, "下一页").props.onClick()
      tree = harness.render(LogsPage)
    }
  }
  assert.equal(seen.size, 1201)
  assert.equal(button(tree, "下一页").props.disabled, true)
  const count = queries.length
  t.mock.timers.tick(10_000)
  await settle()
  assert.equal(queries.length, count)
  harness.hide()
})

test("日志慢请求没有轮询堆积，快速搜索只查询最终关键词", async (t) => {
  enableClock(t)
  const first = deferred()
  const queries = []
  const harness = sourceHarness({
    "@/lib/logging": {
      listLogs: (query) => {
        queries.push(query)
        return queries.length === 1
          ? first.promise
          : Promise.resolve(logResult([], 0))
      },
    },
  })
  const { LogsPage } = harness.load("src/components/home/logs-page.tsx")
  let tree = harness.render(LogsPage)
  t.mock.timers.tick(0)
  t.mock.timers.tick(7_500)
  await settle()
  assert.equal(queries.length, 1)
  for (const value of ["e", "er", "error"]) {
    find(tree, (node) => node.props?.id === "log-search").props.onChange({
      target: { value },
    })
    tree = harness.render(LogsPage)
    t.mock.timers.tick(100)
    await settle()
  }
  assert.equal(queries.length, 1)
  t.mock.timers.tick(200)
  tree = harness.render(LogsPage)
  t.mock.timers.tick(0)
  assert.equal(queries.length, 1)
  first.resolve(logResult([], 0))
  await settle()
  assert.equal(queries.length, 2)
  assert.equal(queries[1].searchText, "error")
  harness.hide()
})

test("历史明文按绝对期限隐藏，Activity 清理后异步结果不能重新显示密码", async (t) => {
  enableClock(t)
  let pendingReveal = null
  const harness = sourceHarness({
    "@/lib/history": {
      HISTORY_PAGE_SIZE: 100,
      listRecoveryHistory: async () => ({
        entries: [
          {
            id: 1,
            fingerprintPrefix: "test",
            hasPassword: true,
            firstSuccessAtMs: 1000,
            lastVerifiedAtMs: 2000,
          },
        ],
        matchedCount: 1,
        totalCount: 1,
        passwordCount: 1,
      }),
      revealHistoryPassword: () =>
        pendingReveal?.promise ?? Promise.resolve("test-secret"),
    },
    "@/lib/sensitive-clipboard": {},
  })
  const { HistoryPage } = harness.load("src/components/home/history-page.tsx")
  const passwordCell = (tree) =>
    find(tree, (node) => node.type?.name === "PasswordCell")
  harness.render(HistoryPage)
  await settle()
  let tree = harness.render(HistoryPage)
  passwordCell(tree).props.onReveal()
  await settle()
  tree = harness.render(HistoryPage)
  assert.equal(passwordCell(tree).props.revealed, "test-secret")
  t.mock.timers.tick(30_000)
  tree = harness.render(HistoryPage)
  assert.equal(passwordCell(tree).props.revealed, null)
  passwordCell(tree).props.onReveal()
  await settle()
  tree = harness.render(HistoryPage)
  harness.hide()
  tree = harness.render(HistoryPage)
  assert.equal(passwordCell(tree).props.revealed, null)
  await settle()
  tree = harness.render(HistoryPage)
  pendingReveal = deferred()
  passwordCell(tree).props.onReveal()
  harness.hide()
  pendingReveal.resolve("late-secret")
  await settle()
  tree = harness.render(HistoryPage)
  assert.equal(passwordCell(tree)?.props.revealed ?? null, null)
  await settle()
  tree = harness.render(HistoryPage)
  assert.equal(passwordCell(tree).props.revealed, null)
  harness.hide()
})

test("放弃 AI 草稿立即清除密钥和提示词更改，重新读取失败也不会恢复草稿", async (t) => {
  const previousWindow = globalThis.window
  globalThis.window = { addEventListener() {}, removeEventListener() {} }
  let failReload = false
  const dirtyStates = []
  const saved = {
    profiles: [
      {
        id: "local",
        name: "已保存配置",
        provider: "ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "saved-model",
        hasApiKey: true,
      },
    ],
    activeProfileId: "local",
    renamePrompt: "已保存提示词",
  }
  const harness = sourceHarness({
    "@/lib/dictionary": { isDesktopRuntime: () => true },
    "@tauri-apps/api/core": {
      invoke: async (command) => {
        assert.equal(command, "ai_profiles_list")
        if (failReload) throw new Error("读取失败")
        return structuredClone(saved)
      },
    },
  })
  t.after(() => {
    harness.hide()
    globalThis.window = previousWindow
  })
  const { useAiSettingsController } = harness.load(
    "src/components/home/use-ai-settings-controller.ts"
  )
  const onDirtyChange = (dirty) => dirtyStates.push(dirty)
  const render = () =>
    harness.render(useAiSettingsController, { onDirtyChange })
  render()
  await settle()
  let controller = render()
  controller.setDraft((draft) => ({
    ...draft,
    name: "未保存配置",
    apiKey: "synthetic-secret",
    clearApiKey: true,
  }))
  controller.setPrompt("未保存提示词")
  controller = render()
  assert.equal(dirtyStates.at(-1), true)
  controller.discardUnsavedChanges()
  controller = render()
  assert.equal(controller.draft.name, "已保存配置")
  assert.equal(controller.draft.apiKey, "")
  assert.equal(controller.draft.clearApiKey, false)
  assert.equal(controller.prompt, "已保存提示词")
  assert.equal(dirtyStates.at(-1), false)

  harness.hide()
  failReload = true
  render()
  await settle()
  controller = render()
  assert.equal(controller.draft.apiKey, "")
  assert.equal(controller.profileDirty, false)
  assert.equal(controller.promptDirty, false)
  assert.match(controller.profileFeedback.message, /读取失败/)
  controller.setDraft((draft) => ({ ...draft, name: "再次编辑" }))
  render()
  assert.equal(dirtyStates.at(-1), true)
})

test("工作台与设置分类的放弃操作在导航前调用草稿清除接口", (t) => {
  const previousWindow = globalThis.window
  globalThis.window = {
    matchMedia: () => ({ matches: true }),
    requestIdleCallback: () => 1,
    cancelIdleCallback() {},
  }
  const names = [
    "ExtractPage",
    "CompressPage",
    "DictionaryPage",
    "HistoryPage",
    "LogsPage",
    "SettingsPage",
  ]
  const pageHarness = sourceHarness({
    "next/dynamic": { default: () => names.shift(), __esModule: true },
  })
  const settingsHarness = sourceHarness({})
  t.after(() => {
    pageHarness.hide()
    settingsHarness.hide()
    globalThis.window = previousWindow
  })
  const Page = pageHarness.load("src/app/page.tsx").default
  let tree = pageHarness.render(Page)
  const shell = () => find(tree, (node) => node.type === "AppShell")
  shell().props.onNavChange("settings")
  tree = pageHarness.render(Page)
  const settings = find(tree, (node) => node.type === "SettingsPage")
  let discarded = 0
  settings.props.ref.current = { discardAiChanges: () => discarded++ }
  settings.props.onAiDirtyChange(true)
  tree = pageHarness.render(Page)
  shell().props.onNavChange("logs")
  tree = pageHarness.render(Page)
  assert.equal(shell().props.activeNav, "settings")
  button(tree, "放弃更改").props.onClick()
  tree = pageHarness.render(Page)
  assert.equal(discarded, 1)
  assert.equal(shell().props.activeNav, "logs")

  const { SettingsPage } = settingsHarness.load(
    "src/components/home/settings-page.tsx"
  )
  const settingsProps = { initialCategory: "ai", onDatabaseRestored() {} }
  tree = settingsHarness.render(SettingsPage, settingsProps)
  const panel = find(tree, (node) => node.type === "AiSettingsPanel")
  panel.props.ref.current = { discardUnsavedChanges: () => discarded++ }
  panel.props.onDirtyChange(true)
  tree = settingsHarness.render(SettingsPage, settingsProps)
  find(tree, (node) => node.type === "Tabs").props.onValueChange("engine")
  tree = settingsHarness.render(SettingsPage, settingsProps)
  assert.equal(find(tree, (node) => node.type === "Tabs").props.value, "ai")
  button(tree, "放弃更改").props.onClick()
  tree = settingsHarness.render(SettingsPage, settingsProps)
  assert.equal(discarded, 2)
  assert.equal(find(tree, (node) => node.type === "Tabs").props.value, "engine")
})

test("批次在页面隐藏期间换任务并完成，返回页面恢复最新结果和可用输入", async (t) => {
  enableClock(t)
  const testWindow = globalThis.window
  Object.assign(globalThis.window, {
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: true }),
  })
  const oldFrame = globalThis.requestAnimationFrame
  const oldCancelFrame = globalThis.cancelAnimationFrame
  globalThis.requestAnimationFrame = () => 1
  globalThis.cancelAnimationFrame = () => {}
  let latest = null
  let sequence = 0
  const harness = sourceHarness({
    "@tauri-apps/api/webview": {
      getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
    },
    "@/lib/dictionary": {
      isDesktopRuntime: () => true,
      countDictionary: async () => 0,
    },
    "@/lib/settings": { getSettings: async () => ({}) },
    "@/lib/sensitive-clipboard": {},
    "@/lib/recovery": {
      getRecoveryCapabilities: async () => ({ methods: [] }),
      analyzeArchive: async (path) => ({
        archivePath: path,
        suggestedOutputDirectory: path + ".out",
      }),
      startRecovery: async ({ archivePath }) => {
        latest = {
          taskId: `batch-${++sequence}`,
          archivePath,
          running: true,
          completed: false,
        }
        return latest
      },
      getRecoveryStatus: async (id) =>
        !id || latest?.taskId === id ? latest : null,
      openOutputDirectory: async () => {},
    },
  })
  t.after(() => {
    const currentWindow = globalThis.window
    globalThis.window = testWindow
    harness.hide()
    globalThis.window = currentWindow
    globalThis.requestAnimationFrame = oldFrame
    globalThis.cancelAnimationFrame = oldCancelFrame
  })
  const { ExtractPage } = harness.load("src/components/home/extract-page.tsx")
  const render = () =>
    harness.render(ExtractPage, { onOpenEngineSettings() {} })
  render()
  await settle()
  const { recoveryQueue } = harness.load("src/lib/recovery-queue-session.ts")
  recoveryQueue.enqueue(["C:\\first.zip", "C:\\second.zip"])
  const completion = recoveryQueue.start({})
  await settle()
  let view = render()
  assert.equal(view.props.task.taskId, "batch-1")
  assert.equal(view.props.running, true)
  harness.hide()
  for (let item = 1; item <= 2; item++) {
    latest = { ...latest, running: false, completed: true, success: true }
    t.mock.timers.tick(700)
    await settle()
  }
  await completion
  render()
  await settle()
  view = render()
  assert.equal(view.props.task.taskId, "batch-2")
  assert.equal(view.props.task.completed, true)
  assert.equal(view.props.running, false)
  assert.equal(view.props.busy, false)
  assert.equal(view.props.queueContent.props.disabled, false)
})

test("历史页面每次恢复都刷新，隐藏前的迟到响应不能覆盖新结果", async (t) => {
  enableClock(t)
  const pending = []
  const harness = sourceHarness({
    "@/lib/history": {
      HISTORY_PAGE_SIZE: 100,
      listRecoveryHistory: () => {
        const request = deferred()
        pending.push(request)
        return request.promise
      },
    },
    "@/lib/sensitive-clipboard": {},
  })
  t.after(() => harness.hide())
  const { HistoryPage } = harness.load("src/components/home/history-page.tsx")
  const result = (id) => ({
    entries: [
      {
        id,
        fingerprintPrefix: `item-${id}`,
        hasPassword: true,
        firstSuccessAtMs: 1000,
        lastVerifiedAtMs: 2000,
      },
    ],
    matchedCount: 1,
    totalCount: 1,
    passwordCount: 1,
  })
  harness.render(HistoryPage)
  assert.equal(pending.length, 1)
  pending[0].resolve(result(1))
  await settle()
  let tree = harness.render(HistoryPage)
  const row = () => find(tree, (node) => node.type?.name === "PasswordCell")
  assert.equal(row().props.entry.id, 1)
  harness.hide()
  harness.render(HistoryPage)
  assert.equal(pending.length, 2)
  harness.hide()
  harness.render(HistoryPage)
  assert.equal(pending.length, 3)
  pending[2].resolve(result(3))
  await settle()
  tree = harness.render(HistoryPage)
  assert.equal(row().props.entry.id, 3)
  pending[1].resolve(result(2))
  await settle()
  tree = harness.render(HistoryPage)
  assert.equal(row().props.entry.id, 3)
})

test("批次轮询保留选中详情，新任务密码默认隐藏且执行状态独立", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] })
  const oldWindow = globalThis.window
  const oldFrame = globalThis.requestAnimationFrame
  const oldCancelFrame = globalThis.cancelAnimationFrame
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: true }),
  }
  globalThis.requestAnimationFrame = () => 1
  globalThis.cancelAnimationFrame = () => {}
  let latest = null,
    sequence = 0
  const harness = sourceHarness({
    "@tauri-apps/api/webview": {
      getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
    },
    "@/lib/dictionary": {
      isDesktopRuntime: () => true,
      countDictionary: async () => 0,
    },
    "@/lib/settings": { getSettings: async () => ({}) },
    "@/lib/sensitive-clipboard": {},
    "@/lib/recovery": {
      getRecoveryCapabilities: async () => ({ methods: [] }),
      analyzeArchive: async (path) => ({
        archivePath: path,
        suggestedOutputDirectory: path + ".out",
      }),
      startRecovery: async ({ archivePath }) =>
        (latest = {
          taskId: `batch-${++sequence}`,
          archivePath,
          running: true,
          completed: false,
        }),
      getRecoveryStatus: async (id) =>
        !id || latest?.taskId === id ? latest : null,
      openOutputDirectory: async () => {},
    },
  })
  t.after(() => {
    harness.hide()
    globalThis.window = oldWindow
    globalThis.requestAnimationFrame = oldFrame
    globalThis.cancelAnimationFrame = oldCancelFrame
  })
  const { ExtractPage } = harness.load("src/components/home/extract-page.tsx")
  const render = () =>
    harness.render(ExtractPage, { onOpenEngineSettings() {} })
  render()
  await settle()
  const { recoveryQueue } = harness.load("src/lib/recovery-queue-session.ts")
  recoveryQueue.enqueue(["C:\\first.zip", "C:\\second.zip"])
  const completion = recoveryQueue.start({})
  await settle()
  let view = render()
  latest = {
    ...latest,
    running: false,
    completed: true,
    success: true,
    recoveredPassword: "synthetic-first",
    rootExtractionCompleted: true,
  }
  t.mock.timers.tick(700)
  await settle()
  view = render()
  assert.equal(view.props.task.taskId, "batch-2")
  assert.equal(view.props.task.recoveredPassword, undefined)
  view.props.queueContent.props.onView(recoveryQueue.getSnapshot().items[0].id)
  view = render()
  assert.equal(view.props.task.taskId, "batch-1")
  assert.equal(view.props.task.completed, true)
  view.props.setShowRecoveredPassword(true)
  view = render()
  latest = { ...latest, elapsedMs: 1400 }
  t.mock.timers.tick(700)
  await settle()
  view = render()
  assert.equal(view.props.task.taskId, "batch-1")
  assert.equal(view.props.showRecoveredPassword, true)
  assert.equal(view.props.running, true)
  latest = {
    ...latest,
    running: false,
    completed: true,
    success: true,
    recoveredPassword: "synthetic-second",
    rootExtractionCompleted: true,
  }
  t.mock.timers.tick(700)
  await settle()
  await completion
  view = render()
  assert.equal(view.props.task.taskId, "batch-1")
  assert.equal(view.props.running, false)
  view.props.queueContent.props.onView(recoveryQueue.getSnapshot().items[1].id)
  view = render()
  assert.equal(view.props.task.taskId, "batch-2")
  assert.equal(view.props.showRecoveredPassword, false)
  assert.equal(view.props.task.recoveredPassword, "synthetic-second")
  harness.hide()
  view = render()
  await settle()
  view = render()
  assert.equal(view.props.task.taskId, "batch-2")
  assert.equal(view.props.showRecoveredPassword, false)
})
