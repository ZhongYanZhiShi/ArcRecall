"use client"

import { getCurrentWebview } from "@tauri-apps/api/webview"
import * as React from "react"
import type { ByteStreamActivity } from "@/lib/byte-stream-motion"
import { toast } from "sonner"

import { CompressPageView } from "@/components/home/compress-page-view"
import { CompressionPresets } from "@/components/home/compression-presets"
import { draftWithCompressionPreset } from "@/lib/compression-presets"
import { buildCompressionPlan } from "@/lib/compression-plan"
import { compressionQueue } from "@/lib/compression-queue-session"
import { CompressionQueuePanel } from "@/components/home/compression-queue-panel"
import {
  generateAiArchiveName,
  listAiProfiles,
  type AiSettings,
} from "@/lib/ai"
import {
  cancelCompression,
  deletePermanentCompressionPassword,
  getCompressionStatus,
  getPermanentCompressionPasswordStatus,
  pickCompressionFiles,
  pickCompressionFolder,
  pickCompressionOutputDirectory,
  savePermanentCompressionPassword,
  startCompression,
  type CompressionTaskStatus,
} from "@/lib/compression"
import {
  compressionPasswordError,
  forgetCompletedArchiveBaseName,
  shouldAutoOpenCompletedTask,
  shouldForgetArchiveBaseName,
  type CompressionDraft,
} from "@/lib/compression-draft"
import {
  compressionSourceIdentity,
  normalizeCompressionSourcePath,
} from "@/lib/compression-path"
import {
  CompressionRenameError,
  startCompressionWithRename,
} from "@/lib/compression-start"
import { isDesktopRuntime } from "@/lib/runtime"
import { openPath } from "@/lib/settings"
import { useDesktopTask } from "@/hooks/use-desktop-task"
import { useCompressionNamingPreferences } from "@/hooks/use-compression-naming-preferences"
import { useAiReferencePreview } from "@/hooks/use-ai-reference-preview"

export function CompressPage({
  draft,
  onDraftChange,
  onOpenAiSettings,
  onStreamActivityChange,
  onRegisterDraftGuard,
}: {
  draft: CompressionDraft
  onDraftChange: React.Dispatch<React.SetStateAction<CompressionDraft>>
  onOpenAiSettings: () => void
  onStreamActivityChange?: (activity: ByteStreamActivity) => void
  onRegisterDraftGuard?: (guard: () => boolean) => void
}) {
  const compressionBatch = React.useSyncExternalStore(
    compressionQueue.subscribe,
    compressionQueue.getSnapshot,
    compressionQueue.getSnapshot
  )
  const {
    sources,
    baseName,
    password,
    passwordConfirmation,
    openWhenDone,
    useAiRename,
    useAiFileReference,
    aiReferenceExtensions,
  } = draft
  const [showPassword, setShowPassword] = React.useState(false)
  const [passwordValidationRequested, setPasswordValidationRequested] =
    React.useState(false)
  const passwordError = compressionPasswordError(password, passwordConfirmation)
  const [hasPermanentPassword, setHasPermanentPassword] = React.useState(false)
  const [usePermanentPassword, setUsePermanentPassword] = React.useState(false)
  const permanentPasswordInitialized = React.useRef(false)
  const [permanentPasswordReady, setPermanentPasswordReady] =
    React.useState(false)
  const [passwordCredentialBusy, setPasswordCredentialBusy] =
    React.useState(false)
  const [deletePasswordOpen, setDeletePasswordOpen] = React.useState(false)
  const [dragOver, setDragOver] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [aiError, setAiError] = React.useState<string | null>(null)
  const [aiSettings, setAiSettings] = React.useState<AiSettings | null>(null)
  const { task, setTask, running, runningRef } =
    useDesktopTask<CompressionTaskStatus>({
      enabled: isDesktopRuntime(),
      getStatus: getCompressionStatus,
      initialPollDelayMs: 300,
      pollIntervalMs: 650,
      onError: (reason) => setError(toErrorMessage(reason)),
    })
  React.useEffect(() => {
    onStreamActivityChange?.(running || busy ? "running" : "idle")
    return () => onStreamActivityChange?.("idle")
  }, [running, busy, onStreamActivityChange])
  const openedTasks = React.useRef(new Set<string>())
  const archiveNamesAwaitingCompletion = React.useRef(new Set<string>())
  const operationBusy = React.useRef(false)
  const operationVersion = React.useRef(0)
  const isDraftLocked = React.useCallback(
    () =>
      operationBusy.current ||
      runningRef.current ||
      compressionQueue.getSnapshot().running,
    [runningRef]
  )
  React.useLayoutEffect(() => {
    // Keep this guard registered while Activity hides the page: asynchronous
    // naming and credential work can still own the draft while effects pause.
    onRegisterDraftGuard?.(
      () => operationBusy.current || compressionQueue.getSnapshot().running
    )
  }, [onRegisterDraftGuard])
  const referencePreferences = useCompressionNamingPreferences(
    draft,
    onDraftChange,
    isDraftLocked
  )
  const referencePreview = useAiReferencePreview(
    sources,
    aiReferenceExtensions,
    referencePreferences.ready && useAiRename && useAiFileReference,
    isDraftLocked
  )

  const setSources = React.useCallback(
    (update: React.SetStateAction<string[]>) => {
      if (isDraftLocked()) return
      onDraftChange((current) => {
        const sources =
          typeof update === "function" ? update(current.sources) : update
        return sources === current.sources ? current : { ...current, sources }
      })
    },
    [isDraftLocked, onDraftChange]
  )

  const updateDraft = React.useCallback(
    <Key extends keyof CompressionDraft>(
      key: Key,
      value: CompressionDraft[Key]
    ) => {
      if (isDraftLocked()) return
      onDraftChange((current) =>
        Object.is(current[key], value)
          ? current
          : {
              ...current,
              [key]: value,
              ...(key === "password" && !value
                ? { passwordConfirmation: "" }
                : {}),
            }
      )
    },
    [isDraftLocked, onDraftChange]
  )

  React.useEffect(() => {
    let disposed = false
    void getPermanentCompressionPasswordStatus()
      .then((status) => {
        if (disposed) {
          return
        }
        setHasPermanentPassword(status.hasPassword)
        if (!permanentPasswordInitialized.current || !status.hasPassword) {
          setUsePermanentPassword(status.hasPassword && !draft.retryPrepared)
        }
        permanentPasswordInitialized.current = true
      })
      .catch((reason) => {
        if (!disposed) {
          setError(toErrorMessage(reason))
        }
      })
      .finally(() => {
        if (!disposed) {
          setPermanentPasswordReady(true)
        }
      })
    return () => {
      disposed = true
    }
  }, [draft.retryPrepared])

  const handleSavePermanentPassword = React.useCallback(async () => {
    if (isDraftLocked()) return
    if (!password) {
      setError("请先输入要永久保存的密码。")
      return
    }
    setPasswordValidationRequested(true)
    if (passwordError) return
    operationBusy.current = true
    operationVersion.current += 1
    setPasswordCredentialBusy(true)
    setError(null)
    try {
      const status = await savePermanentCompressionPassword(password)
      setHasPermanentPassword(status.hasPassword)
      setUsePermanentPassword(status.hasPassword)
      onDraftChange((current) => ({
        ...current,
        password: "",
        passwordConfirmation: "",
      }))
      setPasswordValidationRequested(false)
      setShowPassword(false)
      toast.success("永久密码已保存", { id: "compression-action" })
    } catch (reason) {
      notifyCompressionError(reason)
    } finally {
      operationBusy.current = false
      setPasswordCredentialBusy(false)
    }
  }, [isDraftLocked, onDraftChange, password, passwordError])

  const handleDeletePermanentPassword = React.useCallback(async () => {
    if (isDraftLocked()) return
    operationBusy.current = true
    operationVersion.current += 1
    setPasswordCredentialBusy(true)
    setError(null)
    try {
      const status = await deletePermanentCompressionPassword()
      setHasPermanentPassword(status.hasPassword)
      setUsePermanentPassword(false)
      setDeletePasswordOpen(false)
      toast.success("永久密码已删除", { id: "compression-action" })
    } catch (reason) {
      notifyCompressionError(reason)
    } finally {
      operationBusy.current = false
      setPasswordCredentialBusy(false)
    }
  }, [isDraftLocked])

  const refreshAiSettings = React.useCallback(() => {
    void listAiProfiles()
      .then((next) => {
        setAiSettings(next)
        setAiError(null)
      })
      .catch((reason) => {
        setAiSettings(null)
        setAiError(toErrorMessage(reason))
      })
  }, [])

  React.useEffect(refreshAiSettings, [refreshAiSettings])

  const appendSources = React.useCallback(
    (paths: string[]) => {
      setSources((current) => {
        const seen = new Set(current.map(compressionSourceIdentity))
        const next = [...current]
        for (const path of paths) {
          const normalized = normalizeCompressionSourcePath(path)
          if (!normalized || seen.has(compressionSourceIdentity(normalized))) {
            continue
          }
          seen.add(compressionSourceIdentity(normalized))
          next.push(normalized)
        }
        return next.length === current.length ? current : next
      })
    },
    [setSources]
  )

  React.useEffect(() => {
    if (!isDesktopRuntime()) {
      return
    }
    let disposed = false
    let unlisten: (() => void) | undefined
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (disposed || isDraftLocked()) {
          setDragOver(false)
          return
        }
        if (event.payload.type === "over") {
          setDragOver(true)
        } else if (event.payload.type === "drop") {
          setDragOver(false)
          appendSources(event.payload.paths)
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
      .catch((reason) => {
        if (!disposed) notifyCompressionError(reason)
      })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [appendSources, isDraftLocked])

  React.useEffect(() => {
    if (
      !shouldAutoOpenCompletedTask(
        task,
        openWhenDone && draft.packagingMode !== "separate",
        openedTasks.current
      )
    ) {
      return
    }
    if (!task) return
    void openPath(task.outputPath).catch((reason) =>
      notifyCompressionError(reason)
    )
  }, [openWhenDone, task, draft.packagingMode])

  React.useEffect(() => {
    if (
      task &&
      shouldForgetArchiveBaseName(task, archiveNamesAwaitingCompletion.current)
    ) {
      onDraftChange(forgetCompletedArchiveBaseName)
    }
  }, [onDraftChange, task])

  const handlePickFiles = React.useCallback(async () => {
    if (isDraftLocked()) return
    const version = operationVersion.current
    setError(null)
    try {
      const paths = await pickCompressionFiles()
      if (isDraftLocked() || version !== operationVersion.current) return
      appendSources(paths)
    } catch (reason) {
      notifyCompressionError(reason)
    }
  }, [appendSources, isDraftLocked])

  const handlePickFolder = React.useCallback(async () => {
    if (isDraftLocked()) return
    const version = operationVersion.current
    setError(null)
    try {
      const path = await pickCompressionFolder()
      if (isDraftLocked() || version !== operationVersion.current) return
      if (path) {
        appendSources([path])
      }
    } catch (reason) {
      notifyCompressionError(reason)
    }
  }, [appendSources, isDraftLocked])

  const handlePickOutput = React.useCallback(async () => {
    if (isDraftLocked()) return
    const version = operationVersion.current
    setError(null)
    try {
      const path = await pickCompressionOutputDirectory()
      if (isDraftLocked() || version !== operationVersion.current) return
      if (path) {
        updateDraft("outputDirectory", path)
        updateDraft("outputMode", "custom")
      }
    } catch (reason) {
      notifyCompressionError(reason)
    }
  }, [isDraftLocked, updateDraft])

  const handleMoveSource = React.useCallback(
    (index: number, direction: -1 | 1) => {
      setSources((current) => {
        const target = index + direction
        if (target < 0 || target >= current.length) {
          return current
        }
        const next = [...current]
        ;[next[index], next[target]] = [next[target], next[index]]
        return next
      })
    },
    [setSources]
  )

  const activeAiProfile =
    aiSettings?.profiles.find(
      (profile) => profile.id === aiSettings.activeProfileId
    ) ?? null

  const handleStart = React.useCallback(
    async (skipAiRename = false, queueOnly = false) => {
      if (
        isDraftLocked() ||
        !permanentPasswordReady ||
        !referencePreferences.ready
      )
        return
      setPasswordValidationRequested(true)
      if (passwordError) return
      let plan
      try {
        plan = buildCompressionPlan(
          draft,
          hasPermanentPassword && usePermanentPassword
        )
      } catch (reason) {
        setError(toErrorMessage(reason))
        return
      }
      if (plan.separate) {
        try {
          compressionQueue.add(plan.requests, plan.passwordRequired)
          if (queueOnly) return
          await compressionQueue.run(plan.credentials)
          if (openWhenDone) await openCompletedCompressionBatch()
        } catch (reason) {
          setError(toErrorMessage(reason))
        }
        return
      }
      if (useAiRename && !skipAiRename && !activeAiProfile) {
        setAiError("尚未配置可用的 AI 模型，请先前往设置。")
        return
      }
      if (useAiRename && !skipAiRename && useAiFileReference) {
        if (referencePreview.loading) return
        if (referencePreview.error) {
          setAiError("参考文件读取失败，请刷新列表后重试，或使用原名称压缩。")
          return
        }
      }
      operationBusy.current = true
      operationVersion.current += 1
      setBusy(true)
      setDragOver(false)
      setError(null)
      setAiError(null)
      try {
        const next = await startCompressionWithRename(baseName.trim(), {
          rename:
            useAiRename && !skipAiRename
              ? (name) =>
                  generateAiArchiveName(
                    name,
                    activeAiProfile?.id,
                    undefined,
                    useAiFileReference
                      ? {
                          sources,
                          extensions: aiReferenceExtensions,
                          selectedPaths: referencePreview.selectedPaths,
                        }
                      : undefined
                  )
              : undefined,
          onRenamed: (name) =>
            onDraftChange((current) => ({ ...current, baseName: name })),
          start: (name) =>
            startCompression({
              ...plan.requests[0],
              ...plan.credentials,
              baseName: name,
            }),
        })
        setTask(next)
      } catch (reason) {
        const message = toErrorMessage(reason)
        if (reason instanceof CompressionRenameError) {
          setAiError(message)
        } else {
          setError(message)
        }
      } finally {
        operationBusy.current = false
        setBusy(false)
      }
    },
    [
      activeAiProfile,
      draft,
      openWhenDone,
      baseName,
      hasPermanentPassword,
      isDraftLocked,
      passwordError,
      permanentPasswordReady,
      referencePreferences.ready,
      referencePreview.loading,
      referencePreview.error,
      referencePreview.selectedPaths,
      onDraftChange,
      setTask,
      sources,
      useAiRename,
      useAiFileReference,
      aiReferenceExtensions,
      usePermanentPassword,
    ]
  )

  const cancelRequest = React.useRef<string | null>(null)
  const [cancellingTaskId, setCancellingTaskId] = React.useState<string | null>(
    null
  )
  const handleCancel = React.useCallback(async () => {
    if (compressionQueue.getSnapshot().running) {
      await compressionQueue.stop().catch(notifyCompressionError)
      return
    }
    if (!task?.running || cancelRequest.current === task.taskId) {
      return
    }
    const taskId = task.taskId
    cancelRequest.current = taskId
    setCancellingTaskId(taskId)
    setError(null)
    try {
      await cancelCompression(taskId)
    } catch (reason) {
      if (cancelRequest.current === taskId) cancelRequest.current = null
      setCancellingTaskId((current) => (current === taskId ? null : current))
      notifyCompressionError(reason)
    }
  }, [task])

  const handleRemoveSource = React.useCallback(
    (index: number) => {
      setSources((current) =>
        current.filter((_, sourceIndex) => sourceIndex !== index)
      )
    },
    [setSources]
  )

  const handleOpenTaskOutput = React.useCallback(() => {
    if (!task) {
      return
    }
    void openPath(task.outputPath).catch((reason) =>
      notifyCompressionError(reason)
    )
  }, [task])

  return (
    <CompressPageView
      presets={
        <div className="flex flex-wrap gap-2">
          <CompressionQueuePanel
            disabled={
              busy ||
              passwordCredentialBusy ||
              (!compressionBatch.running &&
                running &&
                !compressionBatch.items.some(
                  (item) =>
                    item.state === "running" && item.taskId === task?.taskId
                ))
            }
            onRun={async () => {
              if (passwordError) throw new Error(passwordError)
              if (
                operationBusy.current ||
                (runningRef.current &&
                  !compressionQueue
                    .getSnapshot()
                    .items.some((item) => item.state === "running"))
              )
                throw new Error("已有压缩任务正在运行。")
              await compressionQueue.run({
                password: password || undefined,
                usePermanentPassword:
                  hasPermanentPassword && usePermanentPassword,
              })
              if (openWhenDone) await openCompletedCompressionBatch()
            }}
          />
          <CompressionPresets
            draft={draft}
            disabled={
              busy ||
              running ||
              compressionBatch.running ||
              passwordCredentialBusy
            }
            onApply={(preset) => {
              if (isDraftLocked()) return
              operationVersion.current += 1
              onDraftChange((current) =>
                draftWithCompressionPreset(current, preset)
              )
            }}
          />
        </div>
      }
      referencePreview={referencePreview}
      referencePreferences={referencePreferences}
      draft={draft}
      dragOver={dragOver}
      busy={busy || compressionBatch.running}
      error={error}
      aiError={aiError}
      setAiError={setAiError}
      activeAiProfile={activeAiProfile}
      task={task}
      running={running}
      showPassword={showPassword}
      passwordError={
        passwordValidationRequested || passwordConfirmation
          ? passwordError
          : null
      }
      setShowPassword={setShowPassword}
      hasPermanentPassword={hasPermanentPassword}
      usePermanentPassword={usePermanentPassword}
      setUsePermanentPassword={(update) => {
        if (!isDraftLocked()) setUsePermanentPassword(update)
      }}
      permanentPasswordReady={permanentPasswordReady}
      passwordCredentialBusy={passwordCredentialBusy}
      deletePasswordOpen={deletePasswordOpen}
      setDeletePasswordOpen={setDeletePasswordOpen}
      updateDraft={updateDraft}
      handlePickFiles={handlePickFiles}
      handlePickFolder={handlePickFolder}
      handlePickOutput={handlePickOutput}
      handleMoveSource={handleMoveSource}
      onRemoveSource={handleRemoveSource}
      handleStart={handleStart}
      handleCancel={handleCancel}
      cancelling={Boolean(task?.running && cancellingTaskId === task.taskId)}
      handleSavePermanentPassword={handleSavePermanentPassword}
      handleDeletePermanentPassword={handleDeletePermanentPassword}
      onOpenTaskOutput={handleOpenTaskOutput}
      onOpenAiSettings={onOpenAiSettings}
    />
  )
}

function toErrorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason ?? "未知错误")
}

async function openCompletedCompressionBatch() {
  const batch = compressionQueue.getSnapshot()
  if (
    batch.running ||
    batch.error ||
    batch.items.some(
      (item) => item.state === "waiting" || item.state === "running"
    )
  )
    return
  const output = batch.items.findLast((item) => item.result?.success)?.result
    ?.outputPath
  if (output) await openPath(output)
}

function notifyCompressionError(reason: unknown) {
  toast.error(toErrorMessage(reason), {
    id: "compression-action",
    duration: 6_000,
  })
}
