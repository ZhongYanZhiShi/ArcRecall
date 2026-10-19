"use client"

import {
  ArrowRight,
  Copy,
  Eye,
  EyeOff,
  FolderOpen,
  Search,
  Trash2,
} from "lucide-react"
import * as React from "react"

import { Button } from "@/components/ui/button"

import { HISTORY, type HistoryRow } from "./mock-data"
import { Lead, PathText, RdStage } from "./parts"

/** 示例数据按天归组；真实数据接入时按最近解压时间分组 */
const DAYS: { label: string; ids: string[] }[] = [
  { label: "今天", ids: ["h1", "h2"] },
  { label: "10月17日", ids: ["h3"] },
  { label: "9月", ids: ["h4", "h5"] },
]

/**
 * 历史是一本按日期翻的账：左边日期，右边那天打开过的压缩包，
 * 每条一句话写清楚从哪里、解到哪里、用的什么密码。
 */
export function HistoryView() {
  const [query, setQuery] = React.useState("")
  const q = query.trim().toLowerCase()
  const match = (row: HistoryRow) =>
    !q ||
    [row.name, row.archivePath, row.outputPath].some((v) =>
      v.toLowerCase().includes(q)
    )

  const groups = DAYS.map((day) => ({
    ...day,
    rows: day.ids
      .map((id) => HISTORY.find((row) => row.id === id))
      .filter((row): row is HistoryRow => !!row && match(row)),
  })).filter((day) => day.rows.length > 0)

  return (
    <RdStage label="历史">
      <Lead sub="按文件内容记住，改了名字再解压也能自动用上。密码加密保存，显示 30 秒后自动隐藏。">
        打开过 {HISTORY.length} 个压缩包。
      </Lead>

      <div className="mt-10 flex max-w-xl items-center gap-3 border-b-2 border-foreground/15 focus-within:border-primary">
        <Search
          aria-hidden="true"
          className="size-5 shrink-0 text-muted-foreground"
        />
        <input
          aria-label="按名称或路径搜索"
          placeholder="按名称、压缩包位置或解压位置找"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-12 min-w-0 flex-1 bg-transparent text-lg outline-none placeholder:text-muted-foreground/70"
        />
      </div>

      <div className="mt-12 flex flex-col gap-12">
        {groups.map((day) => (
          <section
            key={day.label}
            aria-label={day.label}
            className="grid gap-x-12 gap-y-4 md:grid-cols-[8rem_minmax(0,1fr)]"
          >
            <h2 className="text-xl font-semibold tracking-tight text-foreground/80 md:sticky md:top-0 md:self-start">
              {day.label}
            </h2>
            <ol className="flex flex-col gap-8">
              {day.rows.map((row) => (
                <Entry key={row.id} row={row} />
              ))}
            </ol>
          </section>
        ))}
        {groups.length === 0 ? (
          <p className="text-[15px] text-muted-foreground">
            没有和“{query}”对得上的记录。
          </p>
        ) : null}
      </div>

      <div className="mt-20 border-t border-foreground/10 pt-6">
        <Button
          variant="ghost"
          className="-ml-3 text-destructive hover:text-destructive"
        >
          <Trash2 data-icon="inline-start" />
          清空全部历史
        </Button>
      </div>
    </RdStage>
  )
}

function Entry({ row }: { row: HistoryRow }) {
  const [visible, setVisible] = React.useState(false)
  const missing = !row.archivePath
  const time = row.lastUsed.split(" ").at(-1)

  return (
    <li className="group grid gap-x-6 gap-y-2 lg:grid-cols-[minmax(0,1fr)_auto]">
      <div className="min-w-0">
        <p className="flex flex-wrap items-baseline gap-x-3">
          <span className="text-[17px] font-semibold">{row.name}</span>
          <span className="rd-tabular text-[13px] text-muted-foreground">
            {time} · {row.format} · {row.size}
            {row.volumes > 1 ? ` · ${row.volumes} 卷` : ""}
          </span>
        </p>
        {missing ? (
          <p className="mt-1 text-[13px] text-muted-foreground">
            旧版本留下的记录，没有位置信息；下次成功解压后会补上。
          </p>
        ) : (
          <p className="mt-1 flex min-w-0 items-center gap-2">
            <PathText className="min-w-0 shrink">{row.archivePath}</PathText>
            <ArrowRight
              aria-label="解压到"
              className="size-3 shrink-0 text-muted-foreground"
            />
            <PathText className="min-w-0 shrink">{row.outputPath}</PathText>
          </p>
        )}
      </div>
      <div className="flex items-center gap-1 lg:self-center">
        <code
          className="mr-1 min-w-24 rounded-sm px-2 py-1 font-mono text-[15px]"
          aria-label={visible ? undefined : "密码已隐藏"}
        >
          {visible ? row.password : "••••••••"}
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
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="打开解压位置"
          disabled={missing}
        >
          <FolderOpen />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`删除 ${row.name} 的记录`}
          className="opacity-50 group-hover:opacity-100 focus-visible:opacity-100"
        >
          <Trash2 />
        </Button>
      </div>
    </li>
  )
}
