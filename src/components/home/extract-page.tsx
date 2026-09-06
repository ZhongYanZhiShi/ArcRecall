"use client"

import { getCurrentWebview } from "@tauri-apps/api/webview"
import * as React from "react"

import {
  ExtractPageView,
  type OutputMode,
} from "@/components/home/extract-page-view"
import { countDictionary, isDesktopRuntime } from "@/lib/dictionary"
import {
  analyzeArchive,
  cancelRecovery,
  getRecoveryCapabilities,
  getRecoveryStatus,
  openOutputDirectory,
  pickArchivePath,
  pickOutputDirectory,
  startRecovery,
  type ArchiveAnalysis,
  type RecoveryCapabilities,
  type RecoveryComputeMode,
  type RecoveryTaskStatus,
} from "@/lib/recovery"
import { resolveDroppedArchivePath } from "@/lib/recovery-input"
import { recoveryTaskAttachmentId } from "@/lib/recovery-task-attachment"
import { copySensitiveText } from "@/lib/sensitive-clipboard"
import { getSettings, setSettings } from "@/lib/settings"
import { useDesktopTask } from "@/hooks/use-desktop-task"

export function ExtractPage({
  onOpenEngineSettings,
}: {
  onOpenEngineSettings: () => void
}) {
  const [outputMode, setOutputMode] = React.useState<OutputMode>("sibling")
  const [outputDir, setOutputDir] = React.useState<string | null>(null)
  const [openWhenDone, setOpenWhenDone] = React.useState(true)
  const [recursive, setRecursive] = React.useState(true)
  const [computeMode, setComputeMode] =
    React.useState<RecoveryComputeMode>("gpuPreferred")
  const [computeModeBusy, setComputeModeBusy] = React.useState(false)
  const [capabilities, setCapabilities] =
    React.useState<RecoveryCapabilities | null>(null)
  const [capabilityError, setCapabilityError] = React.useState<string | null>(
    null
  )
  const [dragOver, setDragOver] = React.useState(false)
  const [optionsOpen, setOptionsOpen] = React.useState(false)
  const [analysis, setAnalysis] = React.useState<ArchiveAnalysis | null>(null)
  const [knownPassword, setKnownPassword] = React.useState("")
  const [showKnownPassword, setShowKnownPassword] = React.useState(false)
  const [showRecoveredPassword, setShowRecoveredPassword] =
    React.useState(false)
  const [passwordCopied, setPasswordCopied] = React.useState(false)
  const [reattachedTaskId, setReattachedTaskId] = React.useState<string | null>(
    null
  )
  const [dictionaryCount, setDictionaryCount] = React.useState<number | null>(
    null
  )
  const [analyzingPath, setAnalyzingPath] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const refreshDictionaryCount = React.useCallback(() => {
    void countDictionary()
      .then(setDictionaryCount)
      .catch(() => setDictionaryCount(isDesktopRuntime() ? null : 0))
  }, [])
  const { task, setTask, running, runningRef } =
    useDesktopTask<RecoveryTaskStatus>({
      enabled: isDesktopRuntime(),
      getStatus: getRecoveryStatus,
      initialPollDelayMs: 350,
      pollIntervalMs: 700,
      onError: (reason) => setError(toErrorMessage(reason)),
      onReattach: (latest) => {
        setComputeMode(latest.computeMode ?? "gpuPreferred")
        setReattachedTaskId(recoveryTaskAttachmentId(latest))
      },
      onSettled: refreshDictionaryCount,
    })
  const openedTasks = React.useRef(new Set<string>())
  const autoOpenTasks = React.useRef(new Set<string>())
  const analysisRequestId = React.useRef(0)
  const taskResultRef = React.useRef<HTMLDivElement>(null)
  const revealedTaskId = React.useRef<string | null>(null)

  React.useEffect(refreshDictionaryCount, [refreshDictionaryCount])

  React.useEffect(() => {
    let disposed = false
    void getSettings()
      .then((settings) => {
        if (!disposed) {
          setComputeMode(settings.recovery?.computeMode ?? "gpuPreferred")
        }
      })
      .catch(() => undefined)
    void getRecoveryCapabilities()
      .then((next) => {
        if (!disposed) {
          setCapabilities(next)
          setCapabilityError(null)
        }
      })
      .catch((reason) => {
        if (!disposed) {
          setCapabilityError(toErrorMessage(reason))
        }
      })
    return () => {
      disposed = true
    }
  }, [])

  const selectArchivePath = React.useCallback(
    async (path: string) => {
      const normalizedPath = normalizeArchivePath(path)
      if (!normalizedPath) {
        return
      }
      if (runningRef.current) {
        setError("当前恢复任务仍在运行，请先取消或等待任务完成。")
        return
      }
      const requestId = ++analysisRequestId.current
      setAnalyzingPath(normalizedPath)
      setBusy(true)
      setError(null)
      setTask(null)
      setReattachedTaskId(null)
      setAnalysis(null)
      setKnownPassword("")
      setShowKnownPassword(false)
      setShowRecoveredPassword(false)
      setPasswordCopied(false)
      try {
        const next = await analyzeArchive(normalizedPath)
        if (requestId !== analysisRequestId.current) {
          return
        }
        setAnalysis(next)
      } catch (reason) {
        if (requestId !== analysisRequestId.current) {
          return
        }
        setAnalysis(null)
        setError(toErrorMessage(reason))
      } finally {
        if (requestId === analysisRequestId.current) {
          setAnalyzingPath(null)
          setBusy(false)
        }
      }
    },
    [runningRef, setTask]
  )

  React.useEffect(() => {
    if (!isDesktopRuntime()) {
      return
    }
    let disposed = false
    let unlisten: (() => void) | undefined
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (disposed) {
          return
        }
        if (runningRef.current) {
          setDragOver(false)
          return
        }
        if (event.payload.type === "over") {
          setDragOver(true)
        } else if (event.payload.type === "drop") {
          setDragOver(false)
          const selection = resolveDroppedArchivePath(event.payload.paths)
          if (selection.error) {
            setError(selection.error)
          } else if (selection.path) {
            void selectArchivePath(selection.path)
          }
        } else {
          setDragOver(false)
        }
      })
      .then((stop) => {
        if (disposed) {
          stop()
        } else {
          unlisten = stop
        }
      })
      .catch((reason) => setError(toErrorMessage(reason)))
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [runningRef, selectArchivePath])

  React.useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      if (isEditablePasteTarget(event.target)) {
        return
      }
      const path = normalizeArchivePath(
        event.clipboardData?.getData("text/plain") ?? ""
      )
      if (path && looksLikeAbsolutePath(path) && isDesktopRuntime()) {
        event.preventDefault()
        void selectArchivePath(path)
      }
    }
    window.addEventListener("paste", handlePaste)
    return () => window.removeEventListener("paste", handlePaste)
  }, [selectArchivePath])

  React.useEffect(() => {
    if (!task?.completed || revealedTaskId.current === task.taskId) {
      return
    }
    revealedTaskId.current = task.taskId
    const frame = requestAnimationFrame(() => {
      const result = taskResultRef.current
      if (!result) {
        return
      }
      result.focus({ preventScroll: true })
      const reduceMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)"
      ).matches
      result.scrollIntoView({
        block: "nearest",
        behavior: reduceMotion ? "auto" : "smooth",
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [task?.completed, task?.taskId])

  React.useEffect(() => {
    if (
      !openWhenDone ||
      !task?.completed ||
      !task.success ||
      !autoOpenTasks.current.has(task.taskId) ||
      openedTasks.current.has(task.taskId)
    ) {
      return
    }
    openedTasks.current.add(task.taskId)
    void openOutputDirectory(task.outputDirectory).catch((reason) =>
      setError(toErrorMessage(reason))
    )
  }, [openWhenDone, task])

  const handlePickArchive = React.useCallback(async () => {
    setError(null)
    try {
      const path = await pickArchivePath()
      if (path) {
        await selectArchivePath(path)
      }
    } catch (reason) {
      setError(toErrorMessage(reason))
    }
  }, [selectArchivePath])

  const handlePickOutputDir = React.useCallback(async () => {
    setError(null)
    try {
      const path = await pickOutputDirectory()
      if (path) {
        setOutputDir(path)
        setOutputMode("custom")
      }
    } catch (reason) {
      setError(toErrorMessage(reason))
    }
  }, [])

  const handleStart = React.useCallback(async () => {
    if (!analysis) {
      return
    }
    if (outputMode === "custom" && !outputDir) {
      setError("请先选择自定义输出目录。")
      setOptionsOpen(true)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const started = await startRecovery({
        archivePath: analysis.archivePath,
        outputDirectory:
          outputMode === "custom"
            ? outputDir
            : analysis.suggestedOutputDirectory,
        knownPassword: knownPassword || null,
        avoidOutputCollision: outputMode === "sibling",
        recursive,
        computeMode,
      })
      autoOpenTasks.current.add(started.taskId)
      setShowRecoveredPassword(false)
      setPasswordCopied(false)
      setReattachedTaskId(null)
      setTask(started)
    } catch (reason) {
      setError(toErrorMessage(reason))
    } finally {
      setBusy(false)
    }
  }, [
    analysis,
    computeMode,
    knownPassword,
    outputDir,
    outputMode,
    recursive,
    setTask,
  ])

  const handleComputeModeChange = React.useCallback(
    async (nextMode: RecoveryComputeMode) => {
      if (running || computeModeBusy || nextMode === computeMode) {
        return
      }
      const previousMode = computeMode
      setComputeMode(nextMode)
      setComputeModeBusy(true)
      setError(null)
      try {
        const current = await getSettings()
        const saved = await setSettings({
          ...current,
          recovery: { computeMode: nextMode },
        })
        setComputeMode(saved.recovery?.computeMode ?? nextMode)
      } catch (reason) {
        setComputeMode(previousMode)
        setError(`无法保存解密方式：${toErrorMessage(reason)}`)
      } finally {
        setComputeModeBusy(false)
      }
    },
    [computeMode, computeModeBusy, running]
  )

  const handleCancel = React.useCallback(async () => {
    if (!task?.running) {
      return
    }
    try {
      await cancelRecovery(task.taskId)
      setTask((current) =>
        current ? { ...current, message: "正在停止外部引擎…" } : current
      )
    } catch (reason) {
      setError(toErrorMessage(reason))
    }
  }, [setTask, task])

  const handleCopyPassword = React.useCallback(async () => {
    if (!task?.recoveredPassword) {
      return
    }
    try {
      await copySensitiveText(task.recoveredPassword)
      setPasswordCopied(true)
    } catch (reason) {
      setError(toErrorMessage(reason))
    }
  }, [task])

  React.useEffect(() => {
    if (!passwordCopied) {
      return
    }
    const timeout = setTimeout(() => setPasswordCopied(false), 1600)
    return () => clearTimeout(timeout)
  }, [passwordCopied])

  const handleOpenOutput = React.useCallback(() => {
    if (!task) {
      return
    }
    void openOutputDirectory(task.outputDirectory).catch((reason) =>
      setError(toErrorMessage(reason))
    )
  }, [task])

  return (
    <ExtractPageView
      outputMode={outputMode}
      setOutputMode={setOutputMode}
      outputDir={outputDir}
      setOutputDir={setOutputDir}
      openWhenDone={openWhenDone}
      setOpenWhenDone={setOpenWhenDone}
      recursive={recursive}
      setRecursive={setRecursive}
      computeMode={computeMode}
      computeModeBusy={computeModeBusy}
      capabilities={capabilities}
      capabilityError={capabilityError}
      dragOver={dragOver}
      setDragOver={setDragOver}
      optionsOpen={optionsOpen}
      setOptionsOpen={setOptionsOpen}
      analysis={analysis}
      knownPassword={knownPassword}
      setKnownPassword={setKnownPassword}
      showKnownPassword={showKnownPassword}
      setShowKnownPassword={setShowKnownPassword}
      showRecoveredPassword={showRecoveredPassword}
      setShowRecoveredPassword={setShowRecoveredPassword}
      passwordCopied={passwordCopied}
      task={task}
      reattachedTaskId={reattachedTaskId}
      dictionaryCount={dictionaryCount}
      analyzingPath={analyzingPath}
      busy={busy}
      error={error}
      running={running}
      taskResultRef={taskResultRef}
      handlePickArchive={handlePickArchive}
      handlePickOutputDir={handlePickOutputDir}
      handleComputeModeChange={handleComputeModeChange}
      handleStart={handleStart}
      handleCancel={handleCancel}
      handleCopyPassword={handleCopyPassword}
      onOpenOutput={handleOpenOutput}
      onOpenEngineSettings={onOpenEngineSettings}
    />
  )
}

function normalizeArchivePath(value: string): string {
  return value.trim().replace(/^"(.*)"$/, "$1")
}

function looksLikeAbsolutePath(value: string): boolean {
  return /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(value)
}

function isEditablePasteTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false
  }
  return Boolean(
    target.closest(
      'input, textarea, [role="textbox"], [contenteditable=""], [contenteditable="true"]'
    )
  )
}

function toErrorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message.trim()) {
    return reason.message
  }
  if (typeof reason === "string" && reason.trim()) {
    return reason
  }
  return "操作未完成。请检查所选文件和应用设置后重试。"
}
