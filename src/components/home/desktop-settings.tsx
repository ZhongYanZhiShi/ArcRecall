"use client"
import * as React from "react"
import { invoke } from "@tauri-apps/api/core"
import { isDesktopRuntime } from "@/lib/runtime"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import { getSettings, updateSettings } from "@/lib/settings"

type Status = {
  supported: boolean
  contextMenu: boolean
  setupCompleted: boolean
}
export function DesktopSettings({
  onboarding = false,
}: {
  onboarding?: boolean
}) {
  const [status, setStatus] = React.useState<Status | null>(null)
  const [enabled, setEnabled] = React.useState(true)
  const [open, setOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState("")
  React.useEffect(() => {
    if (!isDesktopRuntime()) return
    let active = true
    void invoke<Status>("desktop_integration_status")
      .then((next) => {
        if (!active) return
        setStatus(next)
        setEnabled(onboarding && !next.setupCompleted ? true : next.contextMenu)
        setOpen(onboarding && !next.setupCompleted)
      })
      .catch((e) => {
        if (active) setError(String(e))
      })
    return () => {
      active = false
    }
  }, [onboarding])
  async function save(value: boolean) {
    if (busy) return
    setBusy(true)
    setError("")
    try {
      const next = await invoke<Status>("desktop_integration_save", {
        enabled: value,
        completeSetup: onboarding,
      })
      setStatus(next)
      setEnabled(next.contextMenu)
      setOpen(false)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }
  const content = (
    <div className="space-y-3 p-4">
      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy || !status?.supported}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        开启 Windows 右键菜单（推荐）
      </label>
      <p className="text-sm text-muted-foreground">
        在资源管理器中打开归档、加入解压队列或检查完整性。仅影响当前 Windows
        用户；Windows 11 可能需要点击“显示更多选项”。
      </p>
      {onboarding && (
        <p className="text-sm text-muted-foreground">
          首次使用请在“设置 →
          解密引擎”部署离线引擎。解压默认启用磁盘保护，可在设置中调整体积、条目和嵌套深度限制。
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button disabled={busy || !status} onClick={() => void save(enabled)}>
          {busy
            ? "正在保存…"
            : onboarding
              ? "保存并开始使用"
              : "保存右键菜单设置"}
        </Button>
        {onboarding && (
          <Button
            variant="outline"
            disabled={busy || !status}
            onClick={() => void save(false)}
          >
            暂不开启
          </Button>
        )}
      </div>
    </div>
  )
  if (onboarding)
    return (
      <Sheet
        open={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value)
        }}
      >
        <SheetContent>
          <SheetHeader>
            <SheetTitle>欢迎使用 ArcRecall · 推荐设置</SheetTitle>
            <SheetDescription>这些选项可以随时在设置中修改。</SheetDescription>
          </SheetHeader>
          {content}
        </SheetContent>
      </Sheet>
    )
  if (!isDesktopRuntime()) return null
  return (
    <section className="rounded-xl border">
      <h3 className="px-4 pt-4 font-medium">资源管理器集成</h3>
      {content}
    </section>
  )
}
export function ExtractionLimitSettings() {
  const [limits, setLimits] = React.useState({
    maxGib: 100,
    maxEntries: 100000,
    maxDepth: 5,
  })
  const [ready, setReady] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [message, setMessage] = React.useState("")
  React.useEffect(() => {
    let active = true
    void getSettings()
      .then((s) => {
        if (active) {
          if (s.recovery?.extractionLimits)
            setLimits(s.recovery.extractionLimits)
          setReady(true)
        }
      })
      .catch((e) => {
        if (active) setMessage(String(e))
      })
    return () => {
      active = false
    }
  }, [])
  return (
    <section className="space-y-3 rounded-xl border p-4">
      <h3 className="font-medium">解压空间与嵌套限制</h3>
      <p className="text-sm text-muted-foreground">
        单个任务累计统计外层和嵌套输出，解压前检查声明大小，运行中监控实际用量与可用空间，保留至少
        256 MiB。加密目录及嵌套内容可能无法预先估算。
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        {(
          [
            ["maxGib", "最大展开体积（GiB）", 100000],
            ["maxEntries", "最大条目数", 10000000],
            ["maxDepth", "最大嵌套深度", 64],
          ] as const
        ).map(([key, label, max]) => (
          <label key={key} className="space-y-2 text-sm">
            {label}
            <Input
              type="number"
              min={1}
              max={max}
              value={limits[key]}
              disabled={!ready || busy}
              onChange={(e) =>
                setLimits({ ...limits, [key]: Number(e.target.value) })
              }
            />
          </label>
        ))}
      </div>
      <Button
        disabled={!ready || busy}
        onClick={async () => {
          setBusy(true)
          try {
            await updateSettings({ kind: "extractionLimits", value: limits })
            setMessage("已保存，下次启动的解压任务生效。")
          } catch (e) {
            setMessage(String(e))
          } finally {
            setBusy(false)
          }
        }}
      >
        保存解压限制
      </Button>
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
    </section>
  )
}
