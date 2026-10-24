"use client"

import * as React from "react"
import { invoke } from "@tauri-apps/api/core"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { isDesktopRuntime } from "@/lib/dictionary"
import { openRememberingDirectory } from "@/lib/file-dialog"

type Policy = {
  enabled: boolean
  directory: string | null
  intervalHours: number
  keepCount: number
}
type Overview = {
  status: {
    policy: Policy
    lastAttemptMs: number | null
    lastSuccessMs: number | null
    lastError: string | null
  }
  entries: {
    path: string
    createdAtMs: number
    byteCount: number
    automatic: boolean
    exists: boolean
  }[]
}
export function BackupManagementPanel({
  disabled,
  onPreview,
}: {
  disabled: boolean
  onPreview: (path: string) => Promise<void>
}) {
  const [data, setData] = React.useState<Overview | null>(null)
  const [draft, setDraft] = React.useState<Policy | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const operation = React.useRef(false)
  React.useEffect(() => {
    if (!isDesktopRuntime()) return
    let disposed = false
    void invoke<Overview>("backup_management_get")
      .then((value) => {
        if (!disposed && value) {
          setData(value)
          setDraft(value.status.policy)
        }
      })
      .catch((e) => {
        if (!disposed) setError(String(e))
      })
    return () => {
      disposed = true
    }
  }, [])
  async function run(action: () => Promise<void>) {
    if (operation.current) return
    operation.current = true
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await action()
    } catch (e) {
      setError(String(e))
    } finally {
      operation.current = false
      setBusy(false)
    }
  }
  const locked = disabled || busy || !isDesktopRuntime()
  const time = (ms: number | null) =>
    ms ? new Date(ms).toLocaleString("zh-CN") : "暂无"
  return (
    <section className="space-y-3 border-t pt-3" aria-label="自动备份管理">
      <p className="text-sm font-medium">自动备份管理</p>
      <p className="text-xs text-muted-foreground">
        应用运行时每分钟检查一次，到期后等待空闲备份；关闭期间错过的备份会在下次启动后补做。只清理当前目录中本应用登记且未被更改的自动备份，保留手动备份和恢复前安全备份。配置仅保存在本机。
      </p>
      {draft && (
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.enabled}
              disabled={locked}
              onChange={(e) =>
                setDraft({ ...draft, enabled: e.target.checked })
              }
            />
            启用自动备份
          </label>
          <p className="text-xs break-all">
            自动备份目录：{draft.directory ?? "尚未选择"}
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={locked}
              onClick={() =>
                void run(async () => {
                  const path = await openRememberingDirectory(
                    "automatic-backup",
                    {
                      directory: true,
                      multiple: false,
                      title: "选择自动备份目录",
                    }
                  )
                  if (typeof path === "string")
                    setDraft({ ...draft, directory: path })
                })
              }
            >
              选择备份目录
            </Button>
            <label className="text-xs">
              备份频率
              <select
                className="block h-9 rounded-md border bg-background px-2 text-sm"
                aria-label="备份频率"
                value={draft.intervalHours}
                disabled={locked}
                onChange={(e) =>
                  setDraft({ ...draft, intervalHours: Number(e.target.value) })
                }
              >
                <option value={24}>每天</option>
                <option value={168}>每周</option>
              </select>
            </label>
            <label className="text-xs">
              保留份数
              <Input
                className="w-24"
                aria-label="保留备份份数"
                type="number"
                min={1}
                max={100}
                value={draft.keepCount}
                disabled={locked}
                onChange={(e) =>
                  setDraft({ ...draft, keepCount: Number(e.target.value) })
                }
              />
            </label>
            <Button
              size="sm"
              disabled={locked}
              onClick={() =>
                void run(async () => {
                  const next = await invoke<Overview>("backup_policy_save", {
                    policy: draft,
                  })
                  setData(next)
                  setDraft(next.status.policy)
                  setNotice("自动备份设置已保存。")
                })
              }
            >
              保存备份设置
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            最近尝试：{time(data?.status.lastAttemptMs ?? null)} · 最近成功：
            {time(data?.status.lastSuccessMs ?? null)}
          </p>
          {data?.status.lastError && (
            <p role="status" className="text-xs text-destructive">
              {data.status.lastError}
            </p>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={locked || !data?.status.policy.directory}
            onClick={() =>
              void run(async () => {
                try {
                  await invoke("backup_run_now")
                  setNotice("已按保存的设置完成备份与保留检查。")
                } finally {
                  setData(await invoke<Overview>("backup_management_get"))
                }
              })
            }
          >
            按已保存设置立即备份
          </Button>
        </div>
      )}
      <Button
        variant="outline"
        size="sm"
        disabled={locked}
        onClick={() =>
          void run(async () => {
            const next = await invoke<Overview>("backup_management_get")
            setData(next)
            if (!draft) setDraft(next.status.policy)
          })
        }
      >
        刷新备份列表
      </Button>
      {notice && (
        <p role="status" className="text-xs">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="max-h-64 space-y-2 overflow-auto">
        {data?.entries.map((entry) => (
          <div key={entry.path} className="space-y-1 rounded-md border p-2">
            <p className="text-xs">
              {entry.automatic ? "自动备份" : "手动／恢复前备份"} ·{" "}
              {time(entry.createdAtMs)} ·{" "}
              {(entry.byteCount / 1024 / 1024).toFixed(2)} MiB
              {!entry.exists && " · 文件已移走或删除"}
            </p>
            <p className="text-xs break-all">{entry.path}</p>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={locked || !entry.exists}
                onClick={() => void run(() => onPreview(entry.path))}
              >
                预览恢复
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={locked || !entry.exists}
                onClick={() =>
                  void run(() => invoke("open_path", { path: entry.path }))
                }
              >
                定位备份
              </Button>
            </div>
          </div>
        ))}
        {data?.entries.length === 0 && (
          <p className="text-xs text-muted-foreground">暂无已登记备份。</p>
        )}
      </div>
    </section>
  )
}
