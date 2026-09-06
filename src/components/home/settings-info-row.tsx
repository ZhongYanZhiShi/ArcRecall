import * as React from "react"

import { Badge } from "@/components/ui/badge"

export function SettingsInfoRow({
  icon,
  label,
  value,
  badge,
  action,
}: {
  icon: React.ReactNode
  label: string
  value: string
  badge?: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {icon}
          <span>{label}</span>
          {badge ? <Badge variant="outline">{badge}</Badge> : null}
        </div>
        {action}
      </div>
      <p className="rounded-xl bg-muted/40 px-2.5 py-2 font-mono text-xs break-all text-foreground">
        {value}
      </p>
    </div>
  )
}
