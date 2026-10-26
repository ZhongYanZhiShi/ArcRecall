"use client"

import { isTauri } from "@/lib/runtime"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { Copy, Minus, Square, X } from "lucide-react"
import { useEffect, useState, useSyncExternalStore } from "react"
import { toast } from "sonner"

const subscribe = () => () => {}

/** 仅桌面端显示，窗口操作仍交由 Tauri 和原有关闭处理执行。 */
export function WindowTitlebar() {
  const desktop = useSyncExternalStore(subscribe, isTauri, () => false)
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    if (!desktop) return
    const appWindow = getCurrentWindow()
    let disposed = false
    let unlisten: (() => void) | undefined
    const refresh = async () => {
      const value = await appWindow.isMaximized()
      if (!disposed) setMaximized(value)
    }
    void refresh().catch(() => {})
    void appWindow
      .onResized(() => void refresh().catch(() => {}))
      .then((stop) => {
        if (disposed) stop()
        else unlisten = stop
      })
      .catch(() => {})
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [desktop])

  if (!desktop) return null

  const run = (action: "minimize" | "toggleMaximize" | "close") => {
    void getCurrentWindow()
      [action]()
      .catch(() => {
        toast.error("窗口操作失败，请重试。", { id: "window-control" })
      })
  }
  const buttonClass =
    "flex h-8 w-11 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"

  return (
    <div
      className="relative z-10 flex h-8 shrink-0 items-center bg-background select-none"
      aria-label="窗口标题栏"
    >
      <div
        data-tauri-drag-region
        className="flex h-full min-w-0 flex-1 items-center px-5 text-[11px] tracking-widest text-muted-foreground"
      >
        <span className="pointer-events-none">ArcRecall</span>
      </div>
      <button
        type="button"
        className={buttonClass}
        aria-label="最小化窗口"
        title="最小化"
        onClick={() => run("minimize")}
      >
        <Minus aria-hidden="true" className="size-3.5" />
      </button>
      <button
        type="button"
        className={buttonClass}
        aria-label={maximized ? "还原窗口" : "最大化窗口"}
        title={maximized ? "还原" : "最大化"}
        onClick={() => run("toggleMaximize")}
      >
        {maximized ? (
          <Copy aria-hidden="true" className="size-3" />
        ) : (
          <Square aria-hidden="true" className="size-3" />
        )}
      </button>
      <button
        type="button"
        className={`${buttonClass} hover:bg-red-600 hover:text-white`}
        aria-label="关闭窗口"
        title="关闭"
        onClick={() => run("close")}
      >
        <X aria-hidden="true" className="size-4" />
      </button>
    </div>
  )
}
