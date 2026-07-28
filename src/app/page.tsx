"use client"

import * as React from "react"

import { AppShell, NAV_ORDER, type NavId } from "@/components/app-shell"
import { ClientLoggingBridge } from "@/components/client-logging-bridge"
import {
  CompressPage,
  createCompressionDraft,
} from "@/components/home/compress-page"
import { DictionaryPage } from "@/components/home/dictionary-page"
import { ExtractPage } from "@/components/home/extract-page"
import { HistoryPage } from "@/components/home/history-page"
import { LogsPage } from "@/components/home/logs-page"
import {
  SettingsPage,
  type SettingsCategory,
} from "@/components/home/settings-page"
import { cn } from "@/lib/utils"

type SlideDirection = "forward" | "backward" | null

function prefersReducedMotion() {
  if (typeof window === "undefined") {
    return false
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

/**
 * 单层水平滑入：旧页立即卸载，只让新页做一次轻位移入场。
 * 避免旧页/新页叠层造成的重影。
 */
export default function Page() {
  const [activeNav, setActiveNav] = React.useState<NavId>("extract")
  const [direction, setDirection] = React.useState<SlideDirection>(null)
  const [transitionId, setTransitionId] = React.useState(0)
  const [compressionDraft, setCompressionDraft] = React.useState(
    createCompressionDraft
  )
  const [settingsCategory, setSettingsCategory] =
    React.useState<SettingsCategory>("engine")
  const [returnToCompression, setReturnToCompression] = React.useState(false)

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

  const handleDockNavChange = React.useCallback(
    (next: NavId) => {
      if (next === "settings") {
        setSettingsCategory("engine")
        setReturnToCompression(false)
      }
      handleNavChange(next)
    },
    [handleNavChange]
  )

  const handleOpenAiSettings = React.useCallback(() => {
    setSettingsCategory("ai")
    setReturnToCompression(true)
    handleNavChange("settings")
  }, [handleNavChange])

  const handleReturnToCompression = React.useCallback(() => {
    setReturnToCompression(false)
    handleNavChange("compress")
  }, [handleNavChange])

  const page = (() => {
    if (activeNav === "extract") {
      return <ExtractPage />
    }
    if (activeNav === "compress") {
      return (
        <CompressPage
          draft={compressionDraft}
          onDraftChange={setCompressionDraft}
          onOpenAiSettings={handleOpenAiSettings}
        />
      )
    }
    if (activeNav === "dictionary") {
      return <DictionaryPage />
    }
    if (activeNav === "settings") {
      return (
        <SettingsPage
          initialCategory={settingsCategory}
          onReturnToCompression={
            returnToCompression ? handleReturnToCompression : undefined
          }
        />
      )
    }
    if (activeNav === "logs") {
      return <LogsPage />
    }
    if (activeNav === "history") {
      return <HistoryPage />
    }
    return null
  })()

  return (
    <>
      <ClientLoggingBridge />
      <AppShell activeNav={activeNav} onNavChange={handleDockNavChange}>
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
            {page}
          </div>
        </div>
      </AppShell>
    </>
  )
}
