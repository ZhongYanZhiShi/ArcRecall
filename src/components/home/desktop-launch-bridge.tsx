"use client"
import * as React from "react"
import { invoke } from "@tauri-apps/api/core"
import { toast } from "sonner"
import { isDesktopRuntime } from "@/lib/runtime"
import {
  recoveryQueue,
  recoveryQueueJournal,
} from "@/lib/recovery-queue-session"
import { BatchIntegrityCheck } from "./batch-integrity-check"
import { Button } from "@/components/ui/button"

type Launch = {
  id: string
  action: "open" | "queue" | "check" | "focus"
  path: string
}
export function DesktopLaunchBridge({
  onOpenExtract,
}: {
  onOpenExtract: () => void
}) {
  const [check, setCheck] = React.useState<Launch | null>(null)
  const [checking, setChecking] = React.useState(false)
  const [error, setError] = React.useState("")
  const nav = React.useRef(onOpenExtract)
  React.useEffect(() => {
    nav.current = onOpenExtract
  }, [onOpenExtract])
  const handled = React.useRef(new Set<string>())
  React.useEffect(() => {
    if (!isDesktopRuntime()) return
    let busy = false,
      active = true
    const poll = async () => {
      if (busy || !active) return
      busy = true
      try {
        await recoveryQueueJournal.initialize()
        const requests = await invoke<Launch[]>("desktop_launch_list")
        for (const request of requests) {
          if (!active || handled.current.has(request.id)) continue
          const ack = async () => {
            handled.current.add(request.id)
            try {
              await invoke("desktop_launch_ack", { id: request.id })
            } catch (e) {
              setError(String(e))
            }
          }
          if (request.action === "focus") {
            await ack()
          } else if (request.action === "queue") {
            if (recoveryQueue.getSnapshot().running) continue
            recoveryQueue.enqueue([request.path])
            await recoveryQueueJournal.flush()
            await ack()
            nav.current()
            toast.success("已从资源管理器加入解压队列。")
          } else if (request.action === "check") {
            if (check) continue
            setCheck(request)
            await ack()
            break
          } else {
            nav.current()
            window.dispatchEvent(
              new CustomEvent("arcrecall-shell-open", {
                detail: { path: request.path, accept: ack },
              })
            )
          }
        }
      } catch (e) {
        if (active) setError(String(e))
      } finally {
        busy = false
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), 1500)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [check])
  return (
    <>
      {check && (
        <div className="fixed right-4 bottom-20 z-50 flex max-w-sm flex-wrap gap-2 rounded-xl border bg-card p-3 shadow-lg">
          <span className="w-full truncate text-sm" title={check.path}>
            资源管理器：检查完整性
          </span>
          <BatchIntegrityCheck
            key={check.id}
            paths={[check.path]}
            disabled={false}
            initiallyOpen
            onBusyChange={setChecking}
          />
          <Button
            size="sm"
            variant="ghost"
            disabled={checking}
            onClick={() => setCheck(null)}
          >
            关闭入口
          </Button>
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="fixed right-4 bottom-4 z-50 max-w-sm rounded-xl border bg-card p-3 text-sm"
        >
          {error}
          <Button variant="ghost" size="sm" onClick={() => setError("")}>
            关闭提示
          </Button>
        </div>
      )}
    </>
  )
}
