"use client"

import { Moon, Sun } from "lucide-react"
import { useTheme } from "next-themes"
import * as React from "react"

import { cn } from "@/lib/utils"

import { CompressView } from "./compress-view"
import { DictionaryView } from "./dictionary-view"
import { ExtractView } from "./extract-view"
import { HistoryView } from "./history-view"
import { LogsView } from "./logs-view"
import { SettingsView } from "./settings-view"

import "./redesign.css"

type NavId =
  | "extract"
  | "compress"
  | "dictionary"
  | "history"
  | "logs"
  | "settings"

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

/**
 * 新界面预览。没有侧栏、没有分栏面板：
 * 顶部一行文字导航，下面整片是当前任务的舞台。
 */
export function RedesignApp() {
  const [active, setActive] = React.useState<NavId>("extract")

  // 挂载期间给 <html> 也加上 rd，让 Portal 弹层用同一套令牌
  React.useEffect(() => {
    const root = document.documentElement
    root.classList.add("rd")
    return () => root.classList.remove("rd")
  }, [])

  return (
    <div className="rd flex h-svh min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <TopLine active={active} onSelect={setActive} />
      <main className="min-h-0 min-w-0 flex-1 overflow-hidden">
        {active === "extract" ? (
          <ExtractView
            onOpenDictionary={() => setActive("dictionary")}
            onOpenSettings={() => setActive("settings")}
          />
        ) : null}
        {active === "compress" ? <CompressView /> : null}
        {active === "dictionary" ? <DictionaryView /> : null}
        {active === "history" ? <HistoryView /> : null}
        {active === "logs" ? <LogsView /> : null}
        {active === "settings" ? <SettingsView /> : null}
      </main>
    </div>
  )
}

function TopLine({
  active,
  onSelect,
}: {
  active: NavId
  onSelect: (id: NavId) => void
}) {
  return (
    <header className="flex shrink-0 items-center gap-4 px-5 pt-3 md:gap-8 md:px-10">
      <span className="flex shrink-0 items-center gap-2 text-[15px] font-semibold tracking-tight">
        <StrataMark />
        <span className="hidden sm:inline">ArcRecall</span>
      </span>
      <nav
        aria-label="功能切换"
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto md:gap-2"
      >
        {TASK_NAV.map((item) => (
          <NavWord
            key={item.id}
            item={item}
            active={active === item.id}
            onSelect={onSelect}
          />
        ))}
        <span
          aria-hidden="true"
          className="mx-1 h-4 w-px shrink-0 bg-foreground/15 md:mx-3"
        />
        {TOOL_NAV.map((item) => (
          <NavWord
            key={item.id}
            item={item}
            active={active === item.id}
            onSelect={onSelect}
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
}: {
  item: { id: NavId; label: string }
  active: boolean
  onSelect: (id: NavId) => void
  quiet?: boolean
}) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={() => onSelect(item.id)}
      className={cn(
        "relative h-11 shrink-0 px-1.5 font-medium transition-colors outline-none sm:px-2",
        quiet ? "text-sm" : "text-[15px]",
        "text-muted-foreground hover:text-foreground focus-visible:text-foreground",
        "focus-visible:after:absolute focus-visible:after:inset-x-1 focus-visible:after:inset-y-1.5 focus-visible:after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-ring",
        active && "text-foreground"
      )}
    >
      {item.label}
      <span
        aria-hidden="true"
        className={cn(
          "absolute inset-x-2 bottom-1.5 h-[2px] rounded-full bg-(--rd-seam) transition-opacity",
          active ? "opacity-100" : "opacity-0"
        )}
      />
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

/** 品牌记号：三道由宽到窄的板 */
function StrataMark() {
  return (
    <svg
      viewBox="0 0 28 28"
      className="size-6"
      role="img"
      aria-label="ArcRecall"
    >
      <rect
        x="3"
        y="5"
        width="22"
        height="5"
        rx="1"
        fill="var(--rd-stratum-2)"
      />
      <rect
        x="6"
        y="12"
        width="16"
        height="5"
        rx="1"
        fill="var(--rd-stratum-3)"
      />
      <rect x="9" y="19" width="10" height="5" rx="1" fill="var(--rd-seam)" />
    </svg>
  )
}
