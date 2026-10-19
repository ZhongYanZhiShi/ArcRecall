"use client"

import { FileUp, Search, Trash2 } from "lucide-react"
import * as React from "react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

import { DICTIONARY_ROWS, DICTIONARY_TOTAL } from "./mock-data"
import { Lead, NUMBER, RdStage } from "./parts"

/**
 * 字典不是表格，是一面写满候选密码的墙。
 * 搜索时匹配的词保持清晰，其余淡下去；点一下词就选中，可以批量删。
 */
export function DictionaryView() {
  const [query, setQuery] = React.useState("")
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(
    () => new Set()
  )
  const q = query.trim().toLowerCase()

  const toggle = (word: string) =>
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(word)) next.delete(word)
      else next.add(word)
      return next
    })

  const matches = DICTIONARY_ROWS.filter(
    (w) => !q || w.toLowerCase().includes(q)
  ).length

  return (
    <RdStage label="字典">
      <Lead sub="解压时会逐条尝试。只保存在这台电脑上，不记录它们来自哪个文件。">
        <span className="rd-tabular">{NUMBER.format(DICTIONARY_TOTAL)}</span>{" "}
        条候选密码。
      </Lead>

      <div className="mt-10 flex max-w-xl items-center gap-3 border-b-2 border-foreground/15 focus-within:border-primary">
        <Search
          aria-hidden="true"
          className="size-5 shrink-0 text-muted-foreground"
        />
        <input
          aria-label="搜索候选密码"
          placeholder="找一找某条密码在不在里面"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-12 min-w-0 flex-1 bg-transparent text-lg outline-none placeholder:text-muted-foreground/70"
        />
        {q ? (
          <span className="rd-tabular shrink-0 text-sm text-muted-foreground">
            {matches} 条匹配
          </span>
        ) : null}
      </div>

      <ul
        aria-label="候选密码"
        className="mt-8 flex max-w-5xl flex-wrap gap-x-2 gap-y-2.5 font-mono text-[17px] leading-none"
      >
        {DICTIONARY_ROWS.map((word) => {
          const hit = !q || word.toLowerCase().includes(q)
          const isSelected = selected.has(word)
          return (
            <li key={word}>
              <button
                type="button"
                aria-pressed={isSelected}
                onClick={() => toggle(word)}
                className={cn(
                  "rounded-sm px-2 py-1.5 transition-colors outline-none",
                  "hover:bg-(--rd-stratum-0) focus-visible:ring-2 focus-visible:ring-ring",
                  hit ? "text-foreground" : "text-foreground/20",
                  q && hit && "bg-(--rd-stratum-1)",
                  isSelected &&
                    "bg-foreground text-background hover:bg-foreground"
                )}
              >
                {word}
              </button>
            </li>
          )
        })}
        <li className="px-2 py-1.5 font-sans text-sm text-muted-foreground">
          …以及另外 {NUMBER.format(DICTIONARY_TOTAL - DICTIONARY_ROWS.length)}{" "}
          条
        </li>
      </ul>

      {selected.size > 0 ? (
        <div className="mt-6 flex items-center gap-3">
          <Button variant="destructive">
            <Trash2 data-icon="inline-start" />
            删除选中的 {selected.size} 条
          </Button>
          <Button variant="ghost" onClick={() => setSelected(new Set())}>
            取消选择
          </Button>
        </div>
      ) : null}

      <section aria-labelledby="add-title" className="mt-16 max-w-2xl">
        <h2
          id="add-title"
          className="text-sm font-medium text-muted-foreground"
        >
          添加新的候选
        </h2>
        <textarea
          aria-labelledby="add-title"
          aria-describedby="add-hint"
          rows={3}
          placeholder={"每行一条，直接粘贴也可以"}
          className="mt-3 w-full resize-y border-0 border-b-2 border-foreground/15 bg-transparent py-2 font-mono text-[17px] leading-relaxed outline-none placeholder:font-sans placeholder:text-muted-foreground/70 focus-visible:border-primary"
        />
        <p id="add-hint" className="mt-2 text-[13px] text-muted-foreground">
          按原样保存，前后空格也算；已有的会自动跳过。
        </p>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Button size="lg">加进字典</Button>
          <Button size="lg" variant="ghost">
            <FileUp data-icon="inline-start" />
            从文本文件导入
          </Button>
        </div>
      </section>
    </RdStage>
  )
}
