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
  const jsx = (type, props) => ({ type, props })
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

test("恢复启动期间拒绝拖放、粘贴、重复启动和过期选择器", async (t) => {
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
