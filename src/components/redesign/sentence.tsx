"use client"

import * as React from "react"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"

/**
 * 句子里的可改词：选项不放进表单面板，而是嵌在一句完整的话里，
 * 读一遍就知道这次会怎么处理。点开是普通的 Select，键盘与读屏照常可用。
 */
export function Token<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
  disabled = false,
}: {
  /** 读屏名称，例如“输出位置” */
  label: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
  className?: string
  disabled?: boolean
}) {
  return (
    <Select
      disabled={disabled}
      items={options as { value: T; label: string }[]}
      value={value}
      onValueChange={(next) => {
        if (next) onChange(next as T)
      }}
    >
      <SelectTrigger
        aria-label={label}
        className={cn(
          "inline-flex h-auto w-auto gap-0.5 rounded-none border-0 border-b-2 border-dashed border-primary/45 bg-transparent px-0.5 py-0 align-baseline text-[length:inherit] font-semibold text-foreground",
          "hover:border-primary hover:bg-primary/6 focus-visible:border-primary focus-visible:bg-primary/8 focus-visible:ring-0",
          "[&>svg]:size-[0.7em] [&>svg]:opacity-60",
          className
        )}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent
        alignItemWithTrigger={false}
        align="start"
        className="min-w-48"
      >
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** 句子里的开关词：点击在两种说法之间切换，例如“清理 / 保留” */
export function ToggleWord({
  label,
  on,
  onChange,
  onText,
  offText,
  disabled = false,
}: {
  label: string
  on: boolean
  onChange: (on: boolean) => void
  onText: string
  offText: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cn(
        "inline border-b-2 border-dashed px-0.5 font-semibold outline-none disabled:cursor-not-allowed disabled:opacity-50",
        "hover:bg-primary/6 focus-visible:bg-primary/8",
        on
          ? "border-primary/45 text-foreground hover:border-primary"
          : "border-foreground/25 text-muted-foreground hover:border-foreground/50"
      )}
    >
      {on ? onText : offText}
    </button>
  )
}
