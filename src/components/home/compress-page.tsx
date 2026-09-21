"use client"

import { getCurrentWebview } from "@tauri-apps/api/webview"
import * as React from "react"

import { CompressPageView } from "@/components/home/compress-page-view"
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
import { isDesktopRuntime } from "@/lib/dictionary"
import { openPath } from "@/lib/settings"
import { useDesktopTask } from "@/hooks/use-desktop-task"

export function CompressPage({
  draft,
  onDraftChange,
  onOpenAiSettings,
}: {
  draft: CompressionDraft
  onDraftChange: React.Dispatch<React.SetStateAction<CompressionDraft>>
  onOpenAiSettings: () => void
}) {
  const {
    sources,
    outputMode,
    outputDirectory,
    baseName,
    format,
    level,
    password,
    passwordConfirmation,
    encryptFileNames,
    openWhenDone,
    useAiRename,
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
  const openedTasks = React.useRef(new Set<string>())
  const archiveNamesAwaitingCompletion = React.useRef(new Set<string>())
  const operationBusy = React.useRef(false)
  const operationVersion = React.useRef(0)
  const isDraftLocked = React.useCallback(
    () => operationBusy.current || runningRef.current,
    [runningRef]
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
          setUsePermanentPassword(status.hasPassword)
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
  }, [])

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
    } catch (reason) {
      setError(toErrorMessage(reason))
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
    } catch (reason) {
      setError(toErrorMessage(reason))
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
      .catch((reason) => setError(toErrorMessage(reason)))
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [appendSources, isDraftLocked])

  React.useEffect(() => {
    if (!shouldAutoOpenCompletedTask(task, openWhenDone, openedTasks.current)) {
      return
    }
    if (!task) return
    void openPath(task.outputPath).catch((reason) =>
      setError(toErrorMessage(reason))
    )
  }, [openWhenDone, task])

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
      setError(toErrorMessage(reason))
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
      setError(toErrorMessage(reason))
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
      setError(toErrorMessage(reason))
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
    async (skipAiRename = false) => {
      if (isDraftLocked() || !permanentPasswordReady) return
      setPasswordValidationRequested(true)
      if (passwordError) return
      if (sources.length === 0) {
        setError("请先添加至少一个文件或文件夹。")
        return
      }
      if (!baseName.trim()) {
        setError("请输入归档基础名称。")
        return
      }
      if (
        encryptFileNames &&
        !password &&
        !(hasPermanentPassword && usePermanentPassword)
      ) {
        setError("开启文件名加密前需要设置密码。")
        return
      }
      if (outputMode === "custom" && !outputDirectory) {
        setError("请选择自定义输出目录。")
        return
      }
      if (useAiRename && !skipAiRename && !activeAiProfile) {
        setAiError("尚未配置可用的 AI 模型，请先前往设置。")
        return
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
              ? (name) => generateAiArchiveName(name, activeAiProfile?.id)
              : undefined,
          onRenamed: (name) =>
            onDraftChange((current) => ({ ...current, baseName: name })),
          start: (name) =>
            startCompression({
              sources,
              outputDirectory:
                outputMode === "custom" ? outputDirectory : undefined,
              baseName: name,
              format,
              level,
              password: password || undefined,
              usePermanentPassword:
                hasPermanentPassword && usePermanentPassword,
              encryptFileNames,
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
      baseName,
      encryptFileNames,
      format,
      hasPermanentPassword,
      isDraftLocked,
      level,
      outputDirectory,
      outputMode,
      password,
      passwordError,
      permanentPasswordReady,
      onDraftChange,
      setTask,
      sources,
      useAiRename,
      usePermanentPassword,
    ]
  )

  const handleCancel = React.useCallback(async () => {
    if (!task?.running) {
      return
    }
    setError(null)
    try {
      await cancelCompression(task.taskId)
    } catch (reason) {
      setError(toErrorMessage(reason))
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
      setError(toErrorMessage(reason))
    )
  }, [task])

  return (
    <CompressPageView
      draft={draft}
      dragOver={dragOver}
      busy={busy}
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
