"use client"
import * as React from "react"
import { invoke } from "@tauri-apps/api/core"
import { isDesktopRuntime } from "@/lib/runtime"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
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
  onDirtyChange,
  onBusyChange,
}: {
  onboarding?: boolean
  onDirtyChange?: (dirty: boolean) => void
  onBusyChange?: (busy: boolean) => void
}) {
  const [reload, setReload] = React.useState(0)
  const [loading, setLoading] = React.useState(true)
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
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [onboarding, reload])
  const dirty = status !== null && enabled !== status.contextMenu
  React.useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])
  React.useEffect(() => {
    onBusyChange?.(busy)
  }, [busy, onBusyChange])
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
          id="desktop-context-menu"
          data-settings-pending={dirty || undefined}
          type="checkbox"
          checked={enabled}
          disabled={busy || !status?.supported}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        开启 Windows 右键菜单（推荐）
        {dirty && !onboarding ? <Badge variant="warning">未保存</Badge> : null}
      </label>
      <p className="text-sm text-muted-foreground">
        修改后保存；可撤销尚未保存的修改。
      </p>
      {loading ? (
        <p role="status" className="text-sm">
          正在读取右键菜单设置…
        </p>
      ) : null}
      <p className="text-sm text-muted-foreground">
        在资源管理器中打开归档、加入解压队列或检查完整性。仅影响当前 Windows
        用户；Windows 11 可能需要点击“显示更多选项”。
      </p>
      {onboarding && (
        <p className="text-sm text-muted-foreground">
          首次使用请在“设置 →
          解压与解密”部署离线引擎。解压默认启用磁盘保护，可在设置中调整体积、条目和嵌套深度限制。
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {error && !status ? (
        <Button
          type="button"
          variant="outline"
          disabled={loading}
          onClick={() => {
            setError("")
            setLoading(true)
            setReload((value) => value + 1)
          }}
        >
          重新读取右键菜单设置
        </Button>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={busy || !status?.supported || (!onboarding && !dirty)}
          onClick={() => void save(enabled)}
        >
          {busy
            ? "正在保存…"
            : onboarding
              ? "保存并开始使用"
              : "保存右键菜单设置"}
        </Button>
        {!onboarding ? (
          <Button
            type="button"
            variant="ghost"
            disabled={!dirty || busy}
            onClick={() => {
              if (status) setEnabled(status.contextMenu)
              setError("")
            }}
          >
            撤销修改
          </Button>
        ) : null}
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
const LIMIT_FIELDS = [
  ["maxGib", "最大展开体积（GiB）", 100000],
  ["maxEntries", "最大条目数", 10000000],
  ["maxDepth", "最大嵌套深度", 64],
] as const
const DEFAULT_LIMITS = { maxGib: 100, maxEntries: 100000, maxDepth: 5 }
type Limits = typeof DEFAULT_LIMITS
function limitInputs(limits: Limits) {
  return {
    maxGib: String(limits.maxGib),
    maxEntries: String(limits.maxEntries),
    maxDepth: String(limits.maxDepth),
  }
}
export function ExtractionLimitSettings({
  onDirtyChange,
  onBusyChange,
}: {
  onDirtyChange?: (dirty: boolean) => void
  onBusyChange?: (busy: boolean) => void
}) {
  const [reload, setReload] = React.useState(0)
  const [loading, setLoading] = React.useState(true)
  const [saved, setSaved] = React.useState<Limits | null>(null)
  const [draft, setDraft] = React.useState(() => limitInputs(DEFAULT_LIMITS))
  const [busy, setBusy] = React.useState(false)
  const operation = React.useRef(false)
  const [feedback, setFeedback] = React.useState<{
    text: string
    error: boolean
  } | null>(null)
  React.useEffect(() => {
    let active = true
    void getSettings()
      .then((settings) => {
        if (!active) return
        const limits = settings.recovery?.extractionLimits ?? DEFAULT_LIMITS
        setSaved(limits)
        setDraft(limitInputs(limits))
      })
      .catch((error) => {
        if (active)
          setFeedback({
            text: `读取解压限制失败：${String(error)}`,
            error: true,
          })
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [reload])
  const dirty =
    saved !== null &&
    LIMIT_FIELDS.some(([key]) => draft[key] !== String(saved[key]))
  const invalid = LIMIT_FIELDS.some(
    ([key, , max]) =>
      !draft[key].trim() ||
      !Number.isInteger(Number(draft[key])) ||
      Number(draft[key]) < 1 ||
      Number(draft[key]) > max
  )
  React.useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])
  React.useEffect(() => {
    onBusyChange?.(busy)
  }, [busy, onBusyChange])
  async function save() {
    if (operation.current || !saved || !dirty || invalid) return
    operation.current = true
    setBusy(true)
    setFeedback(null)
    const limits = {
      maxGib: Number(draft.maxGib),
      maxEntries: Number(draft.maxEntries),
      maxDepth: Number(draft.maxDepth),
    }
    try {
      const result = await updateSettings({
        kind: "extractionLimits",
        value: limits,
      })
      const next = result.recovery?.extractionLimits ?? limits
      setSaved(next)
      setDraft(limitInputs(next))
      setFeedback({ text: "已保存，下次启动的解压任务生效。", error: false })
    } catch (error) {
      setFeedback({ text: `保存失败：${String(error)}`, error: true })
    } finally {
      operation.current = false
      setBusy(false)
    }
  }
  return (
    <form
      className="space-y-3 border-t pt-4"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">解压空间与嵌套限制</h3>
        {dirty ? <Badge variant="warning">未保存</Badge> : null}
      </div>
      <p className="text-sm text-muted-foreground">
        单个任务累计统计外层和嵌套输出，解压前检查声明大小，运行中监控实际用量与可用空间，保留至少
        256 MiB。加密目录及嵌套内容可能无法预先估算。
      </p>
      {loading ? (
        <p role="status" className="text-sm">
          正在读取解压限制…
        </p>
      ) : null}
      {saved === null && feedback?.error ? (
        <Button
          type="button"
          variant="outline"
          disabled={loading}
          onClick={() => {
            setFeedback(null)
            setLoading(true)
            setReload((value) => value + 1)
          }}
        >
          重新读取解压限制
        </Button>
      ) : null}
      <p className="text-sm text-muted-foreground">
        修改后保存，下次任务生效。
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        {LIMIT_FIELDS.map(([key, label, max]) => {
          const fieldInvalid =
            !draft[key].trim() ||
            !Number.isInteger(Number(draft[key])) ||
            Number(draft[key]) < 1 ||
            Number(draft[key]) > max
          return (
            <div key={key} className="flex flex-col gap-2 text-sm">
              <label htmlFor={`extraction-limit-${key}`}>{label}</label>
              <Input
                id={`extraction-limit-${key}`}
                data-settings-pending={
                  (saved !== null && draft[key] !== String(saved[key])) ||
                  undefined
                }
                type="number"
                min={1}
                max={max}
                step={1}
                required
                value={draft[key]}
                disabled={saved === null || busy}
                aria-invalid={fieldInvalid}
                aria-describedby={
                  fieldInvalid ? `extraction-limit-${key}-error` : undefined
                }
                onChange={(event) => {
                  setDraft({ ...draft, [key]: event.target.value })
                  setFeedback(null)
                }}
              />
              {fieldInvalid ? (
                <p
                  id={`extraction-limit-${key}-error`}
                  className="text-destructive"
                >
                  请输入 1–{max} 之间的整数。
                </p>
              ) : null}
            </div>
          )
        })}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          disabled={saved === null || busy || !dirty || invalid}
          aria-busy={busy}
          className="min-w-28 scroll-my-4"
        >
          {busy ? "正在保存…" : "保存解压限制"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={!dirty || busy}
          onClick={() => {
            if (saved) setDraft(limitInputs(saved))
            setFeedback(null)
          }}
        >
          撤销修改
        </Button>
      </div>
      {feedback ? (
        <p
          role={feedback.error ? "alert" : "status"}
          className={feedback.error ? "text-sm text-destructive" : "text-sm"}
        >
          {feedback.text}
        </p>
      ) : null}
    </form>
  )
}
