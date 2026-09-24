"use client"

import * as React from "react"

import {
  aiClientDraftRequest,
  isProfileDraftDirty,
  newProfileDraft,
  profileToDraft,
  validateProfileDraft,
  type InvalidProfileField,
  type ProfileDraft,
} from "@/components/home/ai-settings-draft"
import {
  AI_PROVIDER_DEFAULTS,
  deleteAiProfile,
  listAiModels,
  listAiProfiles,
  testAiConnection,
  updateAiSettings,
  upsertAiProfile,
  type AiModelInfo,
  type AiProfile,
  type AiProviderKind,
  type AiSettings,
} from "@/lib/ai"

export type OperationFeedback = {
  message: string
  error: boolean
}

export type PendingDraftAction =
  | { type: "create" }
  | { type: "select"; profile: AiProfile }

export function useAiSettingsController({
  onDirtyChange,
}: {
  onDirtyChange?: (dirty: boolean) => void
}) {
  const [settings, setSettings] = React.useState<AiSettings | null>(null)
  const [draft, setDraft] = React.useState<ProfileDraft>(() =>
    newProfileDraft("ollama")
  )
  const [models, setModels] = React.useState<AiModelInfo[]>([])
  const [prompt, setPrompt] = React.useState("")
  const [busyScope, setBusyScope] = React.useState<"profile" | "prompt" | null>(
    null
  )
  const [profileFeedback, setProfileFeedback] =
    React.useState<OperationFeedback | null>(null)
  const [promptFeedback, setPromptFeedback] =
    React.useState<OperationFeedback | null>(null)
  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const [pendingDraftAction, setPendingDraftAction] =
    React.useState<PendingDraftAction | null>(null)
  const [invalidField, setInvalidField] =
    React.useState<InvalidProfileField | null>(null)

  const busy = busyScope !== null
  const profileBusy = busyScope === "profile"
  const promptBusy = busyScope === "prompt"

  const applySettings = React.useCallback(
    (next: AiSettings, preferredId?: string | null, syncPrompt = true) => {
      setSettings(next)
      if (syncPrompt) {
        setPrompt(next.renamePrompt)
      }
      const selected =
        next.profiles.find((profile) => profile.id === preferredId) ??
        next.profiles.find((profile) => profile.id === next.activeProfileId) ??
        next.profiles[0]
      setDraft(selected ? profileToDraft(selected) : newProfileDraft("ollama"))
    },
    []
  )

  React.useEffect(() => {
    let disposed = false
    void listAiProfiles()
      .then((next) => {
        if (!disposed) {
          applySettings(next)
        }
      })
      .catch((reason) => {
        if (!disposed) {
          setProfileFeedback({
            error: true,
            message: `读取 AI 配置失败：${toErrorMessage(reason)}`,
          })
        }
      })
    return () => {
      disposed = true
    }
  }, [applySettings])

  const applyDraftAction = (action: PendingDraftAction) => {
    setDraft(
      action.type === "select"
        ? profileToDraft(action.profile)
        : newProfileDraft("ollama")
    )
    setModels([])
    setProfileFeedback(null)
    setInvalidField(null)
    setPendingDraftAction(null)
  }

  const handleProviderChange = (provider: AiProviderKind) => {
    const defaults = AI_PROVIDER_DEFAULTS[provider]
    setDraft((current) => ({
      ...current,
      provider,
      baseUrl: defaults.baseUrl,
      model: defaults.model,
    }))
    setModels([])
    setInvalidField(null)
    setProfileFeedback(null)
  }

  const validateDraft = () => {
    const validationError = validateProfileDraft(draft)
    if (validationError) {
      setInvalidField(validationError.field)
      setProfileFeedback({ error: true, message: validationError.message })
      return false
    }
    setInvalidField(null)
    return true
  }

  const persistDraft = async (makeActive = false): Promise<AiSettings> => {
    const shouldActivate = makeActive || draft.id === null
    const next = await upsertAiProfile({
      id: draft.id,
      name: draft.name.trim(),
      provider: draft.provider,
      baseUrl: draft.baseUrl.trim(),
      model: draft.model.trim(),
      apiKey: draft.apiKey.trim() || undefined,
      clearApiKey: draft.clearApiKey,
      makeActive: shouldActivate,
    })
    applySettings(next, draft.id ?? next.activeProfileId, false)
    return next
  }

  const handleSaveProfile = async (
    makeActive = false
  ): Promise<AiSettings | null> => {
    if (busy || !validateDraft()) {
      return null
    }
    setBusyScope("profile")
    setProfileFeedback({ error: false, message: "正在保存 AI 配置…" })
    try {
      const shouldActivate = makeActive || draft.id === null
      const next = await persistDraft(makeActive)
      setProfileFeedback({
        error: false,
        message: shouldActivate
          ? "配置已保存并设为当前 AI 模型。"
          : "AI 配置已保存。",
      })
      return next
    } catch (reason) {
      setProfileFeedback({
        error: true,
        message: `保存失败：${toErrorMessage(reason)}`,
      })
      return null
    } finally {
      setBusyScope(null)
    }
  }

  const handleLoadModels = async () => {
    if (busy || !validateDraft()) {
      return
    }
    setBusyScope("profile")
    setProfileFeedback({
      error: false,
      message: "正在获取当前草稿的模型列表，不会保存更改…",
    })
    try {
      const next = await listAiModels(aiClientDraftRequest(draft))
      setModels(next)
      setProfileFeedback({
        error: false,
        message:
          next.length > 0
            ? `已获取 ${next.length} 个模型，可从列表选择或继续手动填写。`
            : "连接成功，但服务没有返回模型；可手动填写模型标识。",
      })
    } catch (reason) {
      setProfileFeedback({
        error: true,
        message: `获取模型失败：${toErrorMessage(reason)}`,
      })
    } finally {
      setBusyScope(null)
    }
  }

  const handleTest = async () => {
    if (busy || !validateDraft()) {
      return
    }
    setBusyScope("profile")
    setProfileFeedback({
      error: false,
      message: "正在测试当前草稿，不会保存更改…",
    })
    try {
      const result = await testAiConnection(aiClientDraftRequest(draft))
      setProfileFeedback({ error: !result.success, message: result.message })
    } catch (reason) {
      setProfileFeedback({
        error: true,
        message: `连接失败：${toErrorMessage(reason)}`,
      })
    } finally {
      setBusyScope(null)
    }
  }

  const handleSaveRenameSettings = async (
    activeProfileId = settings?.activeProfileId ?? ""
  ): Promise<boolean> => {
    if (!settings || busy) {
      return false
    }
    if (!prompt.trim()) {
      setPromptFeedback({ error: true, message: "提示词不能为空。" })
      return false
    }
    if (prompt.length > 2_000) {
      setPromptFeedback({
        error: true,
        message: "提示词不能超过 2000 个字符。",
      })
      return false
    }
    setBusyScope("prompt")
    setPromptFeedback({
      error: false,
      message: "正在保存 AI 重命名设置…",
    })
    try {
      const next = await updateAiSettings({
        activeProfileId,
        renamePrompt: prompt,
      })
      setSettings(next)
      setPrompt(next.renamePrompt)
      setPromptFeedback({ error: false, message: "AI 重命名提示词已保存。" })
      return true
    } catch (reason) {
      setPromptFeedback({
        error: true,
        message: `保存失败：${toErrorMessage(reason)}`,
      })
      return false
    } finally {
      setBusyScope(null)
    }
  }

  const handleDelete = async () => {
    if (!draft.id || busy) {
      return
    }
    setBusyScope("profile")
    setProfileFeedback(null)
    try {
      const next = await deleteAiProfile(draft.id)
      setModels([])
      applySettings(next, undefined, false)
      setDeleteOpen(false)
      setProfileFeedback({
        error: false,
        message: "AI 配置和对应的系统凭据已删除。",
      })
    } catch (reason) {
      setProfileFeedback({
        error: true,
        message: `删除失败：${toErrorMessage(reason)}`,
      })
    } finally {
      setBusyScope(null)
    }
  }

  const isActive = draft.id !== null && settings?.activeProfileId === draft.id
  const savedProfile = settings?.profiles.find(
    (profile) => profile.id === draft.id
  )
  const profileDirty = isProfileDraftDirty(draft, savedProfile)
  const promptDirty = settings !== null && prompt !== settings.renamePrompt
  const hasUnsavedChanges = profileDirty || promptDirty
  const providerMeta = AI_PROVIDER_DEFAULTS[draft.provider]
  const renamePromptError =
    settings !== null && !prompt.trim()
      ? "提示词不能为空。"
      : prompt.length > 2_000
        ? "提示词不能超过 2000 个字符。"
        : null

  const requestDraftAction = (action: PendingDraftAction) => {
    if (busy || (action.type === "select" && action.profile.id === draft.id)) {
      return
    }
    if (profileDirty) {
      setPendingDraftAction(action)
    } else {
      applyDraftAction(action)
    }
  }

  const handleSavePendingDraft = async () => {
    if (!pendingDraftAction) {
      return
    }
    const action = pendingDraftAction
    const savedSettings = await handleSaveProfile(false)
    if (savedSettings) {
      applyDraftAction(action)
    } else {
      setPendingDraftAction(null)
    }
  }

  const saveUnsavedChanges = async () => {
    if (busy) {
      return false
    }
    let activeProfileId = settings?.activeProfileId
    if (profileDirty) {
      const savedSettings = await handleSaveProfile(false)
      if (!savedSettings) {
        return false
      }
      activeProfileId = savedSettings.activeProfileId
    }
    return !promptDirty || handleSaveRenameSettings(activeProfileId)
  }

  const discardUnsavedChanges = () => {
    if (settings) {
      applySettings(settings, draft.id)
    } else {
      setDraft(newProfileDraft("ollama"))
      setPrompt("")
    }
    setModels([])
    setProfileFeedback(null)
    setPromptFeedback(null)
    setInvalidField(null)
    setPendingDraftAction(null)
    setDeleteOpen(false)
  }

  React.useEffect(() => {
    onDirtyChange?.(hasUnsavedChanges)
    return () => onDirtyChange?.(false)
  }, [hasUnsavedChanges, onDirtyChange])

  React.useEffect(() => {
    if (!hasUnsavedChanges) {
      return
    }
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", handleBeforeUnload)
    return () => window.removeEventListener("beforeunload", handleBeforeUnload)
  }, [hasUnsavedChanges])

  return {
    settings,
    draft,
    setDraft,
    models,
    prompt,
    setPrompt,
    busy,
    profileBusy,
    promptBusy,
    profileFeedback,
    setProfileFeedback,
    promptFeedback,
    setPromptFeedback,
    deleteOpen,
    setDeleteOpen,
    pendingDraftAction,
    setPendingDraftAction,
    invalidField,
    setInvalidField,
    isActive,
    profileDirty,
    promptDirty,
    providerMeta,
    renamePromptError,
    applyDraftAction,
    handleProviderChange,
    handleSaveProfile,
    handleLoadModels,
    handleTest,
    handleSaveRenameSettings,
    handleDelete,
    requestDraftAction,
    handleSavePendingDraft,
    saveUnsavedChanges,
    discardUnsavedChanges,
  }
}

function toErrorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason ?? "未知错误")
}
