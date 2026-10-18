"use client"

import * as React from "react"

import {
  previewAiArchiveReference,
  type AiReferencePreviewFile,
} from "@/lib/ai"
import { isDesktopRuntime } from "@/lib/dictionary"
import { compressionSourceIdentity } from "@/lib/compression-path"

export type AiReferencePreviewController = {
  supported: boolean
  loading: boolean
  files: AiReferencePreviewFile[]
  selectedPaths: string[]
  setSelected: (path: string, selected: boolean) => void
  error: string | null
  refresh: () => void
}

export function useAiReferencePreview(
  sources: string[],
  extensions: string,
  enabled: boolean,
  isLocked?: () => boolean
): AiReferencePreviewController {
  const supported = isDesktopRuntime()
  const requestKey =
    enabled && supported && sources.length > 0 && extensions.trim()
      ? JSON.stringify({ sources, extensions })
      : ""
  const [version, setVersion] = React.useState(0)
  const [excludedPaths, setExcludedPaths] = React.useState<Set<string>>(
    () => new Set()
  )
  const [result, setResult] = React.useState<{
    key: string
    version: number
    files: AiReferencePreviewFile[]
    error: string | null
  } | null>(null)

  React.useEffect(() => {
    let disposed = false
    const request = requestKey
      ? previewAiArchiveReference(JSON.parse(requestKey))
      : Promise.resolve([])
    void request.then(
      (files) => {
        if (!disposed)
          setResult({ key: requestKey, version, files, error: null })
      },
      (reason) => {
        if (!disposed)
          setResult({
            key: requestKey,
            version,
            files: [],
            error: reason instanceof Error ? reason.message : String(reason),
          })
      }
    )
    return () => {
      disposed = true
    }
  }, [requestKey, version])

  const refresh = React.useCallback(() => {
    if (!isLocked?.()) setVersion((current) => current + 1)
  }, [isLocked])
  const current = result?.key === requestKey && result.version === version
  const files = requestKey && current ? result.files : []
  return {
    supported,
    loading: Boolean(requestKey) && !current,
    files,
    selectedPaths: files
      .filter(
        (file) => !excludedPaths.has(compressionSourceIdentity(file.sourcePath))
      )
      .map((file) => file.sourcePath),
    setSelected: (path, selected) => {
      if (isLocked?.() || !files.some((file) => file.sourcePath === path))
        return
      setExcludedPaths((previous) => {
        const identity = compressionSourceIdentity(path)
        if (previous.has(identity) === !selected) return previous
        const next = new Set(previous)
        if (selected) next.delete(identity)
        else next.add(identity)
        return next
      })
    },
    error: requestKey && current ? result.error : null,
    refresh,
  }
}
