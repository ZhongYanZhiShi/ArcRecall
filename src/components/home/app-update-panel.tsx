"use client"

import { Download, RefreshCw } from "lucide-react"

import { useAppUpdate } from "@/components/update-provider"
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
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "@/components/ui/field"
import { Progress } from "@/components/ui/progress"
import { Switch } from "@/components/ui/switch"

export function AppUpdatePanel() {
  const {
    status,
    desktop,
    loaded,
    busy,
    error,
    check,
    download,
    install,
    setAutomatic,
  } = useAppUpdate()
  const progress = status.totalBytes
    ? Math.min(100, (status.downloadedBytes / status.totalBytes) * 100)
    : null
  const messages = {
    idle: "点击检查是否有新版本。",
    checking: "正在检查更新…",
    available: `发现新版本 ${status.version ?? ""}。`,
    current: "当前已是最新版本。",
    downloading: `正在下载更新：${(status.downloadedBytes / 1024 / 1024).toFixed(1)} MiB${progress === null ? "" : `（${Math.floor(progress)}%）`}。`,
    ready: `版本 ${status.version ?? ""} 已下载并通过签名校验。`,
    installing: "正在安装更新…",
    error: "更新未完成，请重试。",
  }

  return (
    <Card size="sm">
      <CardHeader className="border-b border-border/80">
        <div className="flex items-center gap-2">
          <CardTitle>应用更新</CardTitle>
          {status.currentVersion ? (
            <Badge variant="outline">v{status.currentVersion}</Badge>
          ) : null}
        </div>
        <CardDescription>
          获取 ArcRecall 正式版更新，保留本机设置、字典和历史记录。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="auto-update">自动更新</FieldLabel>
            <FieldDescription id="auto-update-description">
              每次启动都会检查更新。此选项默认开启；开启时自动下载，并每 6
              小时再次检查。安装更新仍需你确认。
            </FieldDescription>
          </FieldContent>
          <Switch
            id="auto-update"
            aria-describedby="auto-update-description"
            checked={status.autoUpdate}
            disabled={!loaded || !status.configured || busy}
            onCheckedChange={(value) => void setAutomatic(value)}
          />
        </Field>
        <p className="text-sm text-muted-foreground" role="status">
          {!desktop
            ? "更新功能仅在桌面应用中可用。"
            : !status.configured
              ? "此构建未启用更新通道，请使用支持自动更新的 Windows x64 正式版。"
              : messages[status.phase]}
        </p>
        {status.phase === "downloading" ? (
          <Progress aria-label="更新下载进度" value={progress} />
        ) : null}
        {status.lastChecked ? (
          <p className="text-xs text-muted-foreground">
            上次成功检查：{new Date(status.lastChecked).toLocaleString("zh-CN")}
          </p>
        ) : null}
        {error || status.error ? (
          <Alert variant="destructive">
            <AlertDescription>{error ?? status.error}</AlertDescription>
          </Alert>
        ) : null}
        {status.notes ? (
          <details className="text-sm">
            <summary className="cursor-pointer rounded-sm text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring">
              版本 {status.version} 更新说明
            </summary>
            <p className="mt-2 max-h-48 overflow-y-auto break-words whitespace-pre-wrap">
              {status.notes}
            </p>
          </details>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={
              !loaded || !status.configured || busy || status.phase === "ready"
            }
            onClick={() => void check()}
          >
            <RefreshCw data-icon="inline-start" />
            {status.phase === "checking" ? "正在检查" : "检查更新"}
          </Button>
          {status.phase === "available" ? (
            <Button disabled={busy} onClick={() => void download()}>
              <Download data-icon="inline-start" />
              下载更新
            </Button>
          ) : null}
          {status.phase === "ready" ? (
            <Button disabled={busy} onClick={() => void install()}>
              {busy ? "正在安装…" : "安装更新并重启"}
            </Button>
          ) : null}
        </div>
        {status.phase === "ready" ? (
          <p className="text-xs text-muted-foreground">
            请先保存未提交的设置。正在运行任务时无法安装；关闭应用后需重新下载更新。
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}
