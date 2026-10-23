"use client"
import * as React from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
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
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import {
  listPresets,
  savePreset,
  deletePreset,
  applyPreset,
  type ProcessingOptions,
  type ProcessingPreset,
} from "@/lib/planning"

export function ProcessingPresets({
  value,
  disabled,
  onApply,
}: {
  value: ProcessingOptions
  disabled: boolean
  onApply: (value: ProcessingOptions) => void
}) {
  const [open, setOpen] = React.useState(false)
  const [rows, setRows] = React.useState<ProcessingPreset[]>([])
  const [selected, setSelected] = React.useState<string | null>(null)
  const [name, setName] = React.useState("")
  const [overwrite, setOverwrite] = React.useState(false)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const operation = React.useRef(false)
  async function perform(work: () => Promise<void>) {
    if (operation.current) return
    operation.current = true
    setBusy(true)
    setError(null)
    try {
      await work()
    } catch (e) {
      setError(String(e))
    } finally {
      operation.current = false
      setBusy(false)
    }
  }
  const chosen = rows.find((p) => p.name === selected)
  const exists = rows.some((p) => p.name === name.trim())
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={() => {
          setOpen(true)
          setConfirmDelete(false)
          setOverwrite(false)
          void perform(async () => setRows(await listPresets()))
        }}
      >
        处理预设
      </Button>
      <Sheet
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next)
        }}
      >
        <SheetContent className="overflow-y-auto">
          <SheetHeader>
            <SheetTitle>处理预设</SheetTitle>
            <SheetDescription>
              保存常用处理选项，不保存密码。应用后影响当前选项和后续导入，不改写已加入队列的专用选项。
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
              items={rows.map((p) => ({ value: p.name, label: p.name }))}
              disabled={busy || disabled || !rows.length}
              onValueChange={(v) => {
                setSelected(v)
                setConfirmDelete(false)
              }}
            >
              <SelectTrigger aria-label="已保存预设" className="w-full">
                <SelectValue placeholder="选择预设" />
              </SelectTrigger>
              <SelectContent>
                {rows.map((p) => (
                  <SelectItem key={p.name} value={p.name}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!rows.length && !busy && (
              <p className="text-sm text-muted-foreground">
                暂无预设，可保存下方当前选项。
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
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={busy || disabled || !selected}
                onClick={() =>
                  void perform(async () => {
                    const preset = await applyPreset(selected!)
                    onApply(preset)
                    setOpen(false)
                    toast.success(`已应用预设「${preset.name}」`)
                  })
                }
              >
                应用预设
              </Button>
              <Button
                variant="outline"
                disabled={busy || disabled || !selected}
                onClick={() => setConfirmDelete(true)}
              >
                删除所选预设
              </Button>
            </div>
            {confirmDelete && (
              <Button
                variant="destructive"
                disabled={busy || disabled}
                onClick={() =>
                  void perform(async () => {
                    await deletePreset(selected!)
                    setRows(await listPresets())
                    setSelected(null)
                    setConfirmDelete(false)
                  })
                }
              >
                确认删除预设
              </Button>
            )}
            <div className="space-y-3 border-t pt-4">
              <p className="text-sm font-medium">保存当前解压选项</p>
              <p className="text-xs break-all text-muted-foreground">
                {value.dictionaryGroup ?? "全部字典"} ·{" "}
                {value.recursive ? "递归解压" : "仅当前归档"} ·{" "}
                {value.computeMode === "cpuOnly" ? "仅 CPU" : "GPU 优先"} ·{" "}
                {value.openWhenDone ? "完成后打开" : "完成后不打开"}
                <br />
                输出：{value.outputDirectory ?? "归档同级"}
              </p>
              <Input
                aria-label="预设名称"
                maxLength={80}
                value={name}
                disabled={busy || disabled}
                placeholder="例如：资料批量整理"
                onChange={(e) => {
                  setName(e.target.value)
                  setOverwrite(false)
                }}
              />
              {exists && (
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={overwrite}
                    disabled={busy || disabled}
                    onCheckedChange={setOverwrite}
                  />
                  确认覆盖同名预设
                </label>
              )}
              <Button
                disabled={
                  busy || disabled || !name.trim() || (exists && !overwrite)
                }
                onClick={() =>
                  void perform(async () => {
                    await savePreset({ name: name.trim(), ...value }, overwrite)
                    setRows(await listPresets())
                    setSelected(name.trim())
                    setOverwrite(false)
                    toast.success("预设已保存")
                  })
                }
              >
                保存当前选项
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
