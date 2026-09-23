"use client"

import { CircleAlert, RefreshCw } from "lucide-react"
import * as React from "react"
import { AppUpdatePanel } from "@/components/home/app-update-panel"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
} from "@/components/ui/field"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  type AppLogLevel,
  type AppSettings,
  DEFAULT_LOG_MAX_DISK_MIB,
  MAX_LOG_MAX_DISK_MIB,
  MIN_LOG_MAX_DISK_MIB,
  getSettings,
  updateSettings,
} from "@/lib/settings"

const LOG_LEVELS: {
  value: AppLogLevel
  label: string
  description: string
}[] = [
  { value: "error", label: "错误", description: "仅保留失败事件" },
  { value: "warn", label: "警告", description: "错误与风险提示" },
  { value: "info", label: "信息", description: "推荐的日常运行记录" },
  { value: "debug", label: "调试", description: "包含更细的界面诊断" },
]

const LOG_CAPACITY_PRESETS = [25, 100, 250, 500] as const

export function AppSettingsPanel() {
  const [appSettings, setAppSettings] = React.useState<AppSettings | null>(null)
  const [logMaxDiskInput, setLogMaxDiskInput] = React.useState(
    String(DEFAULT_LOG_MAX_DISK_MIB)
  )
  const [busy, setBusy] = React.useState(false)
  const [message, setMessage] = React.useState<string | null>(null)
  const [messageError, setMessageError] = React.useState(false)
  const [loadBusy, setLoadBusy] = React.useState(false)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const request = React.useRef(0)

  const load = React.useCallback(async () => {
    const requestId = ++request.current
    setLoadBusy(true)
    setLoadError(null)
    try {
      const settings = await getSettings()
      if (requestId !== request.current) return
      setAppSettings(settings)
      setLogMaxDiskInput(
        String(settings.logging?.maxDiskMib ?? DEFAULT_LOG_MAX_DISK_MIB)
      )
    } catch (error) {
      if (requestId === request.current) {
        setLoadError(`读取应用设置失败：${errorMessage(error)}`)
      }
    } finally {
      if (requestId === request.current) setLoadBusy(false)
    }
  }, [])

  React.useEffect(() => {
    const timeout = setTimeout(() => void load(), 0)
    return () => {
      clearTimeout(timeout)
      request.current += 1
    }
  }, [load])

  const handleLogLevelChange = (level: AppLogLevel) => {
    if (busy || appSettings === null || appSettings.logging?.level === level) {
      return
    }
    const previous = appSettings
    const next: AppSettings = {
      ...appSettings,
      logging: {
        level,
        maxDiskMib: appSettings.logging?.maxDiskMib ?? DEFAULT_LOG_MAX_DISK_MIB,
      },
    }
    setAppSettings(next)
    setBusy(true)
    setMessageError(false)
    setMessage("正在保存日志级别…")
    void updateSettings({ kind: "logLevel", value: level })
      .then((saved) => {
        setAppSettings(saved)
        setMessage(`日志级别已切换为“${logLevelLabel(level)}”。`)
      })
      .catch((error) => {
        setAppSettings(previous)
        setMessageError(true)
        setMessage(`保存失败：${errorMessage(error)}`)
      })
      .finally(() => setBusy(false))
  }

  const handleSaveLogCapacity = () => {
    if (busy || appSettings === null) {
      return
    }
    const maxDiskMib = Number(logMaxDiskInput)
    if (
      !Number.isInteger(maxDiskMib) ||
      maxDiskMib < MIN_LOG_MAX_DISK_MIB ||
      maxDiskMib > MAX_LOG_MAX_DISK_MIB
    ) {
      setMessageError(true)
      setMessage(
        `请输入 ${MIN_LOG_MAX_DISK_MIB}–${MAX_LOG_MAX_DISK_MIB} 之间的整数。`
      )
      return
    }
    if (
      (appSettings.logging?.maxDiskMib ?? DEFAULT_LOG_MAX_DISK_MIB) ===
      maxDiskMib
    ) {
      setMessageError(false)
      setMessage(`日志最大占用已是 ${maxDiskMib} MiB。`)
      return
    }

    setBusy(true)
    setMessageError(false)
    setMessage("正在保存日志容量…")
    void updateSettings({ kind: "logMaxDiskMib", value: maxDiskMib })
      .then((saved) => {
        const savedMaxDiskMib =
          saved.logging?.maxDiskMib ?? DEFAULT_LOG_MAX_DISK_MIB
        setAppSettings(saved)
        setLogMaxDiskInput(String(savedMaxDiskMib))
        setMessage(`日志最大占用已调整为 ${savedMaxDiskMib} MiB。`)
      })
      .catch((error) => {
        setMessageError(true)
        setMessage(`保存失败：${errorMessage(error)}`)
      })
      .finally(() => setBusy(false))
  }

  const parsedLogMaxDisk = Number(logMaxDiskInput)
  const logCapacityInvalid =
    appSettings !== null &&
    (!Number.isInteger(parsedLogMaxDisk) ||
      parsedLogMaxDisk < MIN_LOG_MAX_DISK_MIB ||
      parsedLogMaxDisk > MAX_LOG_MAX_DISK_MIB)
  const logCapacityDirty =
    appSettings !== null &&
    String(appSettings.logging?.maxDiskMib ?? DEFAULT_LOG_MAX_DISK_MIB) !==
      logMaxDiskInput

  return (
    <div className="flex flex-col gap-2">
      <AppUpdatePanel />
      {loadError ? (
        <Alert variant="warning">
          <CircleAlert />
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>{loadError}</span>
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={loadBusy}
              onClick={() => void load()}
            >
              <RefreshCw data-icon="inline-start" />
              {loadBusy ? "正在重试" : "重试"}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      <Card size="sm">
        <CardHeader className="border-b border-border/80">
          <div className="flex items-center gap-2">
            <CardTitle>应用日志</CardTitle>
            <Badge variant="outline">
              {appSettings?.logging?.maxDiskMib ?? DEFAULT_LOG_MAX_DISK_MIB} MiB
              上限
            </Badge>
          </div>
          <CardDescription>
            密码、候选内容和用户路径会在写入前隐藏。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <FieldSet disabled={busy || appSettings === null}>
            <FieldLegend className="sr-only">日志级别</FieldLegend>
            <ToggleGroup
              value={[appSettings?.logging?.level ?? "info"]}
              onValueChange={(value) => {
                const level = value[0] as AppLogLevel | undefined
                if (level) {
                  handleLogLevelChange(level)
                }
              }}
              variant="outline"
              className="grid w-full grid-cols-2 gap-2 sm:grid-cols-4"
            >
              {LOG_LEVELS.map((item) => (
                <ToggleGroupItem
                  key={item.value}
                  value={item.value}
                  className="h-auto min-h-14 flex-col items-start gap-0.5 text-left"
                >
                  <span className="block text-xs font-medium">
                    {item.label}
                  </span>
                  <span className="block text-xs leading-tight text-muted-foreground">
                    {item.description}
                  </span>
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </FieldSet>
          <FieldSeparator />
          <FieldSet className="gap-3" disabled={busy || appSettings === null}>
            <FieldLegend className="sr-only">日志容量</FieldLegend>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <FieldContent className="w-full sm:max-w-64">
                <div className="flex items-center gap-2">
                  <FieldLabel htmlFor="log-max-disk-mib">
                    最大磁盘占用
                  </FieldLabel>
                  {logCapacityDirty ? (
                    <Badge variant="warning">未保存</Badge>
                  ) : null}
                </div>
                <InputGroup>
                  <InputGroupInput
                    id="log-max-disk-mib"
                    type="number"
                    inputMode="numeric"
                    min={MIN_LOG_MAX_DISK_MIB}
                    max={MAX_LOG_MAX_DISK_MIB}
                    step={5}
                    value={logMaxDiskInput}
                    onChange={(event) => {
                      setLogMaxDiskInput(event.target.value)
                      setMessage(null)
                    }}
                    aria-describedby="log-max-disk-hint"
                    aria-invalid={logCapacityInvalid}
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupText>MiB</InputGroupText>
                  </InputGroupAddon>
                </InputGroup>
                {logCapacityInvalid ? (
                  <FieldError>
                    请输入 {MIN_LOG_MAX_DISK_MIB}–{MAX_LOG_MAX_DISK_MIB}{" "}
                    之间的整数。
                  </FieldError>
                ) : null}
              </FieldContent>
              <Button
                type="button"
                variant="outline"
                disabled={
                  busy ||
                  appSettings === null ||
                  logCapacityInvalid ||
                  !logCapacityDirty
                }
                onClick={handleSaveLogCapacity}
              >
                保存
              </Button>
            </div>
            <ToggleGroup
              value={
                LOG_CAPACITY_PRESETS.some(
                  (capacity) => String(capacity) === logMaxDiskInput
                )
                  ? [logMaxDiskInput]
                  : []
              }
              onValueChange={(value) => {
                if (value[0]) {
                  setLogMaxDiskInput(value[0])
                  setMessage(null)
                }
              }}
              variant="outline"
              size="sm"
              className="flex-wrap"
            >
              {LOG_CAPACITY_PRESETS.map((capacity) => (
                <ToggleGroupItem key={capacity} value={String(capacity)}>
                  {capacity} MiB
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <FieldDescription id="log-max-disk-hint">
              可设置 {MIN_LOG_MAX_DISK_MIB}–{MAX_LOG_MAX_DISK_MIB}{" "}
              MiB；达到上限后自动删除最旧日志。
            </FieldDescription>
          </FieldSet>
          {message ? (
            <Alert
              variant={
                messageError ? "destructive" : busy ? "default" : "success"
              }
            >
              <AlertDescription aria-live="polite">{message}</AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}

function logLevelLabel(level: AppLogLevel) {
  return LOG_LEVELS.find((item) => item.value === level)?.label ?? level
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "未知错误")
}
