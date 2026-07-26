"use client"

import * as React from "react"

import { AppShell, NAV_ORDER, type NavId } from "@/components/app-shell"
import { ExtractPage } from "@/components/home/extract-page"
import { PlaceholderPage } from "@/components/home/placeholder-page"
import { cn } from "@/lib/utils"

const PLACEHOLDERS: Record<
  Exclude<NavId, "extract">,
  { eyebrow: string; title: string; description: string }
> = {
  compress: {
    eyebrow: "Pack",
    title: "压缩",
    description:
      "选择文件或文件夹创建 7z / ZIP 归档，可设置压缩级别、密码与文件名加密。",
  },
  dictionary: {
    eyebrow: "Candidates",
    title: "字典",
    description:
      "管理本机全局密码候选集：导入文本字典、单条或粘贴新增、搜索与删除。",
  },
  history: {
    eyebrow: "Recall",
    title: "历史",
    description: "按内容指纹查看已成功验密的归档摘要；不展示路径与明文密码。",
  },
  logs: {
    eyebrow: "Operations",
    title: "日志",
    description: "查看最近运行日志、导出日志包，并备份本机 SQLite 数据库。",
  },
  settings: {
    eyebrow: "Preferences",
    title: "设置",
    description:
      "压缩默认项、字典与日志参数、外部破解工具路径，以及快捷解压入口。",
  },
}

type SlideDirection = "forward" | "backward" | null

function prefersReducedMotion() {
  if (typeof window === "undefined") {
    return false
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

function renderNavPage(nav: NavId) {
  if (nav === "extract") {
    return <ExtractPage />
  }
  return <PlaceholderPage {...PLACEHOLDERS[nav]} />
}

/**
 * 单层水平滑入：旧页立即卸载，只让新页做一次轻位移入场。
 * 避免旧页/新页叠层造成的重影。
 */
export default function Page() {
  const [activeNav, setActiveNav] = React.useState<NavId>("extract")
  const [direction, setDirection] = React.useState<SlideDirection>(null)
  const [transitionId, setTransitionId] = React.useState(0)

  const handleNavChange = React.useCallback(
    (next: NavId) => {
      if (next === activeNav) {
        return
      }

      if (prefersReducedMotion()) {
        setDirection(null)
        setActiveNav(next)
        setTransitionId((id) => id + 1)
        return
      }

      const from = NAV_ORDER.indexOf(activeNav)
      const to = NAV_ORDER.indexOf(next)
      setDirection(to >= from ? "forward" : "backward")
      setActiveNav(next)
      setTransitionId((id) => id + 1)
    },
    [activeNav]
  )

  return (
    <AppShell activeNav={activeNav} onNavChange={handleNavChange}>
      <div className="relative h-full min-h-0 overflow-hidden">
        <div
          key={`${activeNav}-${transitionId}`}
          className={cn(
            "h-full min-h-0",
            direction === "forward" &&
              "animate-slide-in-from-right motion-safe-only",
            direction === "backward" &&
              "animate-slide-in-from-left motion-safe-only"
          )}
        >
          {renderNavPage(activeNav)}
        </div>
      </div>
    </AppShell>
  )
}
