"use client"

import * as React from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { applyPreset, listPresets, type ProcessingPreset } from "@/lib/planning"
import {
  recoveryQueue,
  recoveryQueueJournal,
} from "@/lib/recovery-queue-session"

export function QueuePresetApply({
  ids,
  disabled,
  onBusyChange,
}: {
  ids: readonly number[]
  disabled: boolean
  onBusyChange: (busy: boolean) => void
}) {
  const [open, setOpen] = React.useState(false)
  const [rows, setRows] = React.useState<ProcessingPreset[]>([])
  const [selected, setSelected] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const operation = React.useRef(false)
  const chosen = rows.find((row) => row.name === selected)
  async function perform(work: () => Promise<void>) {
    if (operation.current) return
    operation.current = true
    setBusy(true)
    onBusyChange(true)
    setError(null)
    try {
      await work()
    } catch (reason) {
      setError(String(reason))
    } finally {
      operation.current = false
      setBusy(false)
      onBusyChange(false)
    }
  }
  return (
    <>
      <Button
        size="xs"
        variant="outline"
        disabled={disabled || busy || ids.length === 0}
        onClick={() => {
          setOpen(true)
          void perform(async () => setRows(await listPresets()))
        }}
      >
        为所选等待项应用预设
      </Button>
      <Sheet open={open} onOpenChange={(next) => !busy && setOpen(next)}>
        <SheetContent className="overflow-y-auto">
          <SheetHeader>
            <SheetTitle>为等待项应用预设</SheetTitle>
            <SheetDescription>
              更新所选 {ids.length} 个等待项的处理选项，保留本次会话的密码。
              输出位置按预设重新计算，并为每个归档创建独立目录。
            </SheetDescription>
          </SheetHeader>
          <div className="space-y-4 px-4 pb-4">
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Select
              value={selected}
              items={rows.map((row) => ({ value: row.name, label: row.name }))}
              onValueChange={setSelected}
              disabled={busy || disabled || !rows.length}
            >
              <SelectTrigger aria-label="队列处理预设" className="w-full">
                <SelectValue placeholder="选择预设" />
              </SelectTrigger>
              <SelectContent>
                {rows.map((row) => (
                  <SelectItem key={row.name} value={row.name}>
                    {row.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!busy && !rows.length && (
              <p className="text-sm text-muted-foreground">
                暂无预设，请先在「处理预设」中保存常用选项。
              </p>
            )}
            {chosen && (
              <p className="text-sm break-all">
                {chosen.dictionaryGroup ?? "全部字典"} ·{" "}
                {chosen.recursive ? "递归解压" : "仅当前归档"} ·{" "}
                {chosen.computeMode === "cpuOnly" ? "仅 CPU" : "GPU 优先"}
                <br />
                输出：{chosen.outputDirectory ?? "归档同级"}
              </p>
            )}
            <Button
              disabled={busy || disabled || !chosen || !ids.length}
              onClick={() =>
                void perform(async () => {
                  const preset = await applyPreset(selected!)
                  const count = recoveryQueue.applyProcessingOptions(ids, {
                    outputDirectory: preset.outputDirectory,
                    recursive: preset.recursive,
                    computeMode: preset.computeMode,
                    dictionaryGroup: preset.dictionaryGroup,
                    openWhenDone: preset.openWhenDone,
                  })
                  await recoveryQueueJournal.flush()
                  setOpen(false)
                  toast.success(
                    `已为 ${count} 个等待项应用预设「${preset.name}」`
                  )
                })
              }
            >
              确认应用到所选等待项
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
