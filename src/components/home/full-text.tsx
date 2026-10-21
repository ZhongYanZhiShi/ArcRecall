"use client"

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

/** Keep the full value available when a compact label is ellipsized. */
export function FullText({
  text,
  className,
  focusable = true,
}: {
  text: string
  className?: string
  focusable?: boolean
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span tabIndex={focusable ? 0 : undefined} />}
        className={cn("block max-w-full min-w-0 truncate", className)}
        data-full-text={text}
      >
        {text}
      </TooltipTrigger>
      <TooltipContent className="full-text-tooltip">
        <span className="min-w-0 wrap-anywhere whitespace-pre-wrap">
          {text}
        </span>
      </TooltipContent>
    </Tooltip>
  )
}
