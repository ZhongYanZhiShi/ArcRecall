"use client"

import {
  Check,
  FolderOpen,
  FolderPlus,
  PackageOpen,
  Upload,
} from "lucide-react"
import * as React from "react"

import { Button } from "@/components/ui/button"
import { countDictionary, isDesktopRuntime } from "@/lib/dictionary"
import { cn } from "@/lib/utils"

type OutputMode = "sibling" | "custom"

/**
 * UI 阶段（仅布局用，尚未接业务）：
 * - idle：未选文件，一屏只展示添加来源 + 输出设置
 * - ready：已选文件并完成分析/验密后，再展示分析、密码与结果区
 */
type ViewPhase = "idle" | "ready"

export function ExtractPage() {
  const [outputMode, setOutputMode] = React.useState<OutputMode>("sibling")
  const [outputDir, setOutputDir] = React.useState<string | null>(null)
  const [openWhenDone, setOpenWhenDone] = React.useState(true)
  const [dragOver, setDragOver] = React.useState(false)
  // 空状态为 idle；后续接业务后在选文件/验密成功时 setPhase("ready")
  const [phase] = React.useState<ViewPhase>("idle")
  const [dictionaryCount, setDictionaryCount] = React.useState<number | null>(
    null
  )

  React.useEffect(() => {
    let cancelled = false
    void countDictionary()
      .then((count) => {
        if (!cancelled) {
          setDictionaryCount(count)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDictionaryCount(isDesktopRuntime() ? null : 0)
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  /** 自定义输出目录：整块路径控件可点；业务接入后在此调系统目录选择器 */
  const handlePickOutputDir = React.useCallback(() => {
    // TODO: 接入桌面目录选择对话框后替换为真实路径
    setOutputDir((current) => current ?? "（待选择输出目录）")
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="mx-auto flex h-full min-h-0 w-full max-w-[720px] flex-col px-5 pt-6 pb-2">
        <header className="mb-3 shrink-0 text-center">
          <p className="text-[11px] font-medium tracking-[0.16em] text-muted-foreground uppercase">
            ArcRecall
          </p>
          <h1 className="mt-1 text-lg font-semibold tracking-tight">解压</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            拖入或选择压缩包 · 自动识别格式并解档
          </p>
        </header>

        <section
          onDragEnter={(event) => {
            event.preventDefault()
            setDragOver(true)
          }}
          onDragOver={(event) => {
            event.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={(event) => {
            event.preventDefault()
            if (event.currentTarget === event.target) {
              setDragOver(false)
            }
          }}
          onDrop={(event) => {
            event.preventDefault()
            setDragOver(false)
          }}
          className={cn(
            "flex min-h-0 flex-1 flex-col items-center justify-center rounded-xl border border-dashed px-5 py-6 text-center",
            "transition-surface",
            dragOver ? "dropzone-drag" : "border-border bg-muted/35"
          )}
        >
          <div
            aria-hidden
            className={cn(
              "mb-3 flex size-11 items-center justify-center rounded-xl border border-border bg-background",
              "transition-surface",
              dragOver &&
                "dropzone-icon-float motion-safe-only border-foreground/25 shadow-sm"
            )}
          >
            <PackageOpen
              className={cn(
                "size-5 text-foreground transition-transform duration-300 ease-out",
                dragOver && "scale-110"
              )}
              strokeWidth={1.75}
            />
          </div>

          <h2
            className={cn(
              "text-base font-semibold tracking-tight transition-colors duration-200",
              dragOver && "text-foreground"
            )}
          >
            {dragOver ? "松开以添加来源" : "将压缩包或文件夹拖到这里"}
          </h2>
          <p className="mt-1.5 max-w-sm text-xs leading-relaxed text-muted-foreground transition-opacity duration-200">
            支持 ZIP / RAR / 7Z、多文件与文件夹 · 不依赖扩展名
          </p>

          <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
            <Button className="rounded-lg transition-transform duration-150 active:scale-[0.98]">
              <Upload data-icon="inline-start" />
              选择压缩包
            </Button>
            <Button
              variant="outline"
              className="rounded-lg transition-transform duration-150 active:scale-[0.98]"
            >
              <FolderOpen data-icon="inline-start" />
              选择文件夹
            </Button>
          </div>

          <p className="mt-3 text-[11px] text-muted-foreground">
            <kbd className="rounded border border-border bg-background px-1 py-0.5 font-mono text-[10px] transition-colors">
              Ctrl
            </kbd>
            {" + "}
            <kbd className="rounded border border-border bg-background px-1 py-0.5 font-mono text-[10px] transition-colors">
              V
            </kbd>
            <span className="ml-1">粘贴路径</span>
          </p>
        </section>

        <section className="mt-3 shrink-0 rounded-xl border border-border bg-card px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <div
              role="group"
              aria-label="输出位置"
              className="relative grid h-8 shrink-0 grid-cols-2 items-stretch rounded-md border border-border bg-background p-0.5"
            >
              <span
                aria-hidden
                className={cn(
                  "absolute top-0.5 bottom-0.5 left-0.5 w-[calc(50%-2px)] rounded bg-foreground",
                  "transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]",
                  // 自身宽度 = 半宽 - 2px，再移 100% 正好落到第二格（含中间缝）
                  outputMode === "custom" && "translate-x-full"
                )}
              />
              <SegmentButton
                active={outputMode === "sibling"}
                onClick={() => setOutputMode("sibling")}
              >
                目标同级
              </SegmentButton>
              <SegmentButton
                active={outputMode === "custom"}
                onClick={() => setOutputMode("custom")}
              >
                自定义目录
              </SegmentButton>
            </div>

            {/* 同行中间区：同级说明 或 自定义目录选择 */}
            <div className="relative min-h-8 min-w-0 flex-1 overflow-hidden">
              <div
                className={cn(
                  "flex h-8 items-center transition-all duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]",
                  outputMode === "sibling"
                    ? "translate-x-0 opacity-100"
                    : "pointer-events-none absolute inset-0 -translate-x-2 opacity-0"
                )}
              >
                <p className="truncate text-xs text-muted-foreground">
                  解压到源文件同级同名文件夹
                </p>
              </div>

              <div
                className={cn(
                  "flex h-8 items-center transition-all duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]",
                  outputMode === "custom"
                    ? "translate-x-0 opacity-100"
                    : "pointer-events-none absolute inset-0 translate-x-2 opacity-0"
                )}
              >
                <OutputDirPicker
                  path={outputDir}
                  onPick={handlePickOutputDir}
                />
              </div>
            </div>

            <label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs">
              <span
                className={cn(
                  "transition-surface relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border",
                  openWhenDone
                    ? "border-foreground bg-foreground"
                    : "border-border bg-muted"
                )}
              >
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={openWhenDone}
                  onChange={(event) => setOpenWhenDone(event.target.checked)}
                />
                <span
                  className={cn(
                    "absolute size-2.5 rounded-full transition-all duration-200 ease-out",
                    openWhenDone
                      ? "right-0.5 bg-background"
                      : "left-0.5 bg-muted-foreground/50"
                  )}
                />
              </span>
              <span className="whitespace-nowrap">完成后打开</span>
            </label>
          </div>
        </section>

        {/* 选文件并分析/验密完成后才展示，避免空状态占屏 */}
        {phase === "ready" ? (
          <div className="mt-3 flex min-h-0 shrink-0 flex-col gap-2">
            <div className="grid gap-2 sm:grid-cols-2">
              <StatusCard title="归档分析" body="—" hint="已就绪" />
              <StatusCard title="历史密码" body="—" hint="已命中" />
            </div>
            <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-muted/30 px-3 py-2">
              <p className="truncate text-xs text-muted-foreground">
                全局字典候选 ·{" "}
                {dictionaryCount == null ? "—" : `${dictionaryCount} 条`}
              </p>
              <div className="flex shrink-0 gap-2">
                <Button size="sm" variant="outline" className="rounded-md">
                  验证密码
                </Button>
                <Button size="sm" className="rounded-md">
                  开始解档
                </Button>
              </div>
            </div>
            <footer className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-3 py-2">
              <p className="truncate text-xs text-muted-foreground">
                执行结果将显示在此
              </p>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0 rounded-md"
                disabled
              >
                <Check data-icon="inline-start" />
                打开输出文件夹
              </Button>
            </footer>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function SegmentButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative z-10 inline-flex h-full min-h-0 items-center justify-center rounded px-2.5",
        "text-xs leading-none font-semibold outline-none",
        "transition-colors duration-200 ease-out",
        "focus-visible:ring-2 focus-visible:ring-ring/40",
        active
          ? "text-background"
          : "text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </button>
  )
}

/**
 * 自定义输出目录：路径展示 + 右侧内嵌「选择」。
 * 整块可点，避免路径与按钮拆成两个独立控件。
 */
function OutputDirPicker({
  path,
  onPick,
}: {
  path: string | null
  onPick: () => void
}) {
  const hasPath = Boolean(path)
  const label = hasPath ? `输出目录：${path}，点击重新选择` : "选择输出目录"

  return (
    <button
      type="button"
      onClick={onPick}
      aria-label={label}
      title={path ?? "选择输出目录"}
      className={cn(
        "group flex h-8 min-w-0 flex-1 items-stretch overflow-hidden rounded-md border border-border bg-background",
        "text-left transition-colors duration-150 outline-none",
        "hover:bg-muted/35 focus-visible:ring-2 focus-visible:ring-ring/40",
        "active:scale-[0.995]"
      )}
    >
      <span
        className={cn(
          "flex min-w-0 flex-1 items-center px-2.5 text-xs leading-none",
          hasPath ? "text-foreground" : "text-muted-foreground"
        )}
      >
        <span className="truncate">{path ?? "尚未选择输出目录"}</span>
      </span>
      <span
        aria-hidden
        className={cn(
          "inline-flex shrink-0 items-center gap-1 border-l border-border px-2",
          "bg-muted/40 text-xs leading-none font-medium text-foreground",
          "transition-colors duration-150 group-hover:bg-muted/70"
        )}
      >
        <FolderPlus className="size-3.5 shrink-0" strokeWidth={1.9} />
        <span className="max-[420px]:sr-only">选择</span>
      </span>
    </button>
  )
}

function StatusCard({
  title,
  body,
  hint,
}: {
  title: string
  body: string
  hint: string
}) {
  return (
    <div className="transition-surface rounded-xl border border-border bg-card px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          {title}
        </p>
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          {hint}
        </span>
      </div>
      <p className="mt-1 truncate text-xs text-foreground">{body}</p>
    </div>
  )
}
