"use client"

import * as React from "react"

import type { NavId } from "@/components/app-shell"
import { WorkbenchHeader } from "./workbench-header"

import { CompressView } from "./compress-view"
import { DictionaryView } from "./dictionary-view"
import { ExtractView } from "./extract-view"
import { HistoryView } from "./history-view"
import { LogsView } from "./logs-view"
import { SettingsView } from "./settings-view"

import "./redesign.css"

/**
 * 新界面预览。没有侧栏、没有分栏面板：
 * 顶部一行文字导航，下面整片是当前任务的舞台。
 */
export function RedesignApp() {
  const [active, setActive] = React.useState<NavId>("extract")

  return (
    <div className="rd flex h-svh min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <WorkbenchHeader active={active} onSelect={setActive} />
      <main className="min-h-0 min-w-0 flex-1 overflow-hidden">
        {active === "extract" ? (
          <ExtractView
            onOpenDictionary={() => setActive("dictionary")}
            onOpenSettings={() => setActive("settings")}
          />
        ) : null}
        {active === "compress" ? <CompressView /> : null}
        {active === "dictionary" ? <DictionaryView /> : null}
        {active === "history" ? <HistoryView /> : null}
        {active === "logs" ? <LogsView /> : null}
        {active === "settings" ? <SettingsView /> : null}
      </main>
    </div>
  )
}
