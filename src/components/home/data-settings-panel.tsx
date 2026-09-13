"use client"

import { CircleAlert, Database, HardDrive, RefreshCw } from "lucide-react"
import * as React from "react"

import { SettingsInfoRow } from "@/components/home/settings-info-row"
import { DatabaseRestorePanel } from "@/components/home/database-restore-panel"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { type DatabaseInfo, getDatabaseInfo } from "@/lib/settings"

export function DataSettingsPanel() {
  const [dbInfo, setDbInfo] = React.useState<DatabaseInfo | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const request = React.useRef(0)

  const load = React.useCallback(async () => {
    const requestId = ++request.current
    setBusy(true)
    setError(null)
    try {
      const info = await getDatabaseInfo()
      if (requestId === request.current) {
        setDbInfo(info)
      }
    } catch (loadError) {
      if (requestId === request.current) {
        setError(`读取本地数据信息失败：${errorMessage(loadError)}`)
      }
    } finally {
      if (requestId === request.current) {
        setBusy(false)
      }
    }
  }, [])

  React.useEffect(() => {
    const timeout = setTimeout(() => void load(), 0)
    return () => {
      clearTimeout(timeout)
      request.current += 1
    }
  }, [load])

  return (
    <div className="flex flex-col gap-2">
      {error ? (
        <Alert variant="warning">
          <CircleAlert />
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>{error}</span>
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => void load()}
            >
              <RefreshCw data-icon="inline-start" />
              {busy ? "正在重试" : "重试"}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      <Card size="sm">
        <CardHeader className="border-b border-border/80">
          <div className="flex items-center gap-2">
            <Database className="size-4 text-muted-foreground" />
            <CardTitle>本地数据</CardTitle>
          </div>
          <CardDescription>
            本机 SQLite，不在项目仓库内；缺失时自动创建。字典导入编码自动识别。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <DatabaseRestorePanel onRestored={() => void load()} />
          <Separator />
          <p className="text-sm font-medium">文件位置</p>
          <SettingsInfoRow
            icon={<HardDrive className="size-3.5" />}
            label="数据根目录"
            value={dbInfo?.rootPath ?? "—"}
          />
          <SettingsInfoRow
            icon={<HardDrive className="size-3.5" />}
            label="数据库"
            value={dbInfo?.path ?? "—"}
            badge={
              dbInfo
                ? dbInfo.exists
                  ? `已存在 · ${dbInfo.candidateCount} 条候选`
                  : "将在首次写入时创建"
                : undefined
            }
          />
          <SettingsInfoRow
            icon={<HardDrive className="size-3.5" />}
            label="设置文件"
            value={dbInfo?.settingsPath ?? "—"}
          />
          <SettingsInfoRow
            icon={<HardDrive className="size-3.5" />}
            label="日志目录"
            value={dbInfo?.logsPath ?? "—"}
          />
          <SettingsInfoRow
            icon={<HardDrive className="size-3.5" />}
            label="外部工具目录"
            value={dbInfo?.toolsPath ?? "—"}
          />
        </CardContent>
      </Card>
    </div>
  )
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "未知错误")
}
