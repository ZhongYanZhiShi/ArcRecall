"use client"

import { createContext, useContext, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"

const ActionsTarget = createContext<HTMLElement | null>(null)

export function WorkbenchDetailsActions({ children }: { children: ReactNode }) {
  const target = useContext(ActionsTarget)
  return target
    ? createPortal(
        <div className="flex flex-wrap items-center justify-end gap-2">
          {children}
        </div>,
        target
      )
    : null
}

export function WorkbenchDetails({
  title,
  description,
  children,
  label,
  open,
  onOpenChange,
  bodyClassName,
  footer,
  toolbar,
  pending = false,
}: {
  title: string
  description: string
  children: ReactNode
  label?: string
  open?: boolean
  onOpenChange?: (open: boolean) => void
  bodyClassName?: string
  footer?: ReactNode
  toolbar?: ReactNode
  pending?: boolean
}) {
  const [actionsTarget, setActionsTarget] = useState<HTMLDivElement | null>(
    null
  )
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger
        data-settings-pending={pending || undefined}
        render={
          <Button
            type="button"
            variant="outline"
            className="max-w-full justify-between gap-3"
          />
        }
      >
        <span className="truncate">{label ?? title}</span>
        <ChevronRight aria-hidden className="size-4 shrink-0" />
      </SheetTrigger>
      <SheetContent
        className="workbench-details-panel gap-0 p-0"
        initialFocus={
          pending
            ? () =>
                document.querySelector<HTMLElement>(
                  '[role="dialog"] [data-settings-pending="true"]'
                ) ?? true
            : undefined
        }
      >
        <SheetHeader className="shrink-0 border-b p-4 pr-12">
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        {toolbar ? (
          <div className="shrink-0 border-b p-3">{toolbar}</div>
        ) : null}
        <ActionsTarget.Provider value={actionsTarget}>
          <div
            className={cn(
              "workbench-details-body flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 [&>*]:shrink-0",
              bodyClassName
            )}
          >
            {children}
          </div>
          <div
            ref={setActionsTarget}
            className="flex shrink-0 flex-col border-t bg-background p-4 empty:hidden"
            data-slot="workbench-details-footer"
          >
            {footer}
          </div>
        </ActionsTarget.Provider>
      </SheetContent>
    </Sheet>
  )
}
