"use client"
import * as React from "react"
import { invoke } from "@tauri-apps/api/core"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import { formatFileSize } from "./recovery-view-utils"
type Diagnosis = {
  existing: string[]
  missing: string[]
  warnings: string[]
  primaryPath: string
  analysisError: string | null
  recognizable: boolean
}
type Space = {
  declaredBytes: number
  entries: number
  availableBytes: number | null
  exceedsLimit: boolean
  insufficientSpace: boolean
}
export function ArchiveDiagnostics({
  path,
  output,
  password,
  disabled,
  onRetry,
}: {
  path: string
  output?: string
  password: string
  disabled: boolean
  onRetry: (path: string) => Promise<void>
}) {
  const [open, setOpen] = React.useState(false)
  const [diagnosis, setDiagnosis] = React.useState<Diagnosis | null>(null)
  const [space, setSpace] = React.useState<Space | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState("")
  const working = React.useRef(false)
  async function run(kind: "volumes" | "space") {
    if (working.current || disabled) return
    working.current = true
    setBusy(true)
    setError("")
    setOpen(true)
    try {
      if (kind === "volumes")
        setDiagnosis(
          await invoke<Diagnosis>("archive_volume_diagnostics", { path })
        )
      else {
        setSpace(null)
        setSpace(
          await invoke<Space>("archive_space_preflight", {
            path,
            output,
            password: password || null,
          })
        )
      }
    } catch (e) {
      setError(String(e))
    } finally {
      working.current = false
      setBusy(false)
    }
  }
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || busy}
          onClick={() => void run("volumes")}
        >
          分卷诊断／补卷重试
        </Button>
        {output && (
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || busy}
            onClick={() => void run("space")}
          >
            检查解压空间
          </Button>
        )}
      </div>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>归档诊断</SheetTitle>
            <SheetDescription className="break-all">{path}</SheetDescription>
          </SheetHeader>
          <div className="space-y-4 p-4 text-sm">
            {busy && <p role="status">正在读取归档信息…</p>}
            {error && (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            )}
            {diagnosis && (
              <>
                <h3 className="font-medium">
                  找到的卷（{diagnosis.existing.length}）
                </h3>
                <ul className="max-h-52 overflow-auto">
                  {diagnosis.existing.map((p) => (
                    <li key={p} className="break-all">
                      {p}
                    </li>
                  ))}
                </ul>
                <h3 className="font-medium">
                  缺失卷（{diagnosis.missing.length}）
                </h3>
                {diagnosis.missing.length ? (
                  <ul className="max-h-40 overflow-auto text-destructive">
                    {diagnosis.missing.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                ) : (
                  <p>未发现编号缺口；不代表整包完整。</p>
                )}
                {diagnosis.analysisError && (
                  <p className="text-destructive">
                    归档识别：{diagnosis.analysisError}
                  </p>
                )}
                {diagnosis.warnings.map((w) => (
                  <p key={w} className="text-muted-foreground">
                    {w}
                  </p>
                ))}
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    disabled={busy || disabled}
                    onClick={() => void run("volumes")}
                  >
                    补齐后重新检测
                  </Button>
                  <Button
                    disabled={busy || disabled || !diagnosis.recognizable}
                    onClick={async () => {
                      setBusy(true)
                      setOpen(false)
                      try {
                        await onRetry(diagnosis.primaryPath)
                        setOpen(false)
                      } catch (e) {
                        setError(String(e))
                        setOpen(true)
                      } finally {
                        setBusy(false)
                      }
                    }}
                  >
                    按当前选项重试解压
                  </Button>
                </div>
              </>
            )}
            {space && (
              <section className="space-y-2 rounded-xl border p-3">
                <h3 className="font-medium">空间预检</h3>
                <p>
                  外层声明大小：{formatFileSize(space.declaredBytes)} ·{" "}
                  {space.entries} 项
                </p>
                <p>
                  目标可用空间：
                  {space.availableBytes == null
                    ? "当前平台无法读取"
                    : formatFileSize(space.availableBytes)}
                </p>
                <p
                  className={
                    space.exceedsLimit || space.insufficientSpace
                      ? "text-destructive"
                      : "text-muted-foreground"
                  }
                >
                  {space.exceedsLimit
                    ? "已超过设置中的解压限制。"
                    : space.insufficientSpace
                      ? "目标磁盘空间不足（包含 256 MiB 保留空间）。"
                      : "当前外层声明未超限。"}
                </p>
                <p className="text-muted-foreground">
                  仅统计外层声明，不包含嵌套包展开量，也不能保证文件此后未变化。执行时会重新检查并实时监控。
                </p>
              </section>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
