"use client"

import { isTauri } from "@tauri-apps/api/core"
import { openUrl } from "@tauri-apps/plugin-opener"
import {
  Archive,
  History,
  Library,
  PackageOpen,
  ScrollText,
  Settings,
} from "lucide-react"
import * as React from "react"

import { buttonVariants } from "@/components/ui/button"
import { PillNav, type PillNavItem } from "@/components/ui/pill-nav"

export type NavId =
  | "extract"
  | "compress"
  | "dictionary"
  | "history"
  | "logs"
  | "settings"

/** 与底部工具坞从左到右顺序一致，用于页面滑动方向 */
export const NAV_ORDER: NavId[] = [
  "extract",
  "compress",
  "dictionary",
  "history",
  "logs",
  "settings",
]

/** 与 React Bits Pill Nav 适配的底部工具项 */
const NAV_ITEMS: PillNavItem<NavId>[] = [
  { id: "extract", label: "解压", icon: PackageOpen },
  { id: "compress", label: "压缩", icon: Archive },
  { id: "dictionary", label: "字典", icon: Library },
  { id: "history", label: "历史", icon: History },
  {
    id: "logs",
    label: "日志",
    icon: ScrollText,
    dividerBefore: true,
  },
  { id: "settings", label: "设置", icon: Settings },
]

type AppShellProps = {
  activeNav: NavId
  onNavChange: (id: NavId) => void
  onNavPreload?: (id: NavId) => void
  children: React.ReactNode
}

/**
 * 无侧栏、无顶栏导航。工作区全幅铺开，页面切换靠底部的
 * React Bits 风格 Pill Nav。
 */
export function AppShell({
  activeNav,
  onNavChange,
  onNavPreload,
  children,
}: AppShellProps) {
  const [linkError, setLinkError] = React.useState<string | null>(null)

  async function handleRepositoryClick(
    event: React.MouseEvent<HTMLAnchorElement>
  ) {
    if (!isTauri()) return

    event.preventDefault()
    setLinkError(null)
    try {
      await openUrl(event.currentTarget.href)
    } catch {
      setLinkError("无法打开浏览器，请重试或复制 GitHub 链接手动打开。")
    }
  }

  return (
    <div className="app-canvas relative flex h-svh min-h-0 flex-col overflow-hidden text-foreground">
      <main className="min-h-0 min-w-0 flex-1 overflow-hidden pb-32 sm:pb-20">
        {children}
      </main>

      <footer className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-4 pb-16 sm:pb-4">
        <PillNav
          items={NAV_ITEMS}
          activeId={activeNav}
          onSelect={onNavChange}
          onPreload={onNavPreload}
        />
        <a
          href="https://github.com/ZhongYanZhiShi/arc-recall"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="打开 ArcRecall 的 GitHub 仓库"
          onClick={handleRepositoryClick}
          className={buttonVariants({
            variant: "ghost",
            size: "sm",
            className:
              "pointer-events-auto absolute right-4 bottom-4 gap-1.5 text-muted-foreground",
          })}
        >
          <svg
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
            className="size-4"
          >
            <path d="M12 .75a11.25 11.25 0 0 0-3.558 21.923c.563.104.769-.244.769-.542 0-.267-.01-.975-.015-1.914-3.13.68-3.79-1.508-3.79-1.508-.512-1.3-1.25-1.646-1.25-1.646-1.022-.699.077-.685.077-.685 1.13.08 1.725 1.16 1.725 1.16 1.005 1.723 2.637 1.225 3.279.937.102-.728.393-1.225.715-1.507-2.498-.284-5.124-1.25-5.124-5.565 0-1.23.44-2.234 1.16-3.022-.117-.284-.503-1.43.11-2.98 0 0 .945-.303 3.094 1.155A10.79 10.79 0 0 1 12 6.177c.956.004 1.919.13 2.818.379 2.148-1.458 3.091-1.155 3.091-1.155.615 1.55.229 2.696.113 2.98.722.788 1.158 1.792 1.158 3.022 0 4.326-2.63 5.278-5.136 5.556.404.35.766 1.042.766 2.1 0 1.517-.014 2.741-.014 3.113 0 .3.203.65.774.54A11.252 11.252 0 0 0 12 .75Z" />
          </svg>
          GitHub
        </a>
        {linkError ? (
          <p
            role="alert"
            className="pointer-events-auto absolute right-4 bottom-14 max-w-72 rounded-xl border border-destructive/30 bg-card p-3 text-xs text-destructive shadow-sm"
          >
            {linkError}
          </p>
        ) : null}
      </footer>
    </div>
  )
}
