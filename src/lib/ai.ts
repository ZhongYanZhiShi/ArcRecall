import { invoke } from "@tauri-apps/api/core"

import { isDesktopRuntime } from "@/lib/dictionary"

export type AiProviderKind = "ollama" | "lmStudio" | "custom"

export type AiProfile = {
  id: string
  name: string
  provider: AiProviderKind
  baseUrl: string
  model: string
  hasApiKey: boolean
}

export type AiSettings = {
  profiles: AiProfile[]
  activeProfileId: string
  renamePrompt: string
}

export type AiProfileUpsertRequest = {
  id?: string | null
  name: string
  provider: AiProviderKind
  baseUrl: string
  model: string
  apiKey?: string | null
  clearApiKey?: boolean
  makeActive?: boolean
}

export type AiSettingsUpdateRequest = {
  activeProfileId: string
  renamePrompt: string
}

export type AiModelInfo = {
  id: string
  ownedBy: string
  sizeBytes?: number
  parameterSize?: string
}

export type AiConnectionTestResult = {
  success: boolean
  message: string
  modelCount: number
}

export type AiClientDraftRequest = {
  profileId?: string | null
  provider: AiProviderKind
  baseUrl: string
  model: string
  apiKey?: string | null
  clearApiKey?: boolean
}

export const DEFAULT_AI_RENAME_PROMPT =
  "命名规则要以windows的文件命名规则来进行"

export const AI_PROVIDER_DEFAULTS: Record<
  AiProviderKind,
  { label: string; baseUrl: string; model: string; local: boolean }
> = {
  ollama: {
    label: "Ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "",
    local: true,
  },
  lmStudio: {
    label: "LM Studio",
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "",
    local: true,
  },
  custom: {
    label: "自定义兼容服务",
    baseUrl: "",
    model: "",
    local: false,
  },
}

export async function listAiProfiles(): Promise<AiSettings> {
  if (!isDesktopRuntime()) {
    return {
      profiles: [],
      activeProfileId: "",
      renamePrompt: DEFAULT_AI_RENAME_PROMPT,
    }
  }
  return invoke<AiSettings>("ai_profiles_list")
}

export async function upsertAiProfile(
  request: AiProfileUpsertRequest
): Promise<AiSettings> {
  requireDesktopRuntime()
  return invoke<AiSettings>("ai_profile_upsert", { request })
}

export async function deleteAiProfile(profileId: string): Promise<AiSettings> {
  requireDesktopRuntime()
  return invoke<AiSettings>("ai_profile_delete", { profileId })
}

export async function updateAiSettings(
  request: AiSettingsUpdateRequest
): Promise<AiSettings> {
  requireDesktopRuntime()
  return invoke<AiSettings>("ai_settings_update", { request })
}

export async function listAiModels(
  request: AiClientDraftRequest
): Promise<AiModelInfo[]> {
  requireDesktopRuntime()
  return invoke<AiModelInfo[]>("ai_models_list", { request })
}

export async function testAiConnection(
  request: AiClientDraftRequest
): Promise<AiConnectionTestResult> {
  requireDesktopRuntime()
  return invoke<AiConnectionTestResult>("ai_connection_test", { request })
}

export async function generateAiArchiveName(
  baseName: string,
  profileId?: string,
  prompt?: string
): Promise<string> {
  requireDesktopRuntime()
  return invoke<string>("ai_generate_archive_name", {
    baseName,
    profileId: profileId || null,
    prompt: prompt || null,
  })
}

function requireDesktopRuntime(): void {
  if (!isDesktopRuntime()) {
    throw new Error("AI 模型调用需要在 ArcRecall 桌面版中运行。")
  }
}
