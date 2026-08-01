"use client"

import {
  Bot,
  Check,
  CircleAlert,
  KeyRound,
  Plus,
  RefreshCw,
  Save,
  Server,
  Trash2,
  Unplug,
} from "lucide-react"
import * as React from "react"

import { Alert, AlertDescription } from "@/components/ui/alert"
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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  useComboboxAnchor,
} from "@/components/ui/combobox"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
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

type ProfileDraft = {
  id: string | null
  name: string
  provider: AiProviderKind
  baseUrl: string
  model: string
  apiKey: string
  hasApiKey: boolean
  clearApiKey: boolean
}

type InvalidProfileField = "name" | "baseUrl"

type OperationFeedback = {
  message: string
  error: boolean
}

type PendingDraftAction =
  | { type: "create" }
  | { type: "select"; profile: AiProfile }

export type AiSettingsPanelHandle = {
  saveUnsavedChanges: () => Promise<boolean>
}

type AiSettingsPanelProps = {
  onDirtyChange?: (dirty: boolean) => void
}

const PROVIDERS = (Object.keys(AI_PROVIDER_DEFAULTS) as AiProviderKind[]).map(
  (provider) => {
    const defaults = AI_PROVIDER_DEFAULTS[provider]
    return {
      value: provider,
      ...defaults,
      label: `${defaults.label}${defaults.local ? "（本地）" : ""}`,
    }
  }
)

function formatModelSize(sizeBytes?: number): string | null {
  if (!sizeBytes || !Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return null
  }
  const sizeGigabytes = sizeBytes / 1_000_000_000
  return `${new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: sizeGigabytes >= 10 ? 1 : 2,
  }).format(sizeGigabytes)} GB`
}

function formatModelMetadata(model: AiModelInfo): string {
  return [formatModelSize(model.sizeBytes), model.parameterSize?.trim() || null]
    .filter((value): value is string => Boolean(value))
    .join(" · ")
}

export const AiSettingsPanel = React.forwardRef<
  AiSettingsPanelHandle,
  AiSettingsPanelProps
>(function AiSettingsPanel({ onDirtyChange }, ref) {
  const modelComboboxAnchor = useComboboxAnchor()
  const [settings, setSettings] = React.useState<AiSettings | null>(null)
  const [draft, setDraft] = React.useState<ProfileDraft>(() =>
    newProfileDraft("ollama")
  )
  const [models, setModels] = React.useState<AiModelInfo[]>([])
  const [prompt, setPrompt] = React.useState("")
  const [busyScope, setBusyScope] = React.useState<"profile" | "prompt" | null>(
    null
  )
  const busy = busyScope !== null
  const profileBusy = busyScope === "profile"
  const promptBusy = busyScope === "prompt"
  const [profileFeedback, setProfileFeedback] =
    React.useState<OperationFeedback | null>(null)
  const [promptFeedback, setPromptFeedback] =
    React.useState<OperationFeedback | null>(null)
  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const [pendingDraftAction, setPendingDraftAction] =
    React.useState<PendingDraftAction | null>(null)
  const [invalidField, setInvalidField] =
    React.useState<InvalidProfileField | null>(null)

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
      if (selected) {
        setDraft(profileToDraft(selected))
      } else {
        setDraft(newProfileDraft("ollama"))
      }
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
    if (action.type === "select") {
      setDraft(profileToDraft(action.profile))
    } else {
      setDraft(newProfileDraft("ollama"))
    }
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

  const validateDraft = (): {
    field: InvalidProfileField
    message: string
  } | null => {
    if (!draft.name.trim()) {
      return { field: "name", message: "请输入配置名称。" }
    }
    if (!draft.baseUrl.trim()) {
      return {
        field: "baseUrl",
        message: "请输入模型服务地址。",
      }
    }
    try {
      const url = new URL(draft.baseUrl.trim())
      if (!["http:", "https:"].includes(url.protocol) || !url.hostname) {
        throw new Error("invalid URL")
      }
    } catch {
      return {
        field: "baseUrl",
        message: "请输入有效的 http:// 或 https:// 服务地址。",
      }
    }
    return null
  }

  const clientDraftRequest = () => ({
    profileId: draft.id,
    provider: draft.provider,
    baseUrl: draft.baseUrl.trim(),
    model: draft.model.trim(),
    apiKey: draft.apiKey.trim() || undefined,
    clearApiKey: draft.clearApiKey,
  })

  const persistDraft = async (makeActive = false): Promise<string> => {
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
    const profileId = draft.id ?? next.activeProfileId
    applySettings(next, profileId, false)
    return profileId
  }

  const handleSaveProfile = async (makeActive = false): Promise<boolean> => {
    if (busy) {
      return false
    }
    const validationError = validateDraft()
    if (validationError) {
      setInvalidField(validationError.field)
      setProfileFeedback({ error: true, message: validationError.message })
      return false
    }
    setInvalidField(null)
    setBusyScope("profile")
    setProfileFeedback({ error: false, message: "正在保存 AI 配置…" })
    try {
      const shouldActivate = makeActive || draft.id === null
      await persistDraft(makeActive)
      setProfileFeedback({
        error: false,
        message: shouldActivate
          ? "配置已保存并设为当前 AI 模型。"
          : "AI 配置已保存。",
      })
      return true
    } catch (reason) {
      setProfileFeedback({
        error: true,
        message: `保存失败：${toErrorMessage(reason)}`,
      })
      return false
    } finally {
      setBusyScope(null)
    }
  }

  const handleLoadModels = async () => {
    if (busy) {
      return
    }
    const validationError = validateDraft()
    if (validationError) {
      setInvalidField(validationError.field)
      setProfileFeedback({ error: true, message: validationError.message })
      return
    }
    setInvalidField(null)
    setBusyScope("profile")
    setProfileFeedback({
      error: false,
      message: "正在获取当前草稿的模型列表，不会保存更改…",
    })
    try {
      const next = await listAiModels(clientDraftRequest())
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
    if (busy) {
      return
    }
    const validationError = validateDraft()
    if (validationError) {
      setInvalidField(validationError.field)
      setProfileFeedback({ error: true, message: validationError.message })
      return
    }
    setInvalidField(null)
    setBusyScope("profile")
    setProfileFeedback({
      error: false,
      message: "正在测试当前草稿，不会保存更改…",
    })
    try {
      const result = await testAiConnection(clientDraftRequest())
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

  const handleSaveRenameSettings = async (): Promise<boolean> => {
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
        activeProfileId: settings.activeProfileId,
        renamePrompt: prompt,
      })
      applySettings(next, draft.id)
      setPromptFeedback({
        error: false,
        message: "AI 重命名提示词已保存。",
      })
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
    if (busy) {
      return
    }
    if (action.type === "select" && action.profile.id === draft.id) {
      return
    }
    if (profileDirty) {
      setPendingDraftAction(action)
      return
    }
    applyDraftAction(action)
  }

  const handleSavePendingDraft = async () => {
    if (!pendingDraftAction) {
      return
    }
    const action = pendingDraftAction
    const saved = await handleSaveProfile(false)
    if (saved) {
      applyDraftAction(action)
    } else {
      setPendingDraftAction(null)
    }
  }

  React.useImperativeHandle(ref, () => ({
    saveUnsavedChanges: async () => {
      if (busy) {
        return false
      }
      if (profileDirty && !(await handleSaveProfile(false))) {
        return false
      }
      if (promptDirty && !(await handleSaveRenameSettings())) {
        return false
      }
      return true
    },
  }))

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

  return (
    <div className="flex flex-col gap-2">
      <Card size="sm">
        <CardHeader className="border-b border-border/80">
          <CardTitle>AI 模型配置</CardTitle>
          <CardDescription>
            可保存多个兼容 OpenAI 接口的模型服务配置。API Key
            仅保存在系统凭据中，不写入配置文件。
          </CardDescription>
          <CardAction>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => requestDraftAction({ type: "create" })}
            >
              <Plus data-icon="inline-start" />
              新建配置
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="grid gap-3 lg:grid-cols-[190px_minmax(0,1fr)]">
          <aside className="flex flex-col gap-1.5" aria-label="已保存 AI 配置">
            {settings === null ? (
              <div
                className="flex flex-col gap-2 p-1"
                aria-label="正在读取 AI 配置"
                aria-busy="true"
              >
                {[0, 1, 2].map((item) => (
                  <div key={item} className="flex items-center gap-2">
                    <Skeleton className="size-8 shrink-0" />
                    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                      <Skeleton className="h-3 w-2/3" />
                      <Skeleton className="h-2.5 w-full" />
                    </div>
                  </div>
                ))}
              </div>
            ) : settings.profiles.length === 0 ? (
              <Empty className="gap-2 border px-3 py-4">
                <EmptyHeader className="gap-1">
                  <EmptyMedia variant="icon">
                    <Bot />
                  </EmptyMedia>
                  <EmptyTitle>尚无 AI 配置</EmptyTitle>
                  <EmptyDescription>
                    右侧可创建本地模型或自定义兼容服务。
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              settings.profiles.map((profile) => (
                <Button
                  key={profile.id}
                  type="button"
                  variant={draft.id === profile.id ? "secondary" : "ghost"}
                  disabled={busy}
                  aria-pressed={draft.id === profile.id}
                  onClick={() =>
                    requestDraftAction({ type: "select", profile })
                  }
                  className="h-auto w-full justify-start text-left"
                >
                  <Server data-icon="inline-start" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {profile.name}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      {AI_PROVIDER_DEFAULTS[profile.provider].label}
                      {profile.model ? ` · ${profile.model}` : ""}
                    </span>
                  </span>
                  {settings.activeProfileId === profile.id ? (
                    <Check aria-label="当前配置" data-icon="inline-end" />
                  ) : null}
                </Button>
              ))
            )}
          </aside>

          <FieldGroup className="min-w-0 gap-4 lg:border-l lg:border-border/80 lg:pl-4">
            <FieldGroup className="grid gap-3 sm:grid-cols-2">
              <Field className="gap-1.5" data-invalid={invalidField === "name"}>
                <FieldLabel htmlFor="ai-profile-name">配置名称</FieldLabel>
                <Input
                  id="ai-profile-name"
                  value={draft.name}
                  disabled={busy}
                  aria-invalid={invalidField === "name"}
                  onChange={(event) => {
                    if (invalidField === "name") {
                      setInvalidField(null)
                    }
                    setProfileFeedback(null)
                    setDraft((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }}
                  placeholder="例如：本机 Ollama"
                />
                {invalidField === "name" ? (
                  <FieldError>请输入配置名称。</FieldError>
                ) : null}
              </Field>
              <Field className="gap-1.5">
                <FieldLabel htmlFor="ai-provider">服务类型</FieldLabel>
                <Select
                  items={PROVIDERS}
                  value={draft.provider}
                  disabled={busy}
                  onValueChange={(value) => {
                    if (value) {
                      handleProviderChange(value as AiProviderKind)
                    }
                  }}
                >
                  <SelectTrigger id="ai-provider" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    <SelectGroup>
                      {PROVIDERS.map((provider) => (
                        <SelectItem key={provider.value} value={provider.value}>
                          {provider.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            </FieldGroup>

            <Field
              className="gap-1.5"
              data-invalid={invalidField === "baseUrl"}
            >
              <FieldLabel htmlFor="ai-base-url">模型服务地址</FieldLabel>
              <Input
                id="ai-base-url"
                value={draft.baseUrl}
                disabled={busy}
                aria-invalid={invalidField === "baseUrl"}
                aria-describedby="ai-base-url-hint"
                onChange={(event) => {
                  if (invalidField === "baseUrl") {
                    setInvalidField(null)
                  }
                  setProfileFeedback(null)
                  setDraft((current) => ({
                    ...current,
                    baseUrl: event.target.value,
                  }))
                }}
                placeholder="http://127.0.0.1:11434/v1"
                spellCheck={false}
              />
              <FieldDescription id="ai-base-url-hint">
                用于读取模型列表和测试生成连接；本地服务无需联网。
              </FieldDescription>
              {invalidField === "baseUrl" ? (
                <FieldError>
                  {profileFeedback?.message ?? "请输入模型服务地址。"}
                </FieldError>
              ) : null}
            </Field>

            <Field className="gap-1.5">
              <FieldLabel htmlFor="ai-model">模型</FieldLabel>
              <Combobox
                items={models}
                value={models.find((model) => model.id === draft.model) ?? null}
                inputValue={draft.model}
                itemToStringLabel={(model: AiModelInfo) => model.id}
                itemToStringValue={(model: AiModelInfo) => model.id}
                isItemEqualToValue={(model, value) => model.id === value.id}
                onInputValueChange={(model, eventDetails) => {
                  if (eventDetails.reason !== "input-change") {
                    return
                  }
                  setProfileFeedback(null)
                  setDraft((current) => ({
                    ...current,
                    model,
                  }))
                }}
                onValueChange={(model) => {
                  if (!model) {
                    return
                  }
                  setProfileFeedback(null)
                  setDraft((current) => ({
                    ...current,
                    model: model.id,
                  }))
                }}
              >
                <div ref={modelComboboxAnchor}>
                  <ComboboxInput
                    id="ai-model"
                    disabled={busy}
                    className="w-full"
                    placeholder={
                      providerMeta.local
                        ? "获取本地模型，或手动填写"
                        : "输入服务提供的模型标识"
                    }
                    spellCheck={false}
                  >
                    <InputGroupAddon align="inline-end">
                      <InputGroupButton
                        variant="ghost"
                        disabled={busy}
                        onClick={handleLoadModels}
                        aria-label="获取模型"
                        title="获取模型"
                      >
                        <RefreshCw data-icon="inline-start" />
                        <span className="hidden sm:inline">获取模型</span>
                      </InputGroupButton>
                      <InputGroupButton
                        variant="ghost"
                        disabled={busy}
                        onClick={handleTest}
                        aria-label="测试"
                        title="测试"
                      >
                        <Unplug data-icon="inline-start" />
                        <span className="hidden sm:inline">测试</span>
                      </InputGroupButton>
                    </InputGroupAddon>
                  </ComboboxInput>
                </div>
                <ComboboxContent anchor={modelComboboxAnchor}>
                  <ComboboxEmpty>
                    {models.length === 0
                      ? "暂无模型列表，可先获取模型或直接输入模型标识。"
                      : "没有匹配模型，可直接使用当前输入。"}
                  </ComboboxEmpty>
                  <ComboboxList>
                    {(model: AiModelInfo) => {
                      const metadata = formatModelMetadata(model)
                      return (
                        <ComboboxItem key={model.id} value={model}>
                          <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                            <span className="truncate">{model.id}</span>
                            {metadata ? (
                              <span className="shrink-0 text-xs font-normal text-muted-foreground tabular-nums">
                                {metadata}
                              </span>
                            ) : null}
                          </span>
                        </ComboboxItem>
                      )
                    }}
                  </ComboboxList>
                </ComboboxContent>
              </Combobox>
            </Field>

            <Field className="gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <FieldLabel htmlFor="ai-api-key">API Key（可选）</FieldLabel>
                <Badge
                  variant={
                    draft.clearApiKey
                      ? "warning"
                      : draft.hasApiKey
                        ? "success"
                        : "outline"
                  }
                >
                  <KeyRound data-icon="inline-start" />
                  {draft.clearApiKey
                    ? "保存后清除"
                    : draft.hasApiKey
                      ? "系统已保存"
                      : providerMeta.local
                        ? "通常无需密钥"
                        : "尚未保存"}
                </Badge>
              </div>
              <InputGroup>
                <InputGroupInput
                  id="ai-api-key"
                  type="password"
                  value={draft.apiKey}
                  disabled={busy || draft.clearApiKey}
                  onChange={(event) => {
                    setProfileFeedback(null)
                    setDraft((current) => ({
                      ...current,
                      apiKey: event.target.value,
                      clearApiKey: false,
                    }))
                  }}
                  placeholder={
                    draft.hasApiKey
                      ? "留空则保留系统中已有的密钥"
                      : providerMeta.local
                        ? "本地服务通常可留空"
                        : "输入后保存到系统凭据存储"
                  }
                  autoComplete="off"
                />
                {draft.hasApiKey ? (
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton
                      variant={draft.clearApiKey ? "secondary" : "ghost"}
                      disabled={busy}
                      aria-pressed={draft.clearApiKey}
                      onClick={() => {
                        setProfileFeedback(null)
                        setDraft((current) => ({
                          ...current,
                          apiKey: "",
                          clearApiKey: !current.clearApiKey,
                        }))
                      }}
                    >
                      清除密钥
                    </InputGroupButton>
                  </InputGroupAddon>
                ) : null}
              </InputGroup>
            </Field>

            <FieldSeparator />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                {isActive ? <Badge variant="default">当前使用</Badge> : null}
                {draft.id === null || profileDirty ? (
                  <Badge variant="warning">
                    {draft.id ? "有未保存更改" : "新配置未保存"}
                  </Badge>
                ) : null}
                <span className="text-xs text-muted-foreground">
                  {providerMeta.local
                    ? "本地模型仅连接此设备"
                    : "仅在启用 AI 重命名时发起请求"}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {draft.id ? (
                  <>
                    {!isActive ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => void handleSaveProfile(true)}
                      >
                        设为当前
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      disabled={busy}
                      onClick={() => setDeleteOpen(true)}
                    >
                      <Trash2 data-icon="inline-start" />
                      删除
                    </Button>
                  </>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  disabled={busy || (draft.id !== null && !profileDirty)}
                  onClick={() => void handleSaveProfile(false)}
                >
                  {profileBusy ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <Save data-icon="inline-start" />
                  )}
                  保存配置
                </Button>
              </div>
            </div>
            {profileFeedback ? (
              <Alert
                aria-live="polite"
                variant={profileFeedback.error ? "destructive" : "default"}
                className="py-2.5"
              >
                {profileBusy ? (
                  <Spinner />
                ) : profileFeedback.error ? (
                  <CircleAlert />
                ) : (
                  <Check />
                )}
                <AlertDescription>{profileFeedback.message}</AlertDescription>
              </Alert>
            ) : null}
          </FieldGroup>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader className="border-b border-border/80">
          <div className="flex items-center gap-2">
            <CardTitle>归档重命名提示词</CardTitle>
            {promptDirty ? <Badge variant="warning">有未保存更改</Badge> : null}
          </div>
          <CardDescription>
            AI
            只会收到此提示词和你在压缩页填写的基础名称，不会读取或上传来源文件、路径和内容。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Field data-invalid={Boolean(renamePromptError)}>
            <FieldLabel htmlFor="ai-rename-prompt" className="sr-only">
              AI 重命名提示词
            </FieldLabel>
            <Textarea
              id="ai-rename-prompt"
              value={prompt}
              disabled={busy || settings === null}
              aria-invalid={Boolean(renamePromptError)}
              onChange={(event) => {
                setPrompt(event.target.value)
                setPromptFeedback(null)
              }}
              rows={4}
            />
            {renamePromptError ? (
              <FieldError>{renamePromptError}</FieldError>
            ) : null}
            <FieldDescription>
              最长 2000 字符；AI 结果会再次经过本机文件名安全处理。当前{" "}
              {prompt.length} / 2000。
            </FieldDescription>
          </Field>
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={
                busy ||
                settings === null ||
                Boolean(renamePromptError) ||
                !promptDirty
              }
              onClick={handleSaveRenameSettings}
            >
              {promptBusy ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <Save data-icon="inline-start" />
              )}
              保存提示词
            </Button>
          </div>
          {promptFeedback ? (
            <Alert
              aria-live="polite"
              variant={promptFeedback.error ? "destructive" : "default"}
              className="py-2.5"
            >
              {promptBusy ? (
                <Spinner />
              ) : promptFeedback.error ? (
                <CircleAlert />
              ) : (
                <Check />
              )}
              <AlertDescription>{promptFeedback.message}</AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      <AlertDialog
        open={pendingDraftAction !== null}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setPendingDraftAction(null)
          }
        }}
      >
        <AlertDialogContent size="default">
          <AlertDialogHeader>
            <AlertDialogTitle>保存当前更改？</AlertDialogTitle>
            <AlertDialogDescription>
              当前 AI 配置包含未保存更改。继续切换会丢弃这些内容。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>继续编辑</AlertDialogCancel>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => {
                if (pendingDraftAction) {
                  applyDraftAction(pendingDraftAction)
                }
              }}
            >
              放弃更改
            </Button>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault()
                void handleSavePendingDraft()
              }}
            >
              {profileBusy ? <Spinner data-icon="inline-start" /> : null}
              保存并继续
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>删除 AI 配置？</AlertDialogTitle>
            <AlertDialogDescription>
              将删除“{draft.name || "未命名配置"}”及其系统凭据。此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={handleDelete}
            >
              {profileBusy ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <Trash2 data-icon="inline-start" />
              )}
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
})

function newProfileDraft(provider: AiProviderKind): ProfileDraft {
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

function profileToDraft(profile: AiProfile): ProfileDraft {
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

function isProfileDraftDirty(
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

function toErrorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason ?? "未知错误")
}
