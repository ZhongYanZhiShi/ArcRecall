"use client"

import dynamic from "next/dynamic"
import * as React from "react"

import { AppShell, NAV_ORDER, type NavId } from "@/components/app-shell"
import { ClientLoggingBridge } from "@/components/client-logging-bridge"
import {
  CompressPageLoading,
  DictionaryPageLoading,
  ExtractPageLoading,
  HistoryPageLoading,
  LogsPageLoading,
  SettingsPageLoading,
} from "@/components/home/workbench-loading"
import type {
  SettingsCategory,
  SettingsPageHandle,
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
import {
  createCompressionDraft,
  type CompressionDraft,
} from "@/lib/compression-draft"
import { cn } from "@/lib/utils"

const loadExtractPage = () => import("@/components/home/extract-page")
const loadCompressPage = () => import("@/components/home/compress-page")
const loadDictionaryPage = () => import("@/components/home/dictionary-page")
const loadHistoryPage = () => import("@/components/home/history-page")
const loadLogsPage = () => import("@/components/home/logs-page")
const loadSettingsPage = () => import("@/components/home/settings-page")

const ExtractPage = dynamic(
  () => loadExtractPage().then((module) => module.ExtractPage),
  { loading: ExtractPageLoading }
)
const CompressPage = dynamic<{
  draft: CompressionDraft
  onDraftChange: React.Dispatch<React.SetStateAction<CompressionDraft>>
  onOpenAiSettings: () => void
}>(() => loadCompressPage().then((module) => module.CompressPage), {
  loading: CompressPageLoading,
})
const DictionaryPage = dynamic(
  () => loadDictionaryPage().then((module) => module.DictionaryPage),
  { loading: DictionaryPageLoading }
)
const HistoryPage = dynamic(
  () => loadHistoryPage().then((module) => module.HistoryPage),
  { loading: HistoryPageLoading }
)
const LogsPage = dynamic(
  () => loadLogsPage().then((module) => module.LogsPage),
  { loading: LogsPageLoading }
)
const SettingsPage = dynamic<
  React.ComponentPropsWithRef<
    typeof import("@/components/home/settings-page").SettingsPage
  >
>(() => loadSettingsPage().then((module) => module.SettingsPage), {
  loading: SettingsPageLoading,
})

const NAV_PAGE_LOADERS: Record<NavId, () => Promise<unknown>> = {
  extract: loadExtractPage,
  compress: loadCompressPage,
  dictionary: loadDictionaryPage,
  history: loadHistoryPage,
  logs: loadLogsPage,
  settings: loadSettingsPage,
}

function preloadNavPage(nav: NavId) {
  void NAV_PAGE_LOADERS[nav]().catch(() => undefined)
}

function preloadAllNavPages() {
  for (const nav of NAV_ORDER) {
    preloadNavPage(nav)
  }
}

type SlideDirection = "forward" | "backward" | null
type SettingsReturnTarget = "extract" | "compress"

function prefersReducedMotion() {
  if (typeof window === "undefined") {
    return false
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

/**
 * 已访问页面通过 Activity 保留 DOM 与本地状态；隐藏时 React 会暂停
 * Effect，重新显示时恢复监听与轮询。入场动画仅作用于当前可见层。
 */
export default function Page() {
  const [databaseRevision, setDatabaseRevision] = React.useState(0)
  const settingsPageRef = React.useRef<SettingsPageHandle>(null)
  const [activeNav, setActiveNav] = React.useState<NavId>("extract")
  const [visitedNavs, setVisitedNavs] = React.useState<ReadonlySet<NavId>>(
    () => new Set<NavId>(["extract"])
  )
  const [direction, setDirection] = React.useState<SlideDirection>(null)
  const [compressionDraft, setCompressionDraft] = React.useState(
    createCompressionDraft
  )
  const [settingsCategory, setSettingsCategory] =
    React.useState<SettingsCategory>("engine")
  const [settingsReturnTarget, setSettingsReturnTarget] =
    React.useState<SettingsReturnTarget | null>(null)
  const [settingsCategoryRequestId, setSettingsCategoryRequestId] =
    React.useState(0)
  const [settingsAiDirty, setSettingsAiDirty] = React.useState(false)
  const [pendingNav, setPendingNav] = React.useState<NavId | null>(null)
  const [navSaveBusy, setNavSaveBusy] = React.useState(false)

  React.useEffect(() => {
    if ("requestIdleCallback" in window) {
      const idleId = window.requestIdleCallback(preloadAllNavPages, {
        timeout: 1_500,
      })
      return () => window.cancelIdleCallback(idleId)
    }
    const timeout = globalThis.setTimeout(preloadAllNavPages, 400)
    return () => globalThis.clearTimeout(timeout)
  }, [])

  const handleNavChange = React.useCallback(
    (next: NavId) => {
      if (next === activeNav) {
        return
      }

      if (prefersReducedMotion()) {
        setDirection(null)
        setVisitedNavs((current) => {
          if (current.has(next)) {
            return current
          }
          const updated = new Set(current)
          updated.add(next)
          return updated
        })
        setActiveNav(next)
        return
      }

      const from = NAV_ORDER.indexOf(activeNav)
      const to = NAV_ORDER.indexOf(next)
      setDirection(to >= from ? "forward" : "backward")
      setVisitedNavs((current) => {
        if (current.has(next)) {
          return current
        }
        const updated = new Set(current)
        updated.add(next)
        return updated
      })
      setActiveNav(next)
    },
    [activeNav]
  )

  const completeDockNavChange = React.useCallback(
    (next: NavId) => {
      if (next === "settings") {
        setSettingsCategory("engine")
        setSettingsReturnTarget(null)
        setSettingsCategoryRequestId((id) => id + 1)
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
    setSettingsCategoryRequestId((id) => id + 1)
    handleNavChange("settings")
  }, [handleNavChange])

  const handleOpenEngineSettings = React.useCallback(() => {
    setSettingsCategory("engine")
    setSettingsReturnTarget("extract")
    setSettingsCategoryRequestId((id) => id + 1)
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

  const renderActivity = (nav: NavId, content: React.ReactNode) => {
    if (!visitedNavs.has(nav)) {
      return null
    }
    const active = activeNav === nav
    return (
      <React.Activity
        key={nav}
        name={`workbench-${nav}`}
        mode={active ? "visible" : "hidden"}
      >
        <div
          className={cn(
            "h-full min-h-0",
            active &&
              direction === "forward" &&
              "animate-slide-in-from-right motion-safe-only",
            active &&
              direction === "backward" &&
              "animate-slide-in-from-left motion-safe-only"
          )}
        >
          {content}
        </div>
      </React.Activity>
    )
  }

  return (
    <>
      <ClientLoggingBridge />
      <AppShell
        activeNav={activeNav}
        onNavChange={handleDockNavChange}
        onNavPreload={preloadNavPage}
      >
        <div className="relative h-full min-h-0 overflow-hidden">
          {renderActivity(
            "extract",
            <ExtractPage onOpenEngineSettings={handleOpenEngineSettings} />
          )}
          {renderActivity(
            "compress",
            <CompressPage
              draft={compressionDraft}
              onDraftChange={setCompressionDraft}
              onOpenAiSettings={handleOpenAiSettings}
            />
          )}
          {renderActivity(
            "dictionary",
            <DictionaryPage key={databaseRevision} />
          )}
          {renderActivity("history", <HistoryPage key={databaseRevision} />)}
          {renderActivity("logs", <LogsPage />)}
          {renderActivity(
            "settings",
            <SettingsPage
              onDatabaseRestored={() =>
                setDatabaseRevision((revision) => revision + 1)
              }
              ref={settingsPageRef}
              initialCategory={settingsCategory}
              categoryRequestId={settingsCategoryRequestId}
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
          )}
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
