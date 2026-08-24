"use client"

import type { LucideIcon } from "lucide-react"
import * as React from "react"

import { cn } from "@/lib/utils"

export type PillNavItem<T extends string> = {
  id: T
  label: string
  icon: LucideIcon
  dividerBefore?: boolean
}

type PillNavProps<T extends string> = {
  items: PillNavItem<T>[]
  activeId: T
  onSelect: (id: T) => void
  onPreload?: (id: T) => void
  className?: string
  initialLoadAnimation?: boolean
}

/**
 * Adapted from React Bits' Pill Nav for ArcRecall's state-driven dock.
 * Source: https://www.reactbits.dev/components/pill-nav
 */
export function PillNav<T extends string>({
  items,
  activeId,
  onSelect,
  onPreload,
  className,
  initialLoadAnimation = true,
}: PillNavProps<T>) {
  return (
    <nav
      aria-label="功能切换"
      className={cn(
        "pointer-events-auto relative flex items-stretch gap-0.5 rounded-full border border-border/80 bg-card/95 p-1",
        "shadow-lg shadow-foreground/8 dark:shadow-black/40",
        initialLoadAnimation && "animate-page-enter motion-safe-only",
        className
      )}
    >
      <ul className="flex items-stretch gap-0.5">
        {items.map((item) => {
          const Icon = item.icon
          const active = item.id === activeId

          return (
            <React.Fragment key={item.id}>
              {item.dividerBefore ? (
                <li
                  aria-hidden="true"
                  role="presentation"
                  className="mx-0.5 flex items-center px-0.5"
                >
                  <span className="h-6 w-px bg-border" />
                </li>
              ) : null}

              <li className="flex h-12 min-w-12">
                <button
                  type="button"
                  aria-label={item.label}
                  aria-current={active ? "page" : undefined}
                  data-active={active ? "true" : undefined}
                  onClick={() => onSelect(item.id)}
                  onFocus={() => onPreload?.(item.id)}
                  onMouseEnter={() => onPreload?.(item.id)}
                  className={cn(
                    "group/pill relative inline-flex h-full min-w-12 items-center justify-center rounded-full px-2",
                    "bg-background/70 text-xs leading-none font-semibold text-foreground hover:bg-primary hover:text-primary-foreground focus-visible:bg-primary focus-visible:text-primary-foreground data-[active=true]:bg-accent data-[active=true]:text-accent-foreground data-[active=true]:hover:bg-primary data-[active=true]:hover:text-primary-foreground data-[active=true]:focus-visible:bg-primary data-[active=true]:focus-visible:text-primary-foreground",
                    "transition-[color,background-color,box-shadow,transform] duration-200 outline-none active:scale-[0.97] motion-reduce:transition-none",
                    "focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card"
                  )}
                >
                  <span className="relative z-[2] inline-flex h-full flex-col items-center justify-center gap-0.5">
                    <Icon
                      aria-hidden="true"
                      className="size-4"
                      strokeWidth={active ? 2.35 : 1.9}
                    />
                    <span>{item.label}</span>
                  </span>

                  {active ? (
                    <span
                      aria-hidden="true"
                      className="absolute bottom-1 left-1/2 z-[4] h-0.5 w-4 -translate-x-1/2 rounded-full bg-primary"
                    />
                  ) : null}
                </button>
              </li>
            </React.Fragment>
          )
        })}
      </ul>
    </nav>
  )
}
