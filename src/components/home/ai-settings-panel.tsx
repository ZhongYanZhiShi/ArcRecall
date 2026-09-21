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

import { useAiSettingsController } from "@/components/home/use-ai-settings-controller"
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
  type AiModelInfo,
  type AiProviderKind,
} from "@/lib/ai"

export type AiSettingsPanelHandle = {
  saveUnsavedChanges: () => Promise<boolean>
  discardUnsavedChanges: () => void
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
  const controller = useAiSettingsController({ onDirtyChange })
  const {
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
  } = controller

  React.useImperativeHandle(
    ref,
    () => ({ saveUnsavedChanges, discardUnsavedChanges }),
    [saveUnsavedChanges, discardUnsavedChanges]
  )

  return (
    <div className="flex flex-col gap-2">
      <Card size="sm">
        <CardHeader className="border-b border-border/80">
          <CardTitle>AI 模型配置</CardTitle>
          <CardDescription>
            支持兼容 OpenAI 接口的服务；API Key 仅保存在系统凭据中。
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
                  <EmptyDescription>填写并保存模型服务配置。</EmptyDescription>
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
            仅发送提示词和基础名称，不读取或上传文件、路径或内容。
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
            <FieldDescription>{prompt.length} / 2000 字符</FieldDescription>
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
              onClick={() => void handleSaveRenameSettings()}
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
