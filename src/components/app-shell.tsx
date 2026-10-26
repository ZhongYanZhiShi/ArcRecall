"use client"

import { isTauri } from "@/lib/runtime"
import { openUrl } from "@tauri-apps/plugin-opener"
import * as React from "react"
import type { ByteStreamActivity } from "@/lib/byte-stream-motion"
import { toast } from "sonner"

import { WorkbenchHeader } from "@/components/redesign/workbench-header"
import { WindowTitlebar } from "@/components/window-titlebar"
import { ByteStreamBackground } from "@/components/redesign/byte-stream-background"

export type NavId =
  | "extract"
  | "compress"
  | "dictionary"
  | "history"
  | "logs"
  | "settings"

/** 与顶部文字导航顺序一致，用于页面滑动方向 */
export const NAV_ORDER: NavId[] = [
  "extract",
  "compress",
  "dictionary",
  "history",
  "logs",
  "settings",
]

type AppShellProps = {
  streamActivity?: ByteStreamActivity
  activeNav: NavId
  onNavChange: (id: NavId) => void
  onNavPreload?: (id: NavId) => void
  children: React.ReactNode
}

/** 文字导航与整片任务舞台；业务页面的状态由主入口保留。 */
export function AppShell({
  activeNav,
  streamActivity = "idle",
  onNavChange,
  onNavPreload,
  children,
}: AppShellProps) {
  async function handleRepositoryClick(
    event: React.MouseEvent<HTMLAnchorElement>
  ) {
    if (!isTauri()) return

    event.preventDefault()
    try {
      await openUrl(event.currentTarget.href)
    } catch {
      toast.error("无法打开浏览器，请重试或复制 GitHub 链接手动打开。", {
        id: "repository-link",
        duration: 6_000,
      })
    }
  }

  return (
    <div
      data-active-page={activeNav}
      className="byte-app relative isolate flex h-svh min-h-0 flex-col overflow-hidden bg-background text-foreground"
    >
      <ByteStreamBackground activity={streamActivity} />
      <WindowTitlebar />
      <WorkbenchHeader
        active={activeNav}
        onSelect={onNavChange}
        onPreload={onNavPreload}
        onRepositoryClick={handleRepositoryClick}
      />
      <main id="workbench" className="min-h-0 min-w-0 flex-1 overflow-hidden">
        {children}
      </main>
    </div>
  )
}
