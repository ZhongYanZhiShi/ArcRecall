"use client"

import * as React from "react"
import { toast } from "sonner"

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
  const [draft, setDraftState] = React.useState<ProfileDraft>(() =>
    newProfileDraft("ollama")
  )
  const [models, setModels] = React.useState<AiModelInfo[]>([])
  const [prompt, setPromptState] = React.useState("")
  const [loading, setLoading] = React.useState(true)
  const loaded = React.useRef(false)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [loadVersion, setLoadVersion] = React.useState(0)
  const retryLoad = () => {
    loaded.current = false
    setLoading(true)
    setLoadError(null)
    setProfileFeedback(null)
    setLoadVersion((version) => version + 1)
  }
  const draftRevision = React.useRef(0)
  const setDraft = React.useCallback(
    (update: React.SetStateAction<ProfileDraft>) => {
      draftRevision.current += 1
      setDraftState(update)
    },
    []
  )
  const setPrompt = React.useCallback(
    (update: React.SetStateAction<string>) => {
      draftRevision.current += 1
      setPromptState(update)
    },
    []
  )
  const [busyScope, setBusyScope] = React.useState<"profile" | "prompt" | null>(
    null
  )
  const operation = React.useRef(false)
  const [profileAction, setProfileAction] = React.useState<
    "save" | "activate" | "models" | "test" | "delete" | null
  >(null)
  const [profileFeedback, setProfileFeedback] =
    React.useState<OperationFeedback | null>(null)
  const [promptFeedback, setPromptFeedback] =
    React.useState<OperationFeedback | null>(null)
  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const [pendingDraftAction, setPendingDraftAction] =
    React.useState<PendingDraftAction | null>(null)
  const [invalidField, setInvalidField] =
    React.useState<InvalidProfileField | null>(null)

  const busy = loading || busyScope !== null
  const profileBusy = busyScope === "profile"
  const promptBusy = busyScope === "prompt"

  const applySettings = React.useCallback(
    (next: AiSettings, preferredId?: string | null, syncPrompt = true) => {
      draftRevision.current += 1
      setSettings(next)
      if (syncPrompt) {
        setPromptState(next.renamePrompt)
      }
      const selected =
        next.profiles.find((profile) => profile.id === preferredId) ??
        next.profiles.find((profile) => profile.id === next.activeProfileId) ??
        next.profiles[0]
      setDraftState(
        selected ? profileToDraft(selected) : newProfileDraft("ollama")
      )
    },
    []
  )

  React.useEffect(() => {
    if (loaded.current) return
    let disposed = false
    const revision = draftRevision.current
    void listAiProfiles()
      .then((next) => {
        if (!disposed) {
          loaded.current = true
          setLoadError(null)
          // Activity resumes this effect. A refresh must not replace edits made
          // after its request started, even after the initial loading screen.
          if (draftRevision.current === revision) applySettings(next)
        }
      })
      .catch((reason) => {
        if (!disposed) {
          setLoadError(`读取 AI 配置失败：${toErrorMessage(reason)}`)
          setProfileFeedback({
            error: true,
            message: `读取 AI 配置失败：${toErrorMessage(reason)}`,
          })
        }
      })
      .finally(() => {
        if (!disposed) setLoading(false)
      })
    return () => {
      disposed = true
    }
  }, [applySettings, loadVersion])

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
    if (busy || operation.current || !validateDraft()) {
      return null
    }
    operation.current = true
    setProfileAction(makeActive ? "activate" : "save")
    setBusyScope("profile")
    setProfileFeedback({ error: false, message: "正在保存 AI 配置…" })
    try {
      const shouldActivate = makeActive || draft.id === null
      const next = await persistDraft(makeActive)
      setProfileFeedback(null)
      toast.success(
        shouldActivate ? "配置已保存并设为当前 AI 模型。" : "AI 配置已保存。",
        { id: "ai-profile" }
      )
      return next
    } catch (reason) {
      setProfileFeedback(null)
      toast.error(`保存失败：${toErrorMessage(reason)}`, {
        id: "ai-profile",
        duration: 6_000,
      })
      return null
    } finally {
      operation.current = false
      setProfileAction(null)
      setBusyScope(null)
    }
  }

  const handleLoadModels = async () => {
    if (busy || operation.current || !validateDraft()) {
      return
    }
    operation.current = true
    setProfileAction("models")
    setBusyScope("profile")
    setProfileFeedback({
      error: false,
      message: "正在获取当前草稿的模型列表，不会保存更改…",
    })
    try {
      const next = await listAiModels(aiClientDraftRequest(draft))
      setModels(next)
      setProfileFeedback(null)
      toast.info(
        next.length > 0
          ? `已获取 ${next.length} 个模型，可从列表选择或继续手动填写。`
          : "连接成功，但服务没有返回模型；可手动填写模型标识。",
        { id: "ai-profile", duration: 4_000 }
      )
    } catch (reason) {
      setProfileFeedback(null)
      toast.error(`获取模型失败：${toErrorMessage(reason)}`, {
        id: "ai-profile",
        duration: 6_000,
      })
    } finally {
      operation.current = false
      setProfileAction(null)
      setBusyScope(null)
    }
  }

  const handleTest = async () => {
    if (busy || operation.current || !validateDraft()) {
      return
    }
    operation.current = true
    setProfileAction("test")
    setBusyScope("profile")
    setProfileFeedback({
      error: false,
      message: "正在测试当前草稿，不会保存更改…",
    })
    try {
      const result = await testAiConnection(aiClientDraftRequest(draft))
      setProfileFeedback(null)
      if (result.success) {
        toast.success(result.message, { id: "ai-profile", duration: 4_000 })
      } else {
        toast.error(result.message, { id: "ai-profile", duration: 6_000 })
      }
    } catch (reason) {
      setProfileFeedback(null)
      toast.error(`连接失败：${toErrorMessage(reason)}`, {
        id: "ai-profile",
        duration: 6_000,
      })
    } finally {
      operation.current = false
      setProfileAction(null)
      setBusyScope(null)
    }
  }

  const handleSaveRenameSettings = async (
    activeProfileId = settings?.activeProfileId ?? ""
  ): Promise<boolean> => {
    if (!settings || busy || operation.current) {
      return false
    }
    if (!prompt.trim()) {
      setPromptFeedback({ error: true, message: "提示词不能为空。" })
      return false
    }
    operation.current = true
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
      setPromptFeedback(null)
      toast.success("AI 重命名提示词已保存", { id: "ai-prompt" })
      return true
    } catch (reason) {
      setPromptFeedback(null)
      toast.error(`保存失败：${toErrorMessage(reason)}`, {
        id: "ai-prompt",
        duration: 6_000,
      })
      return false
    } finally {
      operation.current = false
      setBusyScope(null)
    }
  }

  const handleDelete = async () => {
    if (!draft.id || busy || operation.current) {
      return
    }
    operation.current = true
    setProfileAction("delete")
    setBusyScope("profile")
    setProfileFeedback(null)
    try {
      const next = await deleteAiProfile(draft.id)
      setModels([])
      applySettings(next, undefined, false)
      setDeleteOpen(false)
      setProfileFeedback(null)
      toast.success("AI 配置和对应的系统凭据已删除", { id: "ai-profile" })
    } catch (reason) {
      setProfileFeedback(null)
      toast.error(`删除失败：${toErrorMessage(reason)}`, {
        id: "ai-profile",
        duration: 6_000,
      })
    } finally {
      operation.current = false
      setProfileAction(null)
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
    settings !== null && !prompt.trim() ? "提示词不能为空。" : null

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
    if (operation.current) return
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
    loading,
    loadError,
    retryLoad,
    isSubmitting: () => operation.current,
    settings,
    draft,
    setDraft,
    models,
    prompt,
    setPrompt,
    busy,
    profileBusy,
    profileAction,
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
