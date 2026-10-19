import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Loader2,
  type LucideIcon,
  OctagonX,
} from "lucide-react"
import * as React from "react"

import { cn } from "@/lib/utils"

/* —— 页面框架 —— */

/**
 * 舞台页：没有面板和分栏，只有一列内容在整片背景上展开。
 * 页面根节点不滚动，内容区自己滚动。
 */
export function RdStage({
  label,
  children,
  footer,
  className,
}: {
  /** 读屏用的页面名称，例如“字典” */
  label: string
  children: React.ReactNode
  footer?: React.ReactNode
  className?: string
}) {
  return (
    <section className="flex h-full min-h-0 flex-col">
      <h1 className="sr-only">{label}</h1>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div
          className={cn(
            "mx-auto w-full max-w-6xl px-5 pt-8 pb-16 md:px-10 md:pt-12",
            className
          )}
        >
          {children}
        </div>
      </div>
      {footer}
    </section>
  )
}

/** 舞台上的主句：一句话说清楚这一页现在的状态 */
export function Lead({
  children,
  sub,
  className,
}: {
  children: React.ReactNode
  sub?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("max-w-3xl", className)}>
      <h2 className="text-[1.75rem] leading-tight font-semibold tracking-tight text-balance md:text-[2.125rem]">
        {children}
      </h2>
      {sub ? (
        <p className="mt-3 text-[15px] leading-relaxed text-muted-foreground">
          {sub}
        </p>
      ) : null}
    </div>
  )
}

/* —— 状态标签：图标 + 文字，不只依赖颜色 —— */

export type Tone = "neutral" | "running" | "success" | "warning" | "danger"

const TONE_STYLE: Record<Tone, string> = {
  neutral: "text-muted-foreground",
  running: "text-primary",
  success: "text-success-foreground",
  warning: "text-warning-foreground",
  danger: "text-destructive",
}

const TONE_ICON: Record<Tone, LucideIcon> = {
  neutral: CircleDashed,
  running: Loader2,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: OctagonX,
}

export function StatusTag({
  tone,
  children,
  icon,
  className,
}: {
  tone: Tone
  children: React.ReactNode
  icon?: LucideIcon
  className?: string
}) {
  const Icon = icon ?? TONE_ICON[tone]
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs font-medium whitespace-nowrap",
        TONE_STYLE[tone],
        className
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "size-3.5 shrink-0",
          tone === "running" && "animate-spin motion-reduce:animate-none"
        )}
      />
      {children}
    </span>
  )
}

/** 路径：等宽、可截断，完整内容放在 title 中 */
export function PathText({
  children,
  className,
}: {
  children: string
  className?: string
}) {
  return (
    <span
      title={children}
      className={cn(
        "block truncate font-mono text-xs text-muted-foreground",
        className
      )}
    >
      {children}
    </span>
  )
}

export const NUMBER = new Intl.NumberFormat("zh-CN")
