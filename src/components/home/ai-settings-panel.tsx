"use client"

import {
  Bot,
  Check,
  CircleAlert,
  KeyRound,
  LoaderCircle,
  Plus,
  RefreshCw,
  Save,
  Server,
  Sparkles,
  Trash2,
  Unplug,
} from "lucide-react"
import * as React from "react"

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
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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
import { cn } from "@/lib/utils"

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

const PROVIDERS = (Object.keys(AI_PROVIDER_DEFAULTS) as AiProviderKind[]).map(
  (provider) => ({
    value: provider,
    ...AI_PROVIDER_DEFAULTS[provider],
  })
)

export function AiSettingsPanel() {
  const [settings, setSettings] = React.useState<AiSettings | null>(null)
  const [draft, setDraft] = React.useState<ProfileDraft>(() =>
    newProfileDraft("deepSeek")
  )
  const [models, setModels] = React.useState<AiModelInfo[]>([])
  const [prompt, setPrompt] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [message, setMessage] = React.useState<string | null>(null)
  const [error, setError] = React.useState(false)
  const [deleteOpen, setDeleteOpen] = React.useState(false)

  const applySettings = React.useCallback(
    (next: AiSettings, preferredId?: string | null) => {
      setSettings(next)
      setPrompt(next.renamePrompt)
      const selected =
        next.profiles.find((profile) => profile.id === preferredId) ??
        next.profiles.find((profile) => profile.id === next.activeProfileId) ??
        next.profiles[0]
      if (selected) {
        setDraft(profileToDraft(selected))
      } else {
        setDraft(newProfileDraft("deepSeek"))
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
          setError(true)
          setMessage(`读取 AI 配置失败：${toErrorMessage(reason)}`)
        }
      })
    return () => {
      disposed = true
    }
  }, [applySettings])

  const handleSelectProfile = (profile: AiProfile) => {
    if (busy) {
      return
    }
    setDraft(profileToDraft(profile))
    setModels([])
    setError(false)
    setMessage(null)
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
  }

  const validateDraft = (): string | null => {
    if (!draft.name.trim()) {
      return "请输入配置名称。"
    }
    if (!draft.baseUrl.trim()) {
      return "请输入 OpenAI-compatible 服务地址。"
    }
    return null
  }

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
    applySettings(next, profileId)
    return profileId
  }

  const handleSaveProfile = async (makeActive = false) => {
    if (busy) {
      return
    }
    const validationError = validateDraft()
    if (validationError) {
      setError(true)
      setMessage(validationError)
      return
    }
    setBusy(true)
    setError(false)
    setMessage("正在保存 AI 配置…")
    try {
      const shouldActivate = makeActive || draft.id === null
      await persistDraft(makeActive)
      setMessage(
        shouldActivate ? "配置已保存并设为当前 AI 模型。" : "AI 配置已保存。"
      )
    } catch (reason) {
      setError(true)
      setMessage(`保存失败：${toErrorMessage(reason)}`)
    } finally {
      setBusy(false)
    }
  }

  const handleLoadModels = async () => {
    if (busy) {
      return
    }
    const validationError = validateDraft()
    if (validationError) {
      setError(true)
      setMessage(validationError)
      return
    }
    setBusy(true)
    setError(false)
    setMessage("正在保存当前配置并获取模型列表…")
    try {
      const profileId = await persistDraft()
      const next = await listAiModels(profileId)
      setModels(next)
      setMessage(
        next.length > 0
          ? `已获取 ${next.length} 个模型，可从列表选择或继续手动填写。`
          : "连接成功，但服务没有返回模型；可手动填写模型标识。"
      )
    } catch (reason) {
      setError(true)
      setMessage(`获取模型失败：${toErrorMessage(reason)}`)
    } finally {
      setBusy(false)
    }
  }

  const handleTest = async () => {
    if (busy) {
      return
    }
    const validationError = validateDraft()
    if (validationError) {
      setError(true)
      setMessage(validationError)
      return
    }
    setBusy(true)
    setError(false)
    setMessage("正在保存当前配置并测试 OpenAI-compatible 连接…")
    try {
      const profileId = await persistDraft()
      const result = await testAiConnection(profileId)
      setError(!result.success)
      setMessage(result.message)
    } catch (reason) {
      setError(true)
      setMessage(`连接失败：${toErrorMessage(reason)}`)
    } finally {
      setBusy(false)
    }
  }

  const handleSaveRenameSettings = async () => {
    if (!settings || busy) {
      return
    }
    setBusy(true)
    setError(false)
    setMessage("正在保存 AI 重命名设置…")
    try {
      const next = await updateAiSettings({
        activeProfileId: settings.activeProfileId,
        renamePrompt: prompt,
      })
      applySettings(next, draft.id)
      setMessage("AI 重命名提示词已保存。")
    } catch (reason) {
      setError(true)
      setMessage(`保存失败：${toErrorMessage(reason)}`)
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async () => {
    if (!draft.id || busy) {
      return
    }
    setBusy(true)
    setError(false)
    try {
      const next = await deleteAiProfile(draft.id)
      setModels([])
      applySettings(next)
      setDeleteOpen(false)
      setMessage("AI 配置和对应的系统凭据已删除。")
    } catch (reason) {
      setError(true)
      setMessage(`删除失败：${toErrorMessage(reason)}`)
    } finally {
      setBusy(false)
    }
  }

  const isActive = draft.id !== null && settings?.activeProfileId === draft.id
  const providerMeta = AI_PROVIDER_DEFAULTS[draft.provider]

  return (
    <div className="space-y-2">
      <Card size="sm">
        <CardHeader className="border-b border-border/80">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <Sparkles className="size-4 text-muted-foreground" />
                <CardTitle className="text-sm">AI 模型配置</CardTitle>
              </div>
              <CardDescription className="mt-1 text-xs leading-relaxed">
                可保存多个 OpenAI-compatible 配置。API Key
                仅保存在系统凭据存储中，不写入 settings.json。
              </CardDescription>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setDraft(newProfileDraft("deepSeek"))
                setModels([])
                setMessage(null)
                setError(false)
              }}
            >
              <Plus data-icon="inline-start" />
              新建配置
            </Button>
          </div>
        </CardHeader>
        <CardContent className="grid gap-3 pt-4 lg:grid-cols-[190px_minmax(0,1fr)]">
          <aside className="space-y-1.5" aria-label="已保存 AI 配置">
            {settings === null ? (
              <div className="flex items-center gap-2 rounded-xl bg-muted/50 px-3 py-3 text-xs text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" />
                正在读取配置…
              </div>
            ) : settings.profiles.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border px-3 py-4 text-center">
                <Bot className="mx-auto size-5 text-muted-foreground" />
                <p className="mt-2 text-xs font-medium">尚无 AI 配置</p>
                <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                  右侧可直接创建 DeepSeek，也可切换为本地模型。
                </p>
              </div>
            ) : (
              settings.profiles.map((profile) => (
                <button
                  key={profile.id}
                  type="button"
                  disabled={busy}
                  onClick={() => handleSelectProfile(profile)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-xl border px-2.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                    draft.id === profile.id
                      ? "border-foreground/30 bg-muted"
                      : "border-transparent hover:border-border hover:bg-muted/50"
                  )}
                >
                  <Server className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium">
                      {profile.name}
                    </span>
                    <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                      {AI_PROVIDER_DEFAULTS[profile.provider].label}
                      {profile.model ? ` · ${profile.model}` : ""}
                    </span>
                  </span>
                  {settings.activeProfileId === profile.id ? (
                    <Check
                      aria-label="当前配置"
                      className="size-3.5 shrink-0"
                    />
                  ) : null}
                </button>
              ))
            )}
          </aside>

          <div className="min-w-0 space-y-3 rounded-xl border border-border/80 p-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="ai-profile-name">配置名称</Label>
                <Input
                  id="ai-profile-name"
                  value={draft.name}
                  disabled={busy}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                  placeholder="例如：本机 Ollama"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ai-provider">服务类型</Label>
                <select
                  id="ai-provider"
                  value={draft.provider}
                  disabled={busy}
                  onChange={(event) =>
                    handleProviderChange(event.target.value as AiProviderKind)
                  }
                  className="h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {PROVIDERS.map((provider) => (
                    <option key={provider.value} value={provider.value}>
                      {provider.label}
                      {provider.local ? "（本地）" : ""}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ai-base-url">OpenAI-compatible 地址</Label>
              <Input
                id="ai-base-url"
                value={draft.baseUrl}
                disabled={busy}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    baseUrl: event.target.value,
                  }))
                }
                placeholder="http://127.0.0.1:11434/v1"
                spellCheck={false}
              />
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                将使用 GET /models 与 POST /chat/completions；本地服务无需联网。
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
              <div className="space-y-1.5">
                <Label htmlFor="ai-model">模型</Label>
                <Input
                  id="ai-model"
                  list="ai-model-options"
                  value={draft.model}
                  disabled={busy}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      model: event.target.value,
                    }))
                  }
                  placeholder={
                    providerMeta.local
                      ? "获取本地模型，或手动填写"
                      : "例如：deepseek-chat"
                  }
                  spellCheck={false}
                />
                <datalist id="ai-model-options">
                  {models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.ownedBy}
                    </option>
                  ))}
                </datalist>
              </div>
              <div className="flex items-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={handleLoadModels}
                >
                  <RefreshCw data-icon="inline-start" />
                  获取模型
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={handleTest}
                >
                  <Unplug data-icon="inline-start" />
                  测试
                </Button>
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="ai-api-key">API Key（可选）</Label>
                <Badge variant="outline" className="font-normal">
                  <KeyRound className="size-3" />
                  {draft.clearApiKey
                    ? "保存后清除"
                    : draft.hasApiKey
                      ? "系统已保存"
                      : "尚未保存"}
                </Badge>
              </div>
              <div className="flex gap-2">
                <Input
                  id="ai-api-key"
                  type="password"
                  value={draft.apiKey}
                  disabled={busy || draft.clearApiKey}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      apiKey: event.target.value,
                      clearApiKey: false,
                    }))
                  }
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
                  <Button
                    type="button"
                    variant={draft.clearApiKey ? "secondary" : "outline"}
                    size="sm"
                    disabled={busy}
                    aria-pressed={draft.clearApiKey}
                    onClick={() =>
                      setDraft((current) => ({
                        ...current,
                        apiKey: "",
                        clearApiKey: !current.clearApiKey,
                      }))
                    }
                  >
                    清除密钥
                  </Button>
                ) : null}
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/70 pt-3">
              <div className="flex items-center gap-1.5">
                {isActive ? (
                  <Badge variant="default" className="font-normal">
                    当前使用
                  </Badge>
                ) : null}
                <span className="text-[10px] text-muted-foreground">
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
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      className="text-destructive hover:text-destructive"
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
                  disabled={busy}
                  onClick={() => void handleSaveProfile(false)}
                >
                  {busy ? (
                    <LoaderCircle
                      className="animate-spin"
                      data-icon="inline-start"
                    />
                  ) : (
                    <Save data-icon="inline-start" />
                  )}
                  保存配置
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader className="border-b border-border/80">
          <CardTitle className="text-sm">归档重命名提示词</CardTitle>
          <CardDescription className="text-xs leading-relaxed">
            AI
            只会收到此提示词和你在压缩页填写的基础名称，不会读取或上传来源文件、路径和内容。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 pt-4">
          <Textarea
            value={prompt}
            disabled={busy || settings === null}
            onChange={(event) => setPrompt(event.target.value)}
            rows={4}
            aria-label="AI 重命名提示词"
          />
          <div className="flex items-center justify-between gap-3">
            <p className="text-[10px] text-muted-foreground">
              最长 2000 字符；AI 结果会再次经过本机文件名安全处理。
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || settings === null}
              onClick={handleSaveRenameSettings}
            >
              <Save data-icon="inline-start" />
              保存提示词
            </Button>
          </div>
        </CardContent>
      </Card>

      {message ? (
        <p
          aria-live="polite"
          className={cn(
            "flex items-start gap-2 rounded-xl px-3 py-2 text-xs leading-relaxed",
            error
              ? "bg-destructive/10 text-destructive"
              : "bg-muted/60 text-muted-foreground"
          )}
        >
          {error ? (
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          ) : (
            <Check className="mt-0.5 size-3.5 shrink-0" />
          )}
          {message}
        </p>
      ) : null}

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
              {busy ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

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

function toErrorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason ?? "未知错误")
}
