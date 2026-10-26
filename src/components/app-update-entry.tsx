"use client"

import { useAppUpdate } from "@/components/update-provider"
import { AppUpdateDetails } from "@/components/app-update-details"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverDescription,
} from "@/components/ui/popover"

export function AppUpdateEntry() {
  const { status, error, desktop, loaded, open, setOpen } = useAppUpdate()
  if (!desktop || !loaded || !status.configured) return null
  const failure = error ?? status.error
  const progress = status.totalBytes
    ? Math.min(
        100,
        Math.floor((status.downloadedBytes / status.totalBytes) * 100)
      )
    : null
  const label =
    status.phase === "installing"
      ? "正在更新…"
      : failure
        ? "更新未完成"
        : status.phase === "ready"
          ? "更新已就绪"
          : status.phase === "available"
            ? "有新版本"
            : status.phase === "downloading"
              ? `下载更新${progress === null ? "…" : ` ${progress}%`}`
              : null
  if (!label && !open) return null
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button variant="ghost" className="h-11 shrink-0" />}
      >
        {label ?? "应用更新"}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="max-h-[min(36rem,var(--available-height))] w-[min(24rem,calc(100vw-2rem))] overflow-y-auto"
      >
        <PopoverHeader>
          <PopoverTitle>
            {status.phase === "ready" ? "新版本已准备好" : "应用更新"}
          </PopoverTitle>
          <PopoverDescription>
            当前 v{status.currentVersion}
            {status.version ? ` → 新版 v${status.version}` : ""}
          </PopoverDescription>
        </PopoverHeader>
        <AppUpdateDetails onClose={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  )
}
