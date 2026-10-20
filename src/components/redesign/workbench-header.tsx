"use client"

import { Moon, Sun } from "lucide-react"
import { useTheme } from "next-themes"
import * as React from "react"

import type { NavId } from "@/components/app-shell"
import { cn } from "@/lib/utils"

const TASK_NAV: { id: NavId; label: string }[] = [
  { id: "extract", label: "解压" },
  { id: "compress", label: "压缩" },
  { id: "dictionary", label: "字典" },
  { id: "history", label: "历史" },
]

const TOOL_NAV: { id: NavId; label: string }[] = [
  { id: "logs", label: "日志" },
  { id: "settings", label: "设置" },
]

export function WorkbenchHeader({
  active,
  onSelect,
  onPreload,
  onRepositoryClick,
}: {
  active: NavId
  onSelect: (id: NavId) => void
  onPreload?: (id: NavId) => void
  onRepositoryClick?: (event: React.MouseEvent<HTMLAnchorElement>) => void
}) {
  return (
    <header className="byte-header relative flex shrink-0 items-center">
      <a
        href="https://github.com/ZhongYanZhiShi/ArcRecall"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="打开 ArcRecall 的 GitHub 仓库"
        onClick={onRepositoryClick}
        className="byte-brand shrink-0 font-mono text-sm font-bold outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        ARCRECALL
      </a>
      <nav
        aria-label="功能切换"
        className="byte-nav flex min-w-0 flex-1 items-center overflow-x-auto"
      >
        {TASK_NAV.map((item) => (
          <NavWord
            key={item.id}
            item={item}
            active={active === item.id}
            onSelect={onSelect}
            onPreload={onPreload}
          />
        ))}
        <span aria-hidden="true" className="byte-nav-spacer" />
        {TOOL_NAV.map((item) => (
          <NavWord
            key={item.id}
            item={item}
            active={active === item.id}
            onSelect={onSelect}
            onPreload={onPreload}
            quiet
          />
        ))}
      </nav>
      <ThemeButton />
    </header>
  )
}

function NavWord({
  item,
  active,
  onSelect,
  quiet = false,
  onPreload,
}: {
  item: { id: NavId; label: string }
  active: boolean
  onSelect: (id: NavId) => void
  quiet?: boolean
  onPreload?: (id: NavId) => void
}) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={() => onSelect(item.id)}
      onPointerEnter={() => onPreload?.(item.id)}
      onFocus={() => onPreload?.(item.id)}
      className={cn(
        "relative h-11 shrink-0 font-medium transition-colors outline-none",
        quiet ? "text-sm" : "text-[15px]",
        "text-muted-foreground hover:text-foreground focus-visible:text-foreground",
        "focus-visible:after:absolute focus-visible:after:inset-x-1 focus-visible:after:inset-y-1.5 focus-visible:after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-ring",
        active && "text-foreground"
      )}
    >
      {item.label}
    </button>
  )
}

const noopSubscribe = () => () => {}

function ThemeButton() {
  const { resolvedTheme, setTheme } = useTheme()
  // 服务端渲染时主题未知，挂载后再显示对应图标，避免水合不一致
  const mounted = React.useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false
  )
  const dark = mounted && resolvedTheme === "dark"
  return (
    <button
      type="button"
      onClick={() => setTheme(dark ? "light" : "dark")}
      aria-label={dark ? "切换到浅色" : "切换到深色"}
      className="flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      {dark ? (
        <Sun className="size-[18px]" />
      ) : (
        <Moon className="size-[18px]" />
      )}
    </button>
  )
}
