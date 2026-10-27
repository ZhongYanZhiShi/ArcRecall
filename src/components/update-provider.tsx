"use client"

import * as React from "react"
import { toast } from "sonner"
import { invoke } from "@tauri-apps/api/core"

import { AppUpdateNotes } from "@/components/app-update-notes"
import { isDesktopRuntime } from "@/lib/runtime"
import { updateSettings } from "@/lib/settings"
import { recoveryQueue } from "@/lib/recovery-queue-session"
import { compressionQueue } from "@/lib/compression-queue-session"

type UpdateStatus = {
  currentVersion: string
  configured: boolean
  autoUpdate: boolean
  phase:
    | "idle"
    | "checking"
    | "available"
    | "current"
    | "downloading"
    | "ready"
    | "installing"
    | "error"
  version: string | null
  notes: string | null
  downloadedBytes: number
  totalBytes: number | null
  lastChecked: number | null
  error: string | null
  installBlocked: boolean
  cached: boolean
  cacheWarning: string | null
}

const INITIAL_STATUS: UpdateStatus = {
  currentVersion: "",
  configured: false,
  autoUpdate: false,
  phase: "idle",
  version: null,
  notes: null,
  downloadedBytes: 0,
  totalBytes: null,
  lastChecked: null,
  error: null,
  installBlocked: true,
  cached: false,
  cacheWarning: null,
}

type UpdateContextValue = {
  status: UpdateStatus
  desktop: boolean
  loaded: boolean
  busy: boolean
  error: string | null
  check: () => Promise<void>
  download: () => Promise<void>
  install: () => Promise<void>
  setAutomatic: (enabled: boolean) => Promise<void>
  open: boolean
  setOpen: (open: boolean) => void
  taskBlocked: boolean
  reminder: boolean
  setReminder: (enabled: boolean) => void
  installGuard: { reason: string; resolve: () => void } | null
  setInstallGuard: (
    guard: { reason: string; resolve: () => void } | null
  ) => void
}

const UpdateContext = React.createContext<UpdateContextValue | null>(null)

function recoveryBlocksUpdate() {
  const queue = recoveryQueue.getSnapshot()
  return (
    queue.running ||
    queue.items.some(
      (item) => item.state === "waiting" || item.state === "analyzing"
    )
  )
}

function compressionBlocksUpdate() {
  const queue = compressionQueue.getSnapshot()
  return queue.running || queue.items.some((item) => item.state === "waiting")
}

export function UpdateProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = React.useState(INITIAL_STATUS)
  const [desktop, setDesktop] = React.useState(false)
  const [loaded, setLoaded] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const announcedUpdates = React.useRef(new Set<string>())
  const operation = React.useRef(false)
  const [open, setOpen] = React.useState(false)
  const [releaseNotes, setReleaseNotes] = React.useState<{
    version: string
    notes: string | null
  } | null>(null)
  const [reminder, setReminder] = React.useState(false)
  const [installGuard, setInstallGuard] =
    React.useState<UpdateContextValue["installGuard"]>(null)
  const recoveryBlocked = React.useSyncExternalStore(
    recoveryQueue.subscribe,
    recoveryBlocksUpdate,
    recoveryBlocksUpdate
  )
  const compressionBlocked = React.useSyncExternalStore(
    compressionQueue.subscribe,
    compressionBlocksUpdate,
    compressionBlocksUpdate
  )
  const taskBlocked =
    status.installBlocked || recoveryBlocked || compressionBlocked

  const reportUpdateError = React.useCallback((message: string) => {
    setError(message)
    toast.error(message, { id: "app-update", duration: 6_000 })
  }, [])

  const refresh = React.useCallback(async () => {
    const next = await invoke<UpdateStatus>("app_update_status")
    setStatus(next)
    setLoaded(true)
  }, [])

  const run = React.useCallback(
    async (
      command: string,
      args?: Record<string, unknown>,
      automatic = false
    ) => {
      if (!isDesktopRuntime() || operation.current) return
      operation.current = true
      setBusy(true)
      setError(null)
      try {
        await invoke(command, args)
      } catch (cause) {
        if (!automatic) reportUpdateError(String(cause))
      } finally {
        operation.current = false
        setBusy(false)
        await refresh().catch((cause) => {
          const message = `读取更新状态失败：${String(cause)}`
          if (automatic) setError(message)
          else reportUpdateError(message)
        })
      }
    },
    [refresh, reportUpdateError]
  )

  React.useEffect(() => {
    if (!isDesktopRuntime()) return
    let cancelled = false
    let poll: ReturnType<typeof setTimeout>
    const read = async () => {
      try {
        const next = await invoke<UpdateStatus>("app_update_status")
        if (cancelled) return
        setLoaded(true)
        setStatus(next)
        setError(null)
      } catch (cause) {
        if (!cancelled) setError(`读取更新状态失败：${String(cause)}`)
      }
      if (!cancelled)
        poll = setTimeout(() => void read(), operation.current ? 500 : 5000)
    }
    const startup = setTimeout(() => {
      setDesktop(true)
      void invoke("app_update_started").catch(() => {})
      void read()
      void run("app_update_check", { reason: "startup" }, true)
    }, 0)
    const interval = setInterval(
      () => {
        void run("app_update_check", { reason: "scheduled" }, true)
      },
      6 * 60 * 60 * 1000
    )
    return () => {
      cancelled = true
      clearTimeout(startup)
      clearTimeout(poll)
      clearInterval(interval)
    }
  }, [run])

  const setAutomatic = async (enabled: boolean) => {
    if (operation.current) return
    operation.current = true
    setBusy(true)
    setError(null)
    try {
      await updateSettings({ kind: "autoUpdate", value: enabled })
      await refresh()
    } catch (cause) {
      reportUpdateError(`保存自动更新设置失败：${String(cause)}`)
      return
    } finally {
      operation.current = false
      setBusy(false)
    }
    if (enabled) await run("app_update_check", { reason: "scheduled" }, true)
  }

  // Automatic failures stay in the persistent entry; only explicit actions toast.
  React.useEffect(() => {
    if (!reminder || taskBlocked || status.phase !== "ready") return
    const timer = setTimeout(() => {
      setReminder(false)
      toast.info("任务已结束，更新已就绪。", {
        id: "app-update",
        duration: 10_000,
        action: { label: "查看更新", onClick: () => setOpen(true) },
      })
    }, 300)
    return () => clearTimeout(timer)
  }, [reminder, taskBlocked, status.phase])

  React.useEffect(() => {
    if (error || status.error) return
    if (
      !status.version ||
      (status.phase !== "ready" && (status.phase !== "available" || busy))
    )
      return
    const key = `${status.phase}:${status.version}`
    if (announcedUpdates.current.has(key)) return
    announcedUpdates.current.add(key)
    try {
      if (localStorage.getItem(`app-update-announced:${key}`)) return
      localStorage.setItem(`app-update-announced:${key}`, "1")
    } catch {
      /* Storage is optional; the persistent entry still works. */
    }
    toast.info(
      status.phase === "ready"
        ? `版本 ${status.version} 已准备好，方便时即可安装。`
        : `发现新版本 ${status.version}。`,
      {
        id: "app-update",
        duration: 6_000,
        action: { label: "查看更新", onClick: () => setOpen(true) },
      }
    )
  }, [busy, error, status.error, status.phase, status.version])

  React.useEffect(() => {
    if (!loaded || !status.currentVersion) return
    try {
      const target = localStorage.getItem("app-update-installing")
      if (target !== status.currentVersion) return
      localStorage.removeItem("app-update-installing")
      let notes: string | null = null
      try {
        const previous = JSON.parse(
          localStorage.getItem("app-update-last-release") ?? "null"
        )
        if (
          previous?.version === status.currentVersion &&
          typeof previous.notes === "string"
        )
          notes = previous.notes
      } catch {
        /* Invalid cached notes do not prevent the success notification. */
      }
      toast.success(`已更新至 v${status.currentVersion}`, {
        id: "app-update-complete",
        action: {
          label: "更新说明",
          onClick: () =>
            setReleaseNotes({ version: status.currentVersion, notes }),
        },
      })
    } catch {
      /* A missing storage marker must not prevent updates. */
    }
  }, [loaded, status.currentVersion])

  return (
    <UpdateContext.Provider
      value={{
        status,
        desktop,
        loaded,
        busy,
        error,
        check: () => run("app_update_check", { reason: "manual" }),
        download: () => run("app_update_download"),
        install: async () => {
          if (taskBlocked || installGuard) return
          // Fresh native check; the install command retains its atomic reservation.
          const next = await invoke<UpdateStatus>("app_update_status").catch(
            () => null
          )
          if (!next) {
            reportUpdateError("暂时无法确认任务状态，请重试。")
            return
          }
          setStatus(next)
          if (
            next.installBlocked ||
            recoveryBlocksUpdate() ||
            compressionBlocksUpdate()
          )
            return
          try {
            if (next.version)
              localStorage.setItem("app-update-installing", next.version)
            localStorage.setItem(
              "app-update-last-release",
              JSON.stringify({ version: next.version, notes: next.notes })
            )
          } catch {
            /* Optional post-update notification. */
          }
          await run("app_update_install", {
            theme: document.documentElement.classList.contains("light")
              ? "light"
              : "dark",
          })
        },
        setAutomatic,
        open,
        setOpen,
        taskBlocked,
        reminder,
        setReminder,
        installGuard,
        setInstallGuard,
      }}
    >
      {children}
      <AppUpdateNotes
        notes={releaseNotes?.notes ?? null}
        version={releaseNotes?.version ?? null}
        open={releaseNotes !== null}
        onOpenChange={(next) => {
          if (!next) setReleaseNotes(null)
        }}
      />
    </UpdateContext.Provider>
  )
}

export function useAppUpdate() {
  const value = React.useContext(UpdateContext)
  if (!value) throw new Error("useAppUpdate requires UpdateProvider")
  return value
}
