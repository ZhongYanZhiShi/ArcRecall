"use client"

import * as React from "react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { listGroups } from "@/lib/workflows"

export function DictionaryGroupSelect({
  value,
  onChange,
  disabled,
  revision = 0,
}: {
  value: string | null
  onChange: (value: string | null) => void
  disabled?: boolean
  revision?: number
}) {
  const [groups, setGroups] = React.useState<string[]>([])
  const [error, setError] = React.useState(false)
  React.useEffect(() => {
    let disposed = false
    void listGroups()
      .then((items) => {
        if (!disposed) {
          setGroups(items)
          setError(false)
        }
      })
      .catch(() => {
        if (!disposed) setError(true)
      })
    return () => {
      disposed = true
    }
  }, [revision])
  const items = [
    { value: "", label: "全部字典" },
    ...groups.map((name) => ({ value: name, label: name })),
  ]
  if (value && !groups.includes(value))
    items.push({ value, label: `${value}（需确认分组是否存在）` })
  return (
    <div className="space-y-1">
      <Select
        value={value ?? ""}
        items={items}
        disabled={disabled}
        onValueChange={(next) => onChange(next || null)}
      >
        <SelectTrigger aria-label="字典分组" className="w-full min-w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          分组读取失败，重新打开页面可重试。
        </p>
      )}
    </div>
  )
}
