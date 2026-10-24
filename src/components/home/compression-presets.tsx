"use client"
import * as React from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  listCompressionPresets,
  saveCompressionPreset,
  deleteCompressionPreset,
  applyCompressionPreset,
  type CompressionPreset,
} from "@/lib/compression-presets"
import type { CompressionDraft } from "@/lib/compression-draft"

export function CompressionPresets({
  draft,
  disabled,
  onApply,
}: {
  draft: CompressionDraft
  disabled: boolean
  onApply: (preset: CompressionPreset) => void
}) {
  const [open, setOpen] = React.useState(false)
  const [rows, setRows] = React.useState<CompressionPreset[]>([])
  const [selected, setSelected] = React.useState<string | null>(null)
  const [name, setName] = React.useState("")
  const [template, setTemplate] = React.useState("{name}")
  const [overwrite, setOverwrite] = React.useState(false)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const operation = React.useRef(false)
  const disabledRef = React.useRef(disabled)
  React.useLayoutEffect(() => {
    disabledRef.current = disabled
  }, [disabled])
  async function perform(work: () => Promise<void>) {
    if (operation.current || disabledRef.current) return
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
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => {
          setOpen(true)
          setOverwrite(false)
          setConfirmDelete(false)
          void perform(async () => setRows(await listCompressionPresets()))
        }}
      >
        压缩预设
      </Button>
      <Sheet
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next)
        }}
      >
        <SheetContent className="overflow-y-auto">
          <SheetHeader>
            <SheetTitle>压缩预设</SheetTitle>
            <SheetDescription>
              保存压缩参数和命名规则，不保存源文件、密码或 AI
              配置。应用后可继续调整，再手动开始压缩。
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
              <SelectTrigger aria-label="已保存压缩预设" className="w-full">
                <SelectValue placeholder="选择压缩预设" />
              </SelectTrigger>
              <SelectContent>
                {rows.map((p) => (
                  <SelectItem key={p.name} value={p.name}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {chosen && (
              <p className="text-sm break-all">
                {chosen.options.format === "sevenZip" ? "7z" : "ZIP"} · 级别{" "}
                {chosen.options.level} ·{" "}
                {chosen.options.encryptFileNames
                  ? "加密文件名"
                  : "不加密文件名"}
                <br />
                输出：{chosen.options.outputDirectory ?? "来源同级"}
                <br />
                命名：{chosen.nameTemplate}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={busy || disabled || !selected}
                onClick={() =>
                  void perform(async () => {
                    const preset = await applyCompressionPreset(selected!)
                    if (disabledRef.current)
                      throw new Error("当前任务正在运行，请稍后应用预设。")
                    onApply(preset)
                    setOpen(false)
                  })
                }
              >
                应用压缩预设
              </Button>
              <Button
                variant="outline"
                disabled={busy || disabled || !selected}
                onClick={() => setConfirmDelete(true)}
              >
                删除压缩预设
              </Button>
            </div>
            {confirmDelete && (
              <Button
                variant="destructive"
                disabled={busy || disabled}
                onClick={() =>
                  void perform(async () => {
                    await deleteCompressionPreset(selected!)
                    setRows(await listCompressionPresets())
                    setSelected(null)
                    setConfirmDelete(false)
                  })
                }
              >
                确认删除压缩预设
              </Button>
            )}
            <div className="space-y-3 border-t pt-4">
              <p className="text-sm font-medium">保存当前压缩选项</p>
              <Input
                aria-label="压缩预设名称"
                value={name}
                maxLength={80}
                disabled={busy || disabled}
                placeholder="例如：资料归档"
                onChange={(e) => {
                  setName(e.target.value)
                  setOverwrite(false)
                }}
              />
              <Input
                aria-label="压缩命名规则"
                value={template}
                maxLength={120}
                disabled={busy || disabled}
                onChange={(e) => setTemplate(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {
                  "{name} 使用当前归档名称，未填写时使用首个来源名称；{date} 为本地日期。不填写扩展名。"
                }
              </p>
              {exists && (
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={overwrite}
                    disabled={busy || disabled}
                    onCheckedChange={setOverwrite}
                  />
                  确认覆盖同名压缩预设
                </label>
              )}
              <Button
                disabled={
                  busy || disabled || !name.trim() || (exists && !overwrite)
                }
                onClick={() =>
                  void perform(async () => {
                    if (draft.outputMode === "custom" && !draft.outputDirectory)
                      throw new Error("请先选择自定义输出目录。")
                    await saveCompressionPreset(
                      {
                        name: name.trim(),
                        nameTemplate: template,
                        openWhenDone: draft.openWhenDone,
                        options: {
                          format: draft.format,
                          level: draft.level,
                          encryptFileNames: draft.encryptFileNames,
                          outputDirectory:
                            draft.outputMode === "custom"
                              ? draft.outputDirectory
                              : null,
                        },
                      },
                      overwrite
                    )
                    setRows(await listCompressionPresets())
                    setSelected(name.trim())
                    setOverwrite(false)
                  })
                }
              >
                保存压缩预设
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
