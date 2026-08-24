"use client"

import {
  Archive,
  History,
  Library,
  PackageOpen,
  ScrollText,
  Settings,
} from "lucide-react"
import * as React from "react"

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
  return (
    <div className="app-canvas relative flex h-svh min-h-0 flex-col overflow-hidden text-foreground">
      <main className="min-h-0 min-w-0 flex-1 overflow-hidden pb-20">
        {children}
      </main>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-4 pb-4">
        <PillNav
          items={NAV_ITEMS}
          activeId={activeNav}
          onSelect={onNavChange}
          onPreload={onNavPreload}
        />
      </div>
    </div>
  )
}
