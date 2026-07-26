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
}

/** 主任务工具（文案优先两字） */
const WORK_TOOLS: ToolItem[] = [
  { id: "extract", label: "解压", icon: PackageOpen },
  { id: "compress", label: "压缩", icon: Archive },
  { id: "dictionary", label: "字典", icon: Library },
  { id: "history", label: "历史", icon: History },
]

/** 运维类工具（文案优先两字） */
const OPS_TOOLS: ToolItem[] = [
  { id: "logs", label: "日志", icon: ScrollText },
  { id: "settings", label: "设置", icon: Settings },
]

type AppShellProps = {
  activeNav: NavId
  onNavChange: (id: NavId) => void
  children: React.ReactNode
}

type Indicator = {
  left: number
  top: number
  width: number
  height: number
  ready: boolean
}

/**
 * 无侧栏、无顶栏导航。
 * 工作区全幅铺开，页面切换靠底部悬浮工具坞；选中态用滑动指示器过渡。
 */
export function AppShell({ activeNav, onNavChange, children }: AppShellProps) {
  const navRef = React.useRef<HTMLElement>(null)
  const buttonRefs = React.useRef(new Map<NavId, HTMLButtonElement>())
  const [indicator, setIndicator] = React.useState<Indicator>({
    left: 0,
    top: 0,
    width: 0,
    height: 0,
    ready: false,
  })

  const setButtonRef = React.useCallback(
    (id: NavId, node: HTMLButtonElement | null) => {
      if (node) {
        buttonRefs.current.set(id, node)
      } else {
        buttonRefs.current.delete(id)
      }
    },
    []
  )

  const updateIndicator = React.useCallback(() => {
    const nav = navRef.current
    const button = buttonRefs.current.get(activeNav)
    if (!nav || !button) {
      return
    }

    // getBoundingClientRect 相对边框盒；absolute + left/top:0 相对 padding 盒，需扣掉 border
    const navRect = nav.getBoundingClientRect()
    const buttonRect = button.getBoundingClientRect()
    const borderLeft = nav.clientLeft
    const borderTop = nav.clientTop

    setIndicator({
      left: buttonRect.left - navRect.left - borderLeft,
      top: buttonRect.top - navRect.top - borderTop,
      width: buttonRect.width,
      height: buttonRect.height,
      ready: true,
    })
  }, [activeNav])

  React.useLayoutEffect(() => {
    updateIndicator()
  }, [updateIndicator])

  React.useEffect(() => {
    const nav = navRef.current
    if (!nav) {
      return
    }

    const observer = new ResizeObserver(() => {
      updateIndicator()
    })
    observer.observe(nav)

    window.addEventListener("resize", updateIndicator)
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", updateIndicator)
    }
  }, [updateIndicator])

  return (
    <div className="relative flex h-svh min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <main className="min-h-0 min-w-0 flex-1 overflow-hidden pb-20">
        {children}
      </main>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-4 pb-4">
        <nav
          ref={navRef}
          aria-label="功能切换"
          className={cn(
            "pointer-events-auto relative flex items-center gap-1 rounded-2xl border border-border/80 bg-background/90 p-1.5",
            "shadow-lg shadow-black/5 backdrop-blur-md dark:shadow-black/30",
            "animate-dock-enter motion-safe-only"
          )}
        >
          {/* 滑动选中指示器：锚定 padding 盒原点，再用 transform 对齐按钮 */}
          <span
            aria-hidden
            className={cn(
              "pointer-events-none absolute top-0 left-0 rounded-xl bg-foreground shadow-sm",
              "transition-[transform,width,height,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
              indicator.ready ? "opacity-100" : "opacity-0"
            )}
            style={{
              width: indicator.width,
              height: indicator.height,
              transform: `translate3d(${indicator.left}px, ${indicator.top}px, 0)`,
            }}
          />

          <ToolGroup
            items={WORK_TOOLS}
            activeNav={activeNav}
            onNavChange={onNavChange}
            setButtonRef={setButtonRef}
          />

          <span
            aria-hidden
            className="relative z-10 mx-0.5 h-6 w-px shrink-0 bg-border"
          />

          <ToolGroup
            items={OPS_TOOLS}
            activeNav={activeNav}
            onNavChange={onNavChange}
            setButtonRef={setButtonRef}
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
  setButtonRef,
}: {
  items: ToolItem[]
  activeNav: NavId
  onNavChange: (id: NavId) => void
  setButtonRef: (id: NavId, node: HTMLButtonElement | null) => void
}) {
  return (
    <ul className="relative z-10 flex items-center gap-0.5">
      {items.map((item) => (
        <li key={item.id}>
          <ToolButton
            item={item}
            active={activeNav === item.id}
            onClick={() => onNavChange(item.id)}
            ref={(node) => setButtonRef(item.id, node)}
          />
        </li>
      ))}
    </ul>
  )
}

const ToolButton = React.forwardRef<
  HTMLButtonElement,
  {
    item: ToolItem
    active: boolean
    onClick: () => void
  }
>(function ToolButton({ item, active, onClick }, ref) {
  const Icon = item.icon

  return (
    <button
      ref={ref}
      type="button"
      title={item.label}
      aria-label={item.label}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={cn(
        "group relative flex size-10 items-center justify-center rounded-xl leading-none outline-none",
        "transition-dock focus-visible:ring-2 focus-visible:ring-ring/40",
        "active:scale-95",
        active
          ? "text-background"
          : "text-muted-foreground hover:scale-105 hover:bg-muted/80 hover:text-foreground"
      )}
    >
      <Icon
        aria-hidden
        className={cn(
          "size-4 shrink-0 transition-transform duration-200 ease-out",
          active ? "scale-105" : "group-hover:scale-110"
        )}
        strokeWidth={active ? 2.25 : 1.9}
      />
      <span
        className={cn(
          "pointer-events-none absolute -top-9 left-1/2 z-10 -translate-x-1/2",
          "rounded-md border border-border bg-popover px-2 py-0.5 whitespace-nowrap",
          "text-[11px] font-medium text-popover-foreground shadow-sm",
          "origin-bottom scale-95 opacity-0",
          "transition-[opacity,transform] duration-150 ease-out",
          "group-hover:scale-100 group-hover:opacity-100",
          "group-focus-visible:scale-100 group-focus-visible:opacity-100"
        )}
      >
        {item.label}
      </span>
    </button>
  )
})
