"use client"

import { useAppUpdate } from "@/components/update-provider"
import { AppUpdateDetails } from "@/components/app-update-details"
import { Card, CardHeader, CardContent, CardTitle } from "@/components/ui/card"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "@/components/ui/field"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"

export function AppUpdatePanel() {
  const { status, desktop, loaded, busy, setAutomatic } = useAppUpdate()
  const disabled = !loaded || !status.configured || busy
  return (
    <Card size="sm" className="drawer-section">
      <CardHeader>
        <CardTitle>
          当前版本 {status.currentVersion ? `v${status.currentVersion}` : "—"}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!desktop ? (
          <p className="text-sm text-muted-foreground">
            更新功能仅在桌面应用中可用。
          </p>
        ) : !loaded ? (
          <p role="status">正在读取更新状态…</p>
        ) : !status.configured ? (
          <p className="text-sm text-muted-foreground">
            此构建未启用更新通道，请使用支持更新的 Windows x64 正式版。
          </p>
        ) : (
          <AppUpdateDetails />
        )}
        <Separator />
        <Field orientation="horizontal" data-disabled={disabled}>
          <FieldContent>
            <FieldLabel htmlFor="auto-update">自动下载更新</FieldLabel>
            <FieldDescription id="auto-update-description">
              启动时检查新版本。开启后后台下载，并每 6
              小时检查；安装前由你确认。
            </FieldDescription>
          </FieldContent>
          <Switch
            id="auto-update"
            aria-describedby="auto-update-description"
            checked={status.autoUpdate}
            disabled={disabled}
            onCheckedChange={(value) => void setAutomatic(value)}
          />
        </Field>
      </CardContent>
    </Card>
  )
}
