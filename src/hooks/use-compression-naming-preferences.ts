"use client"

import * as React from "react"

import {
  parseAiReferenceExtensions,
  type CompressionDraft,
} from "@/lib/compression-draft"
import { isDesktopRuntime } from "@/lib/dictionary"
import {
  getSettings,
  updateSettings,
  type CompressionNamingSettings,
} from "@/lib/settings"

export type CompressionNamingPreferencesController = {
  ready: boolean
  error: string | null
  change: (selectedExtensions: string[], customExtensions: string[]) => void
  setEnabled: (
    key: "useAiRename" | "useAiFileReference",
    enabled: boolean
  ) => void
  retry: () => void
}

export function useCompressionNamingPreferences(
  draft: CompressionDraft,
  onDraftChange: React.Dispatch<React.SetStateAction<CompressionDraft>>,
  isDraftLocked: () => boolean
): CompressionNamingPreferencesController {
  const [ready, setReady] = React.useState(!isDesktopRuntime())
  const [error, setError] = React.useState<string | null>(null)
  const [loadVersion, setLoadVersion] = React.useState(0)
  const loaded = React.useRef(false)
  const latest = React.useRef<CompressionNamingSettings>({
    useAiRename: draft.useAiRename,
    useAiFileReference: draft.useAiFileReference,
    selectedExtensions: parseAiReferenceExtensions(draft.aiReferenceExtensions),
    customExtensions: draft.aiCustomReferenceExtensions,
  })
  const writes = React.useRef<Promise<unknown>>(Promise.resolve())

  React.useEffect(() => {
    if (!isDesktopRuntime() || loaded.current) return
    let disposed = false
    void getSettings()
      .then((settings) => {
        if (disposed) return
        if (settings.compressionNaming) {
          const preferences = {
            ...settings.compressionNaming,
            useAiRename: settings.compressionNaming.useAiRename ?? false,
            useAiFileReference:
              settings.compressionNaming.useAiFileReference ?? false,
          }
          latest.current = preferences
          onDraftChange((current) => ({
            ...current,
            useAiRename: preferences.useAiRename,
            useAiFileReference: preferences.useAiFileReference,
            aiReferenceExtensions: preferences.selectedExtensions.join(", "),
            aiCustomReferenceExtensions: preferences.customExtensions,
          }))
        }
        loaded.current = true
        setReady(true)
        setError(null)
      })
      .catch(() => {
        if (!disposed) setError("无法读取 AI 命名设置，请重试。")
      })
    return () => {
      disposed = true
    }
  }, [loadVersion, onDraftChange])

  const save = React.useCallback((preferences: CompressionNamingSettings) => {
    latest.current = preferences
    if (!isDesktopRuntime()) return
    const request = writes.current
      .catch(() => {})
      .then(() =>
        updateSettings({ kind: "compressionNaming", value: preferences })
      )
    writes.current = request
    void request.then(
      () => {
        if (latest.current === preferences) setError(null)
      },
      () => {
        if (latest.current === preferences) {
          setError("AI 命名设置保存失败，请重试保存。")
        }
      }
    )
  }, [])

  const change = React.useCallback(
    (selectedExtensions: string[], customExtensions: string[]) => {
      if (!ready || isDraftLocked()) return
      onDraftChange((current) => ({
        ...current,
        aiReferenceExtensions: selectedExtensions.join(", "),
        aiCustomReferenceExtensions: customExtensions,
      }))
      save({ ...latest.current, selectedExtensions, customExtensions })
    },
    [isDraftLocked, onDraftChange, ready, save]
  )

  const setEnabled = React.useCallback(
    (key: "useAiRename" | "useAiFileReference", enabled: boolean) => {
      if (!ready || isDraftLocked()) return
      onDraftChange((current) => ({ ...current, [key]: enabled }))
      save({ ...latest.current, [key]: enabled })
    },
    [isDraftLocked, onDraftChange, ready, save]
  )

  const retry = React.useCallback(() => {
    setError(null)
    if (loaded.current) save(latest.current)
    else setLoadVersion((current) => current + 1)
  }, [save])

  return { ready, error, change, setEnabled, retry }
}
