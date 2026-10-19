"use client"

import * as React from "react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

import { type LogEvent, LOGS } from "./mock-data"
import { Lead, RdStage } from "./parts"
import { Token, ToggleWord } from "./sentence"

const SCOPE = [
  { value: "attention", label: "需要注意的" },
  { value: "error", label: "出错的" },
  { value: "all", label: "全部" },
] as const

/**
 * 日志按任务讲成一段段经过，而不是一张滚动的表。
 * 默认只给需要注意的事件：来日志页通常是为了排查问题。
 */
export function LogsView() {
  const [scope, setScope] =
    React.useState<(typeof SCOPE)[number]["value"]>("attention")
  const [auto, setAuto] = React.useState(true)
  const errors = LOGS.filter((e) => e.level === "error").length
  const warns = LOGS.filter((e) => e.level === "warn").length

  const events = LOGS.filter((e) =>
    scope === "all"
      ? true
      : scope === "error"
        ? e.level === "error"
        : e.level !== "info"
  )
  const groups = new Map<string, LogEvent[]>()
  for (const event of events) {
    const key = event.task ?? "程序本身"
    groups.set(key, [...(groups.get(key) ?? []), event])
  }

  return (
    <RdStage label="日志">
      <Lead sub="密码和候选内容在写入日志前就已去掉。">
        最近有 {errors} 个错误、{warns} 个提醒。
      </Lead>

      <p className="mt-8 max-w-3xl text-base leading-[2.05]">
        显示
        <Token
          label="显示范围"
          value={scope}
          options={SCOPE}
          onChange={setScope}
        />
        事件，
        <ToggleWord
          label="自动刷新"
          on={auto}
          onChange={setAuto}
          onText="自动刷新"
          offText="不自动刷新"
        />
        <span className="rd-tabular text-muted-foreground">
          （上次 20:58:12）
        </span>
        。
        <span className="ml-2 inline-flex gap-1 align-middle">
          <Button variant="ghost" size="sm">
            打开日志文件夹
          </Button>
          <Button variant="ghost" size="sm">
            导出日志
          </Button>
        </span>
      </p>

      <div className="mt-12 flex flex-col gap-12">
        {[...groups.entries()].map(([task, items]) => (
          <section
            key={task}
            aria-label={task}
            className="grid gap-x-12 gap-y-3 md:grid-cols-[14rem_minmax(0,1fr)]"
          >
            <h2
              className="truncate text-[17px] font-semibold md:pt-0.5"
              title={task}
            >
              {task}
            </h2>
            <ol className="flex flex-col gap-3 border-l border-foreground/15">
              {items.map((event) => (
                <li key={event.id} className="relative pl-6">
                  <span
                    aria-hidden="true"
                    className={cn(
                      "absolute top-[9px] -left-[4px] size-[7px] rounded-full ring-4 ring-background",
                      event.level === "error"
                        ? "bg-destructive"
                        : event.level === "warn"
                          ? "bg-warning"
                          : "bg-foreground/35"
                    )}
                  />
                  <p className="text-[15px] leading-relaxed">
                    <span
                      className={cn(
                        "mr-2 font-semibold",
                        event.level === "error" && "text-destructive",
                        event.level === "warn" && "text-warning-foreground"
                      )}
                    >
                      {event.level === "error"
                        ? "出错"
                        : event.level === "warn"
                          ? "注意"
                          : event.stage}
                    </span>
                    {event.message}
                  </p>
                  <p className="rd-tabular mt-0.5 text-xs text-muted-foreground">
                    {event.time} · {event.stage}
                  </p>
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>
    </RdStage>
  )
}
