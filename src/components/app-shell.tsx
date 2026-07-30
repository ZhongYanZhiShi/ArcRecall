"use client"

import {
  Archive,
  History,
  Library,
  PackageOpen,
  ScrollText,
  Settings,
  type LucideIcon,
} from "lucide-react"
import * as React from "react"

import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

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

type ToolItem = {
  id: NavId
  label: string
  icon: LucideIcon
  shortcut: string
}

/** 主任务工具（文案优先两字） */
const WORK_TOOLS: ToolItem[] = [
  { id: "extract", label: "解压", icon: PackageOpen, shortcut: "1" },
  { id: "compress", label: "压缩", icon: Archive, shortcut: "2" },
  { id: "dictionary", label: "字典", icon: Library, shortcut: "3" },
  { id: "history", label: "历史", icon: History, shortcut: "4" },
]

/** 运维类工具（文案优先两字） */
const OPS_TOOLS: ToolItem[] = [
  { id: "logs", label: "日志", icon: ScrollText, shortcut: "5" },
  { id: "settings", label: "设置", icon: Settings, shortcut: "6" },
]

type AppShellProps = {
  activeNav: NavId
  onNavChange: (id: NavId) => void
  children: React.ReactNode
}

/**
 * 无侧栏、无顶栏导航。
 * 工作区全幅铺开，页面切换靠底部悬浮工具坞。
 */
export function AppShell({ activeNav, onNavChange, children }: AppShellProps) {
  return (
    <div className="app-canvas relative flex h-svh min-h-0 flex-col overflow-hidden text-foreground">
      <main className="min-h-0 min-w-0 flex-1 overflow-hidden pb-20">
        {children}
      </main>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-4 pb-4">
        <nav
          aria-label="功能切换"
          className={cn(
            "pointer-events-auto relative flex items-center gap-1 rounded-2xl border border-border/80 bg-card/90 p-1.5",
            "shadow-lg shadow-primary/5 backdrop-blur-md dark:shadow-black/30",
            "animate-dock-enter motion-safe-only"
          )}
        >
          <ToolGroup
            items={WORK_TOOLS}
            activeNav={activeNav}
            onNavChange={onNavChange}
          />

          <span
            aria-hidden
            className="relative z-10 mx-0.5 h-6 w-px shrink-0 bg-border"
          />

          <ToolGroup
            items={OPS_TOOLS}
            activeNav={activeNav}
            onNavChange={onNavChange}
          />
        </nav>
      </div>
    </div>
  )
}

function ToolGroup({
  items,
  activeNav,
  onNavChange,
}: {
  items: ToolItem[]
  activeNav: NavId
  onNavChange: (id: NavId) => void
}) {
  return (
    <ul className="relative z-10 flex items-center gap-0.5">
      {items.map((item) => (
        <li key={item.id}>
          <ToolButton
            item={item}
            active={activeNav === item.id}
            onClick={() => onNavChange(item.id)}
          />
        </li>
      ))}
    </ul>
  )
}

function ToolButton({
  item,
  active,
  onClick,
}: {
  item: ToolItem
  active: boolean
  onClick: () => void
}) {
  const Icon = item.icon

  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={item.label}
          aria-current={active ? "page" : undefined}
          aria-keyshortcuts={`Control+${item.shortcut} Meta+${item.shortcut}`}
          onClick={onClick}
          className={cn(
            "transition-dock relative h-11 min-w-11 flex-col gap-0.5 rounded-xl px-2 text-xs leading-none active:scale-95",
            active
              ? "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 hover:text-primary-foreground"
              : "text-muted-foreground hover:scale-105"
          )}
        >
          <Icon
            aria-hidden
            className="transition-transform duration-200 ease-out group-hover/button:scale-110"
            strokeWidth={active ? 2.25 : 1.9}
          />
          <span>{item.label}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {item.label}
        <Kbd>Ctrl/⌘ + {item.shortcut}</Kbd>
      </TooltipContent>
    </Tooltip>
  )
}
