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
  type SettingsPageHandle,
} from "@/components/home/settings-page"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

type SlideDirection = "forward" | "backward" | null
type SettingsReturnTarget = "extract" | "compress"

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
  const settingsPageRef = React.useRef<SettingsPageHandle>(null)
  const [activeNav, setActiveNav] = React.useState<NavId>("extract")
  const [direction, setDirection] = React.useState<SlideDirection>(null)
  const [transitionId, setTransitionId] = React.useState(0)
  const [compressionDraft, setCompressionDraft] = React.useState(
    createCompressionDraft
  )
  const [settingsCategory, setSettingsCategory] =
    React.useState<SettingsCategory>("engine")
  const [settingsReturnTarget, setSettingsReturnTarget] =
    React.useState<SettingsReturnTarget | null>(null)
  const [settingsAiDirty, setSettingsAiDirty] = React.useState(false)
  const [pendingNav, setPendingNav] = React.useState<NavId | null>(null)
  const [navSaveBusy, setNavSaveBusy] = React.useState(false)

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

  const completeDockNavChange = React.useCallback(
    (next: NavId) => {
      if (next === "settings") {
        setSettingsCategory("engine")
        setSettingsReturnTarget(null)
      }
      handleNavChange(next)
    },
    [handleNavChange]
  )

  const handleDockNavChange = React.useCallback(
    (next: NavId) => {
      if (next === activeNav) {
        return
      }
      if (activeNav === "settings" && settingsAiDirty) {
        setPendingNav(next)
        return
      }
      completeDockNavChange(next)
    },
    [activeNav, completeDockNavChange, settingsAiDirty]
  )

  const handleSaveAndNavigate = React.useCallback(async () => {
    if (!pendingNav || navSaveBusy) {
      return
    }
    const target = pendingNav
    setNavSaveBusy(true)
    const saved = await settingsPageRef.current?.saveAiChanges()
    setNavSaveBusy(false)
    if (saved !== false) {
      setPendingNav(null)
      setSettingsAiDirty(false)
      completeDockNavChange(target)
    }
  }, [completeDockNavChange, navSaveBusy, pendingNav])

  const handleOpenAiSettings = React.useCallback(() => {
    setSettingsCategory("ai")
    setSettingsReturnTarget("compress")
    handleNavChange("settings")
  }, [handleNavChange])

  const handleOpenEngineSettings = React.useCallback(() => {
    setSettingsCategory("engine")
    setSettingsReturnTarget("extract")
    handleNavChange("settings")
  }, [handleNavChange])

  const handleReturnFromSettings = React.useCallback(() => {
    if (!settingsReturnTarget) {
      return
    }
    const target = settingsReturnTarget
    setSettingsReturnTarget(null)
    handleNavChange(target)
  }, [handleNavChange, settingsReturnTarget])

  const page = (() => {
    if (activeNav === "extract") {
      return <ExtractPage onOpenEngineSettings={handleOpenEngineSettings} />
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
          ref={settingsPageRef}
          initialCategory={settingsCategory}
          onAiDirtyChange={setSettingsAiDirty}
          returnAction={
            settingsReturnTarget
              ? {
                  label:
                    settingsReturnTarget === "extract"
                      ? "返回解压"
                      : "返回压缩",
                  onClick: handleReturnFromSettings,
                }
              : undefined
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
      <AlertDialog
        open={pendingNav !== null}
        onOpenChange={(open) => {
          if (!open && !navSaveBusy) {
            setPendingNav(null)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>保存 AI 设置更改？</AlertDialogTitle>
            <AlertDialogDescription>
              当前配置或重命名提示词有未保存更改。离开后，这些更改将丢失。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={navSaveBusy}>
              继续编辑
            </AlertDialogCancel>
            <Button
              type="button"
              variant="outline"
              disabled={navSaveBusy}
              onClick={() => {
                if (!pendingNav) {
                  return
                }
                const target = pendingNav
                setPendingNav(null)
                setSettingsAiDirty(false)
                completeDockNavChange(target)
              }}
            >
              放弃更改
            </Button>
            <AlertDialogAction
              disabled={navSaveBusy}
              onClick={(event) => {
                event.preventDefault()
                void handleSaveAndNavigate()
              }}
            >
              {navSaveBusy ? "正在保存…" : "保存并离开"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
