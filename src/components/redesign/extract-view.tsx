"use client"

import {
  ArrowRight,
  Copy,
  Eye,
  EyeOff,
  FilePlus2,
  FolderOpen,
  FolderPlus,
  Pause,
  Plus,
  RotateCcw,
  X,
} from "lucide-react"
import * as React from "react"

import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { cn } from "@/lib/utils"

import {
  DICTIONARY_TOTAL,
  type Layer,
  QUEUE,
  type QueueItem,
  type QueueState,
} from "./mock-data"
import { NUMBER, StatusTag, type Tone } from "./parts"
import { Token, ToggleWord } from "./sentence"
import { Strata } from "./strata"

const QUEUE_TONE: Record<QueueState, { tone: Tone; label: string }> = {
  done: { tone: "success", label: "完成" },
  running: { tone: "running", label: "处理中" },
  needsPassword: { tone: "warning", label: "需要密码" },
  missingVolume: { tone: "danger", label: "缺分卷" },
  waiting: { tone: "neutral", label: "排队" },
}

const OUTPUT = [
  { value: "sibling", label: "源文件旁边的同名文件夹" },
  { value: "custom", label: "我指定的文件夹" },
] as const

const CONFLICT = [
  { value: "rename", label: "自动改名" },
  { value: "numbered", label: "另建带序号的文件夹" },
] as const

const COMPUTE = [
  { value: "gpu", label: "GPU，没有就用 CPU" },
  { value: "cpu", label: "只用 CPU" },
] as const

/**
 * 解压页不再是“列表 + 详情 + 选项面板”。
 * 舞台中央只有当前这个压缩包；上方一句话说明它现在怎样，
 * 下方一句话说明会怎么处理，底部托盘放着这一批的其他压缩包。
 */
export function ExtractView({
  onOpenDictionary,
  onOpenSettings,
}: {
  onOpenDictionary: () => void
  onOpenSettings: () => void
}) {
  const [selectedId, setSelectedId] = React.useState<string | null>("q2")
  const selected = QUEUE.find((item) => item.id === selectedId) ?? null

  return (
    <section className="flex h-full min-h-0 flex-col">
      <h1 className="sr-only">解压</h1>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid min-h-full w-full max-w-6xl gap-x-16 gap-y-12 px-5 pt-8 pb-10 md:px-10 md:pt-12 xl:grid-cols-[minmax(0,27rem)_minmax(0,1fr)]">
          <div className="flex min-w-0 flex-col">
            {selected ? (
              <Headline key={selected.id} item={selected} />
            ) : (
              <EmptyStage />
            )}
            <HowSentence
              onOpenDictionary={onOpenDictionary}
              onOpenSettings={onOpenSettings}
            />
          </div>
          {selected ? (
            <div className="min-w-0 xl:pt-6">
              <Strata
                key={selected.id}
                layers={selected.layers}
                renderLabel={(layer) => (
                  <LayerLabel layer={layer} item={selected} />
                )}
              />
            </div>
          ) : null}
        </div>
      </div>
      <Shelf selectedId={selectedId} onSelect={setSelectedId} />
    </section>
  )
}

/* —— 舞台左侧：一句话说明现在怎样 —— */

function Headline({ item }: { item: QueueItem }) {
  const [visible, setVisible] = React.useState(false)
  const headline = (
    title: React.ReactNode,
    sub: React.ReactNode,
    actions?: React.ReactNode
  ) => (
    <div className="min-w-0">
      <p className="truncate text-sm text-muted-foreground">
        <span className="font-medium text-foreground">{item.name}</span>
        <span className="mx-2 text-foreground/25">/</span>
        <span className="font-mono text-xs">{item.location}</span>
      </p>
      <h2 className="mt-3 text-[1.75rem] leading-tight font-semibold tracking-tight text-balance md:text-[2.125rem]">
        {title}
      </h2>
      <p className="rd-tabular mt-3 text-[15px] leading-relaxed text-muted-foreground">
        {sub}
      </p>
      {actions ? (
        <div className="mt-5 flex flex-wrap items-center gap-3">{actions}</div>
      ) : null}
    </div>
  )

  switch (item.state) {
    case "running":
      return headline(
        "正在用字典尝试打开第 2 层。",
        <>
          已检查 18,402 / {NUMBER.format(DICTIONARY_TOTAL)} 条候选，每秒约 1,240
          条，大约还要 9 秒。
        </>,
        <Button variant="ghost" className="-ml-3">
          <X data-icon="inline-start" />
          取消这一项
        </Button>
      )
    case "done":
      return headline(
        "三层都打开了。",
        "用时 41 秒。原文件没有改动，本次产生的 2 个空文件夹已清理。",
        <>
          <Button size="lg">
            <FolderOpen data-icon="inline-start" />
            打开输出文件夹
          </Button>
          <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
            第 2 层的密码
            <code className="mx-1 rounded-sm bg-muted px-2 py-0.5 font-mono text-[13px] text-foreground">
              {visible ? "资料备份2026" : "••••••••"}
            </code>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={visible ? "隐藏密码" : "显示密码"}
              onClick={() => setVisible((v) => !v)}
            >
              {visible ? <EyeOff /> : <Eye />}
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="复制密码">
              <Copy />
            </Button>
          </span>
        </>
      )
    case "needsPassword":
      return headline(
        "这一层需要你提供密码。",
        `字典里的 ${NUMBER.format(DICTIONARY_TOTAL)} 条候选和历史密码都没有对上。`,
        <PasswordRetry />
      )
    case "missingVolume":
      return headline(
        "还差一卷，没法开始。",
        "找到了 part1 和 part2，缺少 设计稿.part3.rar。把它放到同一个文件夹，再重新查找。",
        <Button size="lg" variant="outline">
          <RotateCcw data-icon="inline-start" />
          重新查找分卷
        </Button>
      )
    case "waiting":
      return headline(
        "排在第 5 个，还没开始。",
        "它没有扩展名。轮到它时，会先按内容识别是哪种压缩包。"
      )
  }
}

function PasswordRetry() {
  const [visible, setVisible] = React.useState(false)
  return (
    <form
      className="flex flex-wrap items-end gap-x-3 gap-y-3 text-[17px]"
      onSubmit={(e) => e.preventDefault()}
    >
      <label htmlFor="retry-password" className="pb-1.5">
        用这个密码再试一次：
      </label>
      <span className="relative inline-flex">
        <input
          id="retry-password"
          type={visible ? "text" : "password"}
          autoComplete="off"
          placeholder="输入密码"
          className="h-10 w-56 border-0 border-b-2 border-warning bg-transparent pr-9 font-mono text-[17px] outline-none placeholder:font-sans placeholder:text-muted-foreground/70 focus-visible:border-primary"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="absolute right-0 bottom-1"
          aria-label={visible ? "隐藏密码" : "显示密码"}
          onClick={() => setVisible((v) => !v)}
        >
          {visible ? <EyeOff /> : <Eye />}
        </Button>
      </span>
      <Button type="submit" size="lg">
        再试一次
      </Button>
    </form>
  )
}

function LayerLabel({ layer, item }: { layer: Layer; item: QueueItem }) {
  const tone: Record<Layer["state"], { tone: Tone; label: string }> = {
    done: { tone: "success", label: "已打开" },
    running: { tone: "running", label: `正在${layer.stage ?? "处理"}` },
    needsPassword: { tone: "warning", label: "需要密码" },
    blocked: { tone: "danger", label: "缺分卷" },
    waiting: { tone: "neutral", label: "等待" },
    unknown: { tone: "neutral", label: "还看不到" },
  }
  const status = tone[layer.state]
  const unknown = layer.state === "unknown"
  const short = layer.name.split("/").at(-1) ?? layer.name

  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-xs text-muted-foreground">
          第 {layer.depth + 1} 层
        </span>
        <StatusTag tone={status.tone}>{status.label}</StatusTag>
      </div>
      <p
        className={cn(
          "mt-1 text-[17px] font-semibold",
          unknown ? "text-[15px] font-normal text-muted-foreground" : "truncate"
        )}
        title={layer.name}
      >
        {unknown ? "里面还有什么，打开上一层才知道" : short}
      </p>
      {!unknown ? (
        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[13px] text-muted-foreground">
          {layer.apparent && layer.format && layer.apparent !== layer.format ? (
            <span className="inline-flex items-center gap-1">
              看起来是 <s>{layer.apparent}</s>
              <ArrowRight aria-label="实际是" className="size-3" />
              <span className="font-semibold text-foreground">
                {layer.format}
              </span>
            </span>
          ) : layer.format ? (
            <span className="font-semibold text-foreground">
              {layer.format}
            </span>
          ) : null}
          {layer.encryption ? <span>{layer.encryption}</span> : null}
          {layer.size ? <span className="rd-tabular">{layer.size}</span> : null}
        </p>
      ) : null}
      {layer.state === "done" && layer.detail && item.state === "done" ? (
        <p className="mt-1 text-[13px] text-muted-foreground">{layer.detail}</p>
      ) : null}
    </div>
  )
}

function EmptyStage() {
  return (
    <div className="flex flex-col items-start gap-6 py-6 md:py-14">
      <div aria-hidden="true" className="relative h-40 w-56">
        <div className="rd-iso" style={{ width: "62%", top: "64%" }}>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="rd-slab rd-slab-unknown"
              style={
                { "--z": `${(2 - i) * 34}px`, "--i": i } as React.CSSProperties
              }
            />
          ))}
        </div>
      </div>
      <h2 className="max-w-2xl text-[2rem] leading-tight font-semibold tracking-tight md:text-[2.5rem]">
        把压缩包放到这里，
        <br />
        一层一层帮你打开。
      </h2>
      <p className="max-w-xl text-[15px] leading-relaxed text-muted-foreground">
        扩展名被改过、没有扩展名、套了好几层都没关系，按文件内容识别。原文件不会被改动。
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button size="lg">
          <FilePlus2 data-icon="inline-start" />
          选择压缩包
        </Button>
        <Button size="lg" variant="outline">
          <FolderPlus data-icon="inline-start" />
          选择文件夹
        </Button>
        <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
          或粘贴路径 <Kbd>Ctrl</Kbd>
          <Kbd>V</Kbd>
        </span>
      </div>
    </div>
  )
}

/* —— 一句话说明会怎么处理 —— */

function HowSentence({
  onOpenDictionary,
  onOpenSettings,
}: {
  onOpenDictionary: () => void
  onOpenSettings: () => void
}) {
  const [output, setOutput] =
    React.useState<(typeof OUTPUT)[number]["value"]>("sibling")
  const [conflict, setConflict] =
    React.useState<(typeof CONFLICT)[number]["value"]>("rename")
  const [compute, setCompute] =
    React.useState<(typeof COMPUTE)[number]["value"]>("gpu")
  const [recursive, setRecursive] = React.useState(true)
  const [openAfter, setOpenAfter] = React.useState(true)
  const [remember, setRemember] = React.useState(false)

  return (
    <section aria-labelledby="how-title" className="mt-14 max-w-2xl">
      <h2 id="how-title" className="text-sm font-medium text-muted-foreground">
        这一批会这样处理
      </h2>
      <p className="mt-3 text-base leading-[2.05] text-foreground/90">
        解压到{" "}
        <Token
          label="输出位置"
          value={output}
          options={OUTPUT}
          onChange={setOutput}
        />
        ，遇到同名文件时
        <Token
          label="同名文件"
          value={conflict}
          options={CONFLICT}
          onChange={setConflict}
        />
        。先试
        <label htmlFor="known-password" className="sr-only">
          已知密码
        </label>
        <input
          id="known-password"
          type="password"
          autoComplete="off"
          placeholder="你知道的密码（可不填）"
          className="mx-1 w-48 border-0 border-b-2 border-dashed border-primary/45 bg-transparent px-0.5 align-baseline font-semibold outline-none placeholder:font-normal placeholder:text-muted-foreground/80 focus-visible:border-primary"
        />
        ，再试历史密码和字典里的
        <button
          type="button"
          onClick={onOpenDictionary}
          className="rd-tabular mx-0.5 border-b-2 border-dashed border-primary/45 px-0.5 font-semibold outline-none hover:border-primary focus-visible:bg-primary/8"
        >
          {NUMBER.format(DICTIONARY_TOTAL)} 条候选
        </button>
        ，用
        <Token
          label="解密算力"
          value={compute}
          options={COMPUTE}
          onChange={setCompute}
        />
        计算。打开后
        <ToggleWord
          label="继续拆开内层压缩包"
          on={recursive}
          onChange={setRecursive}
          onText="继续拆开"
          offText="不再拆开"
        />
        里面的压缩包，完成后
        <ToggleWord
          label="完成后打开文件夹"
          on={openAfter}
          onChange={setOpenAfter}
          onText="打开"
          offText="不打开"
        />
        文件夹。关掉程序后
        <ToggleWord
          label="重启后保留这批任务"
          on={remember}
          onChange={setRemember}
          onText="保留"
          offText="不保留"
        />
        这批任务。
      </p>
      {compute === "gpu" ? (
        <p className="mt-3 text-[13px] text-warning-foreground">
          GPU 引擎还没部署，这次会用 CPU。
          <button
            type="button"
            onClick={onOpenSettings}
            className="ml-1 font-medium underline underline-offset-2"
          >
            去部署
          </button>
        </p>
      ) : null}
      {remember ? (
        <p className="mt-2 text-[13px] text-muted-foreground">
          只记路径和选项，不记密码；重启后需要手动继续，计算进度不会恢复。
        </p>
      ) : null}
    </section>
  )
}

/* —— 托盘：这一批的其他压缩包 —— */

function Shelf({
  selectedId,
  onSelect,
}: {
  selectedId: string | null
  onSelect: (id: string | null) => void
}) {
  const runningIndex = QUEUE.findIndex((item) => item.state === "running")
  return (
    <nav
      aria-label="这一批压缩包"
      className="shrink-0 border-t border-foreground/10 bg-(--rd-tray)"
    >
      <div className="flex items-center gap-4 px-5 pt-3 md:px-10">
        <p className="rd-tabular text-[13px] text-muted-foreground">
          这一批 {QUEUE.length} 个，正在处理第 {runningIndex + 1} 个
        </p>
        <Button variant="ghost" size="sm" className="-my-1">
          <Pause data-icon="inline-start" />
          暂停
        </Button>
      </div>
      <ol className="flex gap-2 overflow-x-auto px-5 pt-2 pb-4 md:px-10">
        {QUEUE.map((item) => {
          const { tone, label } = QUEUE_TONE[item.state]
          const active = item.id === selectedId
          return (
            <li key={item.id} className="shrink-0">
              <button
                type="button"
                aria-current={active ? "true" : undefined}
                onClick={() => onSelect(item.id)}
                className={cn(
                  "group flex h-[4.25rem] w-52 items-center gap-3 rounded-md px-3 text-left outline-none",
                  "hover:bg-card focus-visible:ring-2 focus-visible:ring-ring",
                  active &&
                    "bg-card shadow-[0_1px_0_var(--rd-seam)_inset,0_8px_24px_-16px_var(--foreground)]"
                )}
              >
                <MiniStack layers={item.layers} />
                <span className="min-w-0">
                  <span
                    className="block truncate text-sm font-medium"
                    title={item.name}
                  >
                    {item.name}
                  </span>
                  <StatusTag tone={tone} className="mt-1">
                    {label}
                  </StatusTag>
                </span>
              </button>
            </li>
          )
        })}
        <li className="shrink-0">
          <button
            type="button"
            onClick={() => onSelect(null)}
            aria-current={selectedId === null ? "true" : undefined}
            className="flex h-[4.25rem] items-center gap-2 rounded-md border border-dashed border-foreground/25 px-4 text-sm text-muted-foreground outline-none hover:border-foreground/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Plus aria-hidden="true" className="size-4" />
            添加
          </button>
        </li>
      </ol>
    </nav>
  )
}

/** 托盘里的小图标：几层就画几道，颜色跟状态走 */
function MiniStack({ layers }: { layers: Layer[] }) {
  return (
    <span
      aria-hidden="true"
      className="flex w-7 shrink-0 flex-col items-center gap-[3px]"
    >
      {layers.map((layer, i) => (
        <span
          key={layer.id}
          className={cn(
            "h-[5px] rounded-[1px]",
            layer.state === "done" && "bg-(--rd-seam)/55",
            layer.state === "running" && "bg-(--rd-seam)",
            layer.state === "needsPassword" && "bg-warning",
            layer.state === "blocked" && "bg-destructive",
            (layer.state === "waiting" || layer.state === "unknown") &&
              "border border-dashed border-foreground/35"
          )}
          style={{ width: `${100 - i * 18}%` }}
        />
      ))}
    </span>
  )
}
