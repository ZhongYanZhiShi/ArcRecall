import * as React from "react"

import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

const ROWS = [0, 1, 2, 3, 4]

type LoadingFrameProps = {
  label: string
  width?: "default" | "wide"
  children: React.ReactNode
}

function LoadingFrame({
  label,
  width = "default",
  children,
}: LoadingFrameProps) {
  return (
    <div
      role="status"
      className={cn(
        "mx-auto flex h-full min-h-0 w-full flex-col overflow-hidden px-5 pt-6 pb-2",
        width === "default" ? "workbench-page" : "max-w-6xl"
      )}
    >
      <span className="sr-only">{label}</span>
      <div aria-hidden className="flex h-full min-h-0 flex-col">
        {children}
      </div>
    </div>
  )
}

function LoadingHeader({ actions = 0 }: { actions?: number }) {
  return (
    <div className="flex shrink-0 items-start justify-between gap-3">
      <div className="space-y-2">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-3 w-72 max-w-[65vw]" />
      </div>
      {actions > 0 ? (
        <div className="flex gap-1.5">
          {Array.from({ length: actions }, (_, index) => (
            <Skeleton key={index} className="h-8 w-16 rounded-lg" />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function LoadingSurface({ className, children }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "workbench-panel rounded-2xl border border-border/80 bg-card",
        className
      )}
    >
      {children}
    </div>
  )
}

function LoadingToolbar({ controls = 1 }: { controls?: number }) {
  return (
    <LoadingSurface className="flex h-14 shrink-0 items-center gap-2 p-2.5">
      <Skeleton className="h-9 min-w-0 flex-1 rounded-lg" />
      {Array.from({ length: controls }, (_, index) => (
        <Skeleton key={index} className="h-9 w-20 rounded-lg" />
      ))}
    </LoadingSurface>
  )
}

function LoadingTable({
  columns = "history",
}: {
  columns?: "dictionary" | "history"
}) {
  return (
    <LoadingSurface className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl">
      <div
        className={cn(
          "grid h-10 shrink-0 items-center gap-5 border-b border-border/70 px-3",
          columns === "dictionary"
            ? "grid-cols-[2rem_minmax(0,1fr)_5rem_4rem]"
            : "grid-cols-[minmax(9rem,1.5fr)_4rem_6rem_7rem_7rem_6rem]"
        )}
      >
        {Array.from(
          { length: columns === "dictionary" ? 4 : 6 },
          (_, index) => (
            <Skeleton key={index} className="h-3 w-full rounded-md" />
          )
        )}
      </div>
      <div className="min-h-0 flex-1 divide-y divide-border/60">
        {ROWS.map((row) => (
          <div
            key={row}
            className={cn(
              "grid h-12 items-center gap-5 px-3",
              columns === "dictionary"
                ? "grid-cols-[2rem_minmax(0,1fr)_5rem_4rem]"
                : "grid-cols-[minmax(9rem,1.5fr)_4rem_6rem_7rem_7rem_6rem]"
            )}
          >
            {Array.from(
              { length: columns === "dictionary" ? 4 : 6 },
              (_, index) => (
                <Skeleton
                  key={index}
                  className={cn(
                    "h-3 rounded-md",
                    index === 0 ? "w-4/5" : "w-full"
                  )}
                />
              )
            )}
          </div>
        ))}
      </div>
      <div className="flex h-10 shrink-0 items-center justify-between border-t border-border/70 px-3">
        <Skeleton className="h-3 w-20 rounded-md" />
        <Skeleton className="h-7 w-28 rounded-lg" />
      </div>
    </LoadingSurface>
  )
}

export function ExtractPageLoading() {
  return (
    <LoadingFrame label="正在载入解压工作区…">
      <LoadingHeader />
      <LoadingSurface className="mt-5 flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8">
        <Skeleton className="size-12 rounded-xl" />
        <Skeleton className="h-5 w-40 rounded-lg" />
        <Skeleton className="h-3 w-96 max-w-[72vw] rounded-md" />
        <Skeleton className="h-9 w-28 rounded-lg" />
        <Skeleton className="mt-2 h-3 w-64 max-w-[58vw] rounded-md" />
      </LoadingSurface>
      <LoadingSurface className="mt-3 flex h-16 shrink-0 items-center gap-2 px-3">
        <Skeleton className="h-6 w-20 rounded-full" />
        <Skeleton className="h-6 w-20 rounded-full" />
        <Skeleton className="h-6 w-20 rounded-full" />
        <Skeleton className="h-6 w-24 rounded-full" />
        <Skeleton className="ml-auto h-4 w-12 rounded-md" />
      </LoadingSurface>
    </LoadingFrame>
  )
}

export function CompressPageLoading() {
  return (
    <LoadingFrame label="正在载入压缩工作区…" width="wide">
      <LoadingHeader />
      <div className="mt-4 grid min-h-0 flex-1 grid-rows-2 gap-3 lg:grid-cols-[minmax(18rem,0.85fr)_minmax(0,1.4fr)] lg:grid-rows-1">
        <LoadingSurface className="flex min-h-0 flex-col overflow-hidden">
          <div className="flex h-20 shrink-0 items-center justify-between border-b border-border/70 px-4">
            <div className="space-y-2">
              <Skeleton className="h-4 w-24 rounded-md" />
              <Skeleton className="h-3 w-48 rounded-md" />
            </div>
            <div className="flex gap-2">
              <Skeleton className="h-8 w-20 rounded-lg" />
              <Skeleton className="h-8 w-20 rounded-lg" />
            </div>
          </div>
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-5">
            <Skeleton className="size-11 rounded-xl" />
            <Skeleton className="h-4 w-36 rounded-md" />
            <Skeleton className="h-3 w-52 rounded-md" />
          </div>
        </LoadingSurface>
        <LoadingSurface className="flex min-h-0 flex-col overflow-hidden">
          <div className="flex h-16 shrink-0 items-center justify-between border-b border-border/70 px-4">
            <div className="space-y-2">
              <Skeleton className="h-4 w-24 rounded-md" />
              <Skeleton className="h-3 w-40 rounded-md" />
            </div>
            <Skeleton className="h-6 w-20 rounded-full" />
          </div>
          <div className="grid min-h-0 flex-1 content-start gap-3 p-4 md:grid-cols-2">
            <Skeleton className="h-20 w-full rounded-xl md:col-span-2" />
            <Skeleton className="h-16 w-full rounded-xl" />
            <Skeleton className="h-16 w-full rounded-xl" />
            <Skeleton className="h-24 w-full rounded-xl md:col-span-2" />
          </div>
          <div className="flex h-14 shrink-0 items-center justify-between border-t border-border/70 px-4">
            <Skeleton className="h-4 w-36 rounded-md" />
            <Skeleton className="h-9 w-28 rounded-lg" />
          </div>
        </LoadingSurface>
      </div>
    </LoadingFrame>
  )
}

export function DictionaryPageLoading() {
  return (
    <LoadingFrame label="正在载入字典工作区…">
      <LoadingHeader actions={3} />
      <div className="mt-2 flex min-h-0 flex-1 flex-col gap-2">
        <LoadingToolbar />
        <LoadingTable columns="dictionary" />
      </div>
    </LoadingFrame>
  )
}

export function HistoryPageLoading() {
  return (
    <LoadingFrame label="正在载入历史记录…">
      <LoadingHeader actions={2} />
      <div className="mt-2 flex min-h-0 flex-1 flex-col gap-2">
        <LoadingSurface className="grid h-20 shrink-0 grid-cols-3 gap-px overflow-hidden bg-border p-0">
          {[0, 1, 2].map((item) => (
            <div key={item} className="flex items-center gap-3 bg-card px-4">
              <Skeleton className="size-9 rounded-xl" />
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-4 w-12 rounded-md" />
                <Skeleton className="h-3 w-full rounded-md" />
              </div>
            </div>
          ))}
        </LoadingSurface>
        <LoadingToolbar />
        <LoadingTable />
      </div>
    </LoadingFrame>
  )
}

export function LogsPageLoading() {
  return (
    <LoadingFrame label="正在载入日志工作区…">
      <LoadingHeader actions={1} />
      <div className="mt-2 flex min-h-0 flex-1 flex-col gap-2">
        <LoadingSurface className="grid h-20 shrink-0 grid-cols-2 gap-px overflow-hidden bg-border p-0 sm:grid-cols-4">
          {[0, 1, 2, 3].map((item) => (
            <div key={item} className="flex items-center gap-3 bg-card px-3">
              <Skeleton className="size-8 rounded-xl" />
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-4 w-10 rounded-md" />
                <Skeleton className="h-3 w-full rounded-md" />
              </div>
            </div>
          ))}
        </LoadingSurface>
        <LoadingToolbar controls={3} />
        <LoadingSurface className="min-h-0 flex-1 overflow-hidden">
          <div className="h-10 border-b border-border/70 px-3 py-3">
            <Skeleton className="h-3 w-64 rounded-md" />
          </div>
          <div className="space-y-3 p-3">
            {ROWS.slice(0, 4).map((row) => (
              <div key={row} className="flex items-start gap-3">
                <Skeleton className="h-6 w-20 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3 w-4/5 rounded-md" />
                  <Skeleton className="h-3 w-2/5 rounded-md" />
                </div>
              </div>
            ))}
          </div>
        </LoadingSurface>
      </div>
    </LoadingFrame>
  )
}

export function SettingsPageLoading() {
  return (
    <LoadingFrame label="正在载入设置工作区…">
      <LoadingHeader />
      <div className="mt-2 flex min-h-0 flex-1 flex-col gap-2">
        <div className="flex h-9 shrink-0 gap-1 rounded-xl bg-muted/50 p-1">
          {[0, 1, 2, 3].map((item) => (
            <Skeleton key={item} className="h-7 w-24 rounded-lg" />
          ))}
        </div>
        <LoadingSurface className="min-h-0 flex-1 overflow-hidden p-4">
          <div className="flex items-start justify-between gap-4 border-b border-border/70 pb-4">
            <div className="space-y-2">
              <Skeleton className="h-4 w-32 rounded-md" />
              <Skeleton className="h-3 w-72 rounded-md" />
            </div>
            <Skeleton className="h-8 w-24 rounded-lg" />
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Skeleton className="h-24 w-full rounded-xl" />
            <Skeleton className="h-24 w-full rounded-xl" />
            <Skeleton className="h-32 w-full rounded-xl sm:col-span-2" />
            <Skeleton className="h-20 w-full rounded-xl sm:col-span-2" />
          </div>
        </LoadingSurface>
      </div>
    </LoadingFrame>
  )
}
