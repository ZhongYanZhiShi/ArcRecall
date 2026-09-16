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

test("扫描上限保存、错误处理和解密方式切换保留其他设置", async (t) => {
  let saved = {
    recovery: { computeMode: "cpuOnly" },
    engine: { hashcatPath: "existing-engine" },
  }
  let writes = 0
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
        writes += 1
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
    assert.equal(writes, 0)
  }
  card().onScanLimitChange("0")
  card().onSaveScanLimit()
  await settle()
  assert.deepEqual(saved.recovery, {
    computeMode: "cpuOnly",
    scanMaxFilesPerDirectory: 0,
  })
  assert.equal(saved.engine.hashcatPath, "existing-engine")
  saved.engine.hashcatPath = "newly-installed-engine"
  card().onChange("gpuPreferred")
  await settle()
  assert.equal(saved.engine.hashcatPath, "newly-installed-engine")
  assert.deepEqual(saved.recovery, {
    computeMode: "gpuPreferred",
    scanMaxFilesPerDirectory: 0,
  })
  rejectSave = true
  card().onScanLimitChange("25")
  card().onSaveScanLimit()
  await settle()
  assert.equal(card().scanLimitValue, "25")
  assert.equal(card().messageError, true)
  assert.equal(saved.recovery.scanMaxFilesPerDirectory, 0)
  rejectSave = false
  card().onSaveScanLimit()
  await settle()
  assert.equal(saved.recovery.scanMaxFilesPerDirectory, 25)
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
  pendingReveal = deferred()
  passwordCell(tree).props.onReveal()
  harness.hide()
  pendingReveal.resolve("late-secret")
  await settle()
  tree = harness.render(HistoryPage)
  assert.equal(passwordCell(tree).props.revealed, null)
  harness.hide()
})
