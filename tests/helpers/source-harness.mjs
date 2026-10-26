import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

const root = fileURLToPath(new URL("../../", import.meta.url))

// Execute the real event handlers and JSX with only React's lifecycle and IPC
// replaced. These regressions do not start Tauri, a browser, or write user data.
export function sourceHarness(overrides) {
  const notifications = []
  const slots = []
  const pendingEffects = []
  const pendingImports = []
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
    // This harness tests handlers, not React's render scheduling.
    memo(component) {
      return component
    },
    createContext() {
      return { Provider: "ContextProvider" }
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
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot()
    },
  }
  const ui = new Proxy({}, { get: (_, key) => key })
  const jsx = (type, props, key) => ({
    type: type?.dynamic ? type.component : type,
    props,
    key,
  })
  const modules = new Map()
  const mocks = {
    "next/dynamic": {
      __esModule: true,
      default(loader) {
        const entry = { dynamic: true }
        pendingImports.push(
          loader().then((component) => {
            entry.component = component
          })
        )
        return entry
      },
    },
    sonner: {
      toast: Object.fromEntries(
        ["success", "error", "info", "warning"].map((type) => [
          type,
          (message) => notifications.push({ type, message }),
        ])
      ),
    },
    react: React,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "@/lib/utils": { cn: () => "" },
    "@tauri-apps/api/core": {
      invoke: async (command) => {
        if (command === "recovery_queue_load")
          return { version: 1, enabled: false, items: [] }
        if (command === "recovery_queue_save") return
        throw new Error(`Unexpected command: ${command}`)
      },
    },
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
        if (name.startsWith(".")) {
          const resolved = path.posix.normalize(
            path.posix.join(path.posix.dirname(relative), name)
          )
          const alias = `@/${resolved.replace(/^src\//, "").replace(/\.tsx?$/, "")}`
          if (alias in mocks) return mocks[alias]
          const filename = [resolved, `${resolved}.ts`, `${resolved}.tsx`].find(
            (candidate) => fs.existsSync(path.join(root, candidate))
          )
          if (filename) return load(filename)
        }
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
    notifications,
    load,
    resolveImports: () => Promise.all(pendingImports),
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
