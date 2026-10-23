"use client"

import * as React from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { assignGroup, deleteGroup, removeGroupMembers } from "@/lib/workflows"
import { DictionaryGroupSelect } from "./dictionary-group-select"

export function DictionaryGroups({
  value,
  onChange,
  ids,
  disabled,
}: {
  value: string | null
  onChange: (group: string | null) => void
  ids: number[]
  disabled: boolean
}) {
  const [open, setOpen] = React.useState(false)
  const [name, setName] = React.useState("")
  const [target, setTarget] = React.useState<string | null>(null)
  const [revision, setRevision] = React.useState(0)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const working = React.useRef(false)
  async function apply(operation: () => Promise<void>, group: string | null) {
    if (working.current) return
    working.current = true
    setBusy(true)
    setError(null)
    try {
      await operation()
      setRevision((v) => v + 1)
      onChange(group)
      setName("")
      setConfirmDelete(false)
      setOpen(false)
    } catch (reason) {
      setError(String(reason))
    } finally {
      working.current = false
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <DictionaryGroupSelect
        value={value}
        onChange={onChange}
        disabled={disabled || busy}
        revision={revision}
      />
      <Button
        variant="outline"
        size="sm"
        disabled={disabled || busy}
        onClick={() => {
          setOpen(true)
          setConfirmDelete(false)
        }}
      >
        管理分组
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>字典分组</SheetTitle>
            <SheetDescription>
              同一候选可属于多个分组。选中分组后添加或导入的候选会自动归组；也可勾选已有候选进行归组。移出或删除分组保留候选。
            </SheetDescription>
          </SheetHeader>
          <div className="space-y-3 px-4">
            <p className="text-sm">已选 {ids.length} 条候选</p>
            <Input
              aria-label="新分组名称"
              maxLength={80}
              placeholder="新分组名称"
              value={name}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
            />
            <Button
              disabled={busy || !name.trim()}
              onClick={() =>
                void apply(() => assignGroup(name.trim(), ids), name.trim())
              }
            >
              {ids.length ? "创建分组并加入所选候选" : "创建空分组"}
            </Button>
            {value && (
              <div className="space-y-2">
                <p className="text-sm break-all">当前分组：{value}</p>
                <Button
                  variant="outline"
                  disabled={busy || ids.length === 0}
                  onClick={() =>
                    void apply(() => removeGroupMembers(value, ids), value)
                  }
                >
                  所选候选移出当前分组
                </Button>
                <Button
                  variant="outline"
                  disabled={busy || ids.length === 0}
                  onClick={() =>
                    void apply(() => assignGroup(value, ids), value)
                  }
                >
                  所选候选加入当前分组
                </Button>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => setConfirmDelete(true)}
                >
                  删除当前分组
                </Button>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              要加入已有分组，可在下方选择目标；不会改变主列表的勾选。
            </p>
            <DictionaryGroupSelect
              value={target}
              onChange={setTarget}
              disabled={busy}
              revision={revision}
            />
            <Button
              variant="outline"
              disabled={busy || !target || ids.length === 0}
              onClick={() => {
                if (target) void apply(() => assignGroup(target, ids), target)
              }}
            >
              加入所选目标分组
            </Button>
            {confirmDelete && value && (
              <div className="space-y-2">
                <p className="text-sm">
                  删除后，该分组的任务需重新选择字典。候选密码保留。
                </p>
                <Button
                  variant="destructive"
                  disabled={busy}
                  onClick={() => void apply(() => deleteGroup(value), null)}
                >
                  确认删除分组
                </Button>
              </div>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  )
}
