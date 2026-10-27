"use client"

import type { ReactElement } from "react"
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"

export function AppUpdateNotes({
  notes,
  version,
  open,
  onOpenChange,
  children,
}: {
  notes: string | null
  version: string | null
  open?: boolean
  onOpenChange?: (open: boolean) => void
  children?: ReactElement
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {children ? <SheetTrigger render={children} /> : null}
      <SheetContent>
        <SheetHeader className="shrink-0 border-b pr-14">
          <SheetTitle>更新说明</SheetTitle>
          <SheetDescription>
            {version
              ? `版本 v${version} 的完整更新内容。`
              : "本次版本的完整更新内容。"}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 scroll-fade overflow-y-auto p-6">
          <p className="text-sm leading-relaxed [overflow-wrap:anywhere] break-words whitespace-pre-wrap">
            {notes || "此版本未提供更新说明。"}
          </p>
        </div>
      </SheetContent>
    </Sheet>
  )
}
