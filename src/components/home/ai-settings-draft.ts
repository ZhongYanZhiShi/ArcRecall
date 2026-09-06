import {
  AI_PROVIDER_DEFAULTS,
  type AiProfile,
  type AiProviderKind,
} from "@/lib/ai"
import { validateAiServiceUrl } from "@/lib/ai-url"

export type ProfileDraft = {
  id: string | null
  name: string
  provider: AiProviderKind
  baseUrl: string
  model: string
  apiKey: string
  hasApiKey: boolean
  clearApiKey: boolean
}

export type InvalidProfileField = "name" | "baseUrl"

export type ProfileDraftValidation = {
  field: InvalidProfileField
  message: string
}

export function newProfileDraft(provider: AiProviderKind): ProfileDraft {
  const defaults = AI_PROVIDER_DEFAULTS[provider]
  return {
    id: null,
    name: defaults.label,
    provider,
    baseUrl: defaults.baseUrl,
    model: defaults.model,
    apiKey: "",
    hasApiKey: false,
    clearApiKey: false,
  }
}

export function profileToDraft(profile: AiProfile): ProfileDraft {
  return {
    id: profile.id,
    name: profile.name,
    provider: profile.provider,
    baseUrl: profile.baseUrl,
    model: profile.model,
    apiKey: "",
    hasApiKey: profile.hasApiKey,
    clearApiKey: false,
  }
}

export function isProfileDraftDirty(
  draft: ProfileDraft,
  profile: AiProfile | undefined
): boolean {
  if (!profile) {
    const initial = newProfileDraft("ollama")
    return (
      draft.name !== initial.name ||
      draft.provider !== initial.provider ||
      draft.baseUrl !== initial.baseUrl ||
      draft.model !== initial.model ||
      draft.apiKey.trim().length > 0 ||
      draft.clearApiKey
    )
  }
  return (
    draft.name !== profile.name ||
    draft.provider !== profile.provider ||
    draft.baseUrl !== profile.baseUrl ||
    draft.model !== profile.model ||
    draft.apiKey.trim().length > 0 ||
    draft.clearApiKey
  )
}

export function validateProfileDraft(
  draft: ProfileDraft
): ProfileDraftValidation | null {
  if (!draft.name.trim()) {
    return { field: "name", message: "请输入配置名称。" }
  }
  if (!draft.baseUrl.trim()) {
    return { field: "baseUrl", message: "请输入模型服务地址。" }
  }
  const baseUrlError = validateAiServiceUrl(draft.baseUrl)
  return baseUrlError ? { field: "baseUrl", message: baseUrlError } : null
}

export function aiClientDraftRequest(draft: ProfileDraft) {
  return {
    profileId: draft.id,
    provider: draft.provider,
    baseUrl: draft.baseUrl.trim(),
    model: draft.model.trim(),
    apiKey: draft.apiKey.trim() || undefined,
    clearApiKey: draft.clearApiKey,
  }
}
