"use client"

import { FolderOpen, RotateCcw, X } from "lucide-react"
import type { ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/utils"

export type OutputLocationMode = "sibling" | "custom"

type OutputLocationFieldProps = {
  mode: OutputLocationMode
  onModeChange: (mode: OutputLocationMode) => void
  /** Current path text shown in the value bar (already display-normalized). */
  path: string | null
  /** Full path for tooltip when truncated. */
  pathTitle?: string | null
  siblingLabel?: string
  customLabel?: string
  emptyLabel?: string
  onPick?: () => void
  /** Clear a previously selected custom directory so user can re-set. */
  onClear?: () => void
  /** Optional compact control rendered beside the output-location heading. */
  headerAction?: ReactNode
  disabled?: boolean
  className?: string
}

export function OutputLocationField({
  mode,
  onModeChange,
  path,
  pathTitle,
  siblingLabel = "目标同级",
  customLabel = "自定义",
  emptyLabel = "尚未选择输出目录",
  onPick,
  onClear,
  headerAction,
  disabled = false,
  className,
}: OutputLocationFieldProps) {
  const hasPath = Boolean(path?.trim())
  const title = pathTitle ?? path ?? undefined
  const isCustom = mode === "custom"

  return (
    <div
      data-disabled={disabled || undefined}
      className={cn(
        "min-w-0 rounded-xl border border-border/70 bg-muted/20 p-3",
        disabled && "opacity-60",
        className
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs leading-none font-medium">输出位置</p>
        </div>
        {headerAction || (isCustom && hasPath && onClear) ? (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            {headerAction}
            {isCustom && hasPath && onClear ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={disabled}
                onClick={onClear}
                className="shrink-0 text-muted-foreground"
                title="清除已选目录"
              >
                <X data-icon="inline-start" />
                清除
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      <ToggleGroup
        aria-label="输出位置"
        variant="outline"
        size="sm"
        spacing={0}
        value={[mode]}
        disabled={disabled}
        onValueChange={(values) => {
          const next = values[0] as OutputLocationMode | undefined
          if (next) {
            onModeChange(next)
          }
        }}
        className="mt-2.5 w-full"
      >
        <ToggleGroupItem value="sibling" className="min-w-0 flex-1 text-xs">
          {siblingLabel}
        </ToggleGroupItem>
        <ToggleGroupItem value="custom" className="min-w-0 flex-1 text-xs">
          {customLabel}
        </ToggleGroupItem>
      </ToggleGroup>

      <div
        className={cn(
          "mt-2.5 flex min-h-10 min-w-0 items-center gap-2 rounded-lg border px-2.5 py-1.5",
          isCustom
            ? "border-border/80 bg-background"
            : "border-transparent bg-background/55"
        )}
      >
        <FolderOpen
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground"
          strokeWidth={1.8}
        />
        <p
          className={cn(
            "min-w-0 flex-1 truncate text-xs",
            hasPath ? "text-foreground/90" : "text-muted-foreground"
          )}
          title={title}
        >
          {hasPath ? path : emptyLabel}
        </p>
        {isCustom ? (
          <Button
            type="button"
            variant={hasPath ? "outline" : "secondary"}
            size="xs"
            onClick={onPick}
            disabled={disabled || !onPick}
            className="shrink-0"
          >
            {hasPath ? (
              <>
                <RotateCcw data-icon="inline-start" />
                重选
              </>
            ) : (
              <>
                <FolderOpen data-icon="inline-start" />
                选择
              </>
            )}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
