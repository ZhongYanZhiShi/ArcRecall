"use client"

import * as React from "react"
import { toast } from "sonner"
import { invoke } from "@tauri-apps/api/core"

import { isDesktopRuntime } from "@/lib/runtime"
import { updateSettings } from "@/lib/settings"

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
}

const UpdateContext = React.createContext<UpdateContextValue | null>(null)

export function UpdateProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = React.useState(INITIAL_STATUS)
  const [desktop, setDesktop] = React.useState(false)
  const [loaded, setLoaded] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const announcedUpdates = React.useRef(new Set<string>())
  const reportedError = React.useRef<string | null>(null)
  const operation = React.useRef(false)

  const reportUpdateError = React.useCallback((message: string) => {
    reportedError.current = message
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

  React.useEffect(() => {
    if (busy) return
    const message = error ?? status.error
    if (!message) {
      reportedError.current = null
      return
    }
    if (reportedError.current === message) return
    reportedError.current = message
    toast.error(message, { id: "app-update", duration: 6_000 })
  }, [busy, error, status.error])

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
    toast.info(
      status.phase === "ready"
        ? `版本 ${status.version} 已下载，可在“设置 → 应用”安装更新。`
        : `发现新版本 ${status.version}，可在“设置 → 应用”下载更新。`,
      { id: "app-update", duration: 6_000 }
    )
  }, [busy, error, status.error, status.phase, status.version])

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
        install: () => run("app_update_install"),
        setAutomatic,
      }}
    >
      {children}
    </UpdateContext.Provider>
  )
}

export function useAppUpdate() {
  const value = React.useContext(UpdateContext)
  if (!value) throw new Error("useAppUpdate requires UpdateProvider")
  return value
}
