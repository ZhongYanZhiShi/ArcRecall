"use client"

import { FullText } from "@/components/home/full-text"
import { WorkbenchDetails } from "./workbench-details"

import {
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
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import {
  AI_PROVIDER_DEFAULTS,
  type AiModelInfo,
  type AiProviderKind,
} from "@/lib/ai"

export type AiSettingsPanelHandle = {
  isSubmitting: () => boolean
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
  } = controller

  React.useImperativeHandle(
    ref,
    () => ({
      saveUnsavedChanges,
      discardUnsavedChanges,
      isSubmitting: controller.isSubmitting,
    }),
    [saveUnsavedChanges, discardUnsavedChanges, controller.isSubmitting]
  )

  const renamePromptControl = (
    <WorkbenchDetails
      title="归档重命名提示词"
      pending={promptDirty}
      label={promptDirty ? "编辑提示词 · 未保存" : "编辑提示词"}
      description="定义 AI 生成归档名称的规则，保存后用于后续压缩任务。"
      bodyClassName="ai-prompt-body"
      footer={
        <div className="flex flex-col gap-3">
          {promptFeedback && !renamePromptError ? (
            <Alert
              aria-live="polite"
              variant={promptFeedback.error ? "destructive" : "default"}
              className="max-h-28 overflow-y-auto py-2.5"
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
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>{prompt.length} 字符</span>
              {promptDirty ? (
                <Badge variant="warning">有未保存更改</Badge>
              ) : null}
            </div>
            <Button
              type="button"
              size="sm"
              disabled={
                busy ||
                settings === null ||
                Boolean(renamePromptError) ||
                !promptDirty
              }
              onClick={() => void handleSaveRenameSettings()}
              aria-busy={promptBusy}
            >
              {promptBusy ? (
                <Spinner aria-hidden="true" data-icon="inline-start" />
              ) : (
                <Save data-icon="inline-start" />
              )}
              {promptBusy ? "保存中…" : "保存提示词"}
            </Button>
          </div>
        </div>
      }
    >
      <p
        id="ai-rename-prompt-help"
        className="text-xs leading-relaxed text-muted-foreground"
      >
        默认发送提示词和基础名称；在压缩页开启文件内容参考后，还会发送匹配文本的内容摘录和文件名。
      </p>
      <Field data-invalid={Boolean(renamePromptError)}>
        <FieldLabel htmlFor="ai-rename-prompt" className="sr-only">
          AI 重命名提示词
        </FieldLabel>
        <Textarea
          id="ai-rename-prompt"
          data-settings-pending={promptDirty || undefined}
          value={prompt}
          disabled={busy || settings === null}
          aria-invalid={Boolean(renamePromptError)}
          aria-describedby={
            renamePromptError
              ? "ai-rename-prompt-help ai-rename-prompt-error"
              : "ai-rename-prompt-help"
          }
          onChange={(event) => {
            setPrompt(event.target.value)
            setPromptFeedback(null)
          }}
        />
        {renamePromptError ? (
          <FieldError id="ai-rename-prompt-error">
            {renamePromptError}
          </FieldError>
        ) : null}
      </Field>
    </WorkbenchDetails>
  )

  if (settings === null) {
    return (
      <Empty
        role="status"
        aria-busy={controller.loading}
        className="border-0 p-4"
      >
        <EmptyHeader>
          <EmptyMedia variant="icon">
            {controller.loading ? <Spinner /> : <CircleAlert />}
          </EmptyMedia>
          <EmptyTitle>
            {controller.loading ? "正在读取 AI 配置" : "AI 配置读取失败"}
          </EmptyTitle>
          <EmptyDescription className="[overflow-wrap:anywhere] break-words">
            {controller.loading
              ? "正在读取已保存的模型服务和提示词。"
              : controller.loadError}
          </EmptyDescription>
        </EmptyHeader>
        {!controller.loading ? (
          <Button onClick={controller.retryLoad}>重试读取配置</Button>
        ) : null}
      </Empty>
    )
  }

  return (
    <div className="byte-ai-panel flex flex-col gap-4">
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
        <CardContent
          className={
            settings?.profiles.length === 0
              ? "grid min-w-0 grid-cols-1 gap-4"
              : "grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[190px_minmax(0,1fr)]"
          }
        >
          {settings && settings.profiles.length > 0 ? (
            <div className="min-w-0 lg:hidden">
              <Select
                items={settings.profiles.map((profile) => ({
                  value: profile.id,
                  label: profile.name,
                }))}
                value={draft.id}
                disabled={busy}
                onValueChange={(value) => {
                  const profile = settings.profiles.find(
                    (profile) => profile.id === value
                  )
                  if (profile) requestDraftAction({ type: "select", profile })
                }}
              >
                <SelectTrigger
                  aria-label="已保存 AI 配置"
                  className="w-full min-w-0"
                >
                  <SelectValue placeholder="选择已有配置">
                    {settings.profiles.find(
                      (profile) => profile.id === draft.id
                    )?.name ? (
                      <FullText
                        text={
                          settings.profiles.find(
                            (profile) => profile.id === draft.id
                          )!.name
                        }
                        focusable={false}
                      />
                    ) : (
                      "选择已有配置"
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  <SelectGroup>
                    {settings.profiles.map((profile) => (
                      <SelectItem key={profile.id} value={profile.id}>
                        <FullText text={profile.name} focusable={false} />
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <aside
            className={
              settings?.profiles.length === 0
                ? "hidden"
                : "hidden min-w-0 flex-col gap-1.5 lg:flex"
            }
            aria-label="已保存 AI 配置"
          >
            {settings.profiles.map((profile) => (
              <Button
                key={profile.id}
                type="button"
                variant={draft.id === profile.id ? "secondary" : "ghost"}
                disabled={busy}
                aria-pressed={draft.id === profile.id}
                onClick={() => requestDraftAction({ type: "select", profile })}
                className="h-auto w-full min-w-0 justify-start text-left"
              >
                <Server data-icon="inline-start" />
                <span className="min-w-0 flex-1">
                  <FullText
                    text={profile.name}
                    focusable={false}
                    className="text-sm font-medium"
                  />
                  <FullText
                    text={`${AI_PROVIDER_DEFAULTS[profile.provider].label}${profile.model ? ` · ${profile.model}` : ""}`}
                    focusable={false}
                    className="mt-0.5 text-xs text-muted-foreground"
                  />
                </span>
                {settings.activeProfileId === profile.id ? (
                  <Check aria-label="当前配置" data-icon="inline-end" />
                ) : null}
              </Button>
            ))}
          </aside>

          <FieldGroup
            data-ai-profile-fields
            className={
              settings?.profiles.length === 0
                ? "min-w-0 gap-4"
                : "min-w-0 gap-4 lg:border-l lg:border-border/80 lg:pl-4"
            }
          >
            <FieldGroup className="grid gap-3 sm:grid-cols-2">
              <Field className="gap-1.5" data-invalid={invalidField === "name"}>
                <FieldLabel htmlFor="ai-profile-name">配置名称</FieldLabel>
                <Input
                  id="ai-profile-name"
                  data-settings-pending={profileDirty || undefined}
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
                        aria-busy={profileAction === "models"}
                      >
                        {profileAction === "models" ? (
                          <Spinner
                            aria-hidden="true"
                            data-icon="inline-start"
                          />
                        ) : (
                          <RefreshCw data-icon="inline-start" />
                        )}
                        <span className="hidden sm:inline">获取模型</span>
                      </InputGroupButton>
                      <InputGroupButton
                        variant="ghost"
                        disabled={busy}
                        onClick={handleTest}
                        aria-label="测试"
                        title="测试"
                        aria-busy={profileAction === "test"}
                      >
                        {profileAction === "test" ? (
                          <Spinner
                            aria-hidden="true"
                            data-icon="inline-start"
                          />
                        ) : (
                          <Unplug data-icon="inline-start" />
                        )}
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
            {profileFeedback && !invalidField ? (
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
        <div className="byte-ai-actions flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
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
                    aria-busy={profileAction === "activate"}
                  >
                    {profileAction === "activate" ? "设置中…" : "设为当前"}
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
              aria-busy={profileAction === "save"}
            >
              {profileAction === "save" ? (
                <Spinner aria-hidden="true" data-icon="inline-start" />
              ) : (
                <Save data-icon="inline-start" />
              )}
              {profileAction === "save" ? "保存中…" : "保存配置"}
            </Button>
          </div>
        </div>
      </Card>
      <section
        aria-labelledby="rename-prompt-heading"
        className="flex shrink-0 flex-col items-start gap-3 border-t pt-4"
      >
        <div>
          <h3 id="rename-prompt-heading" className="text-sm font-medium">
            归档重命名
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            编辑 AI 为归档生成名称时使用的提示词。
          </p>
        </div>
        {renamePromptControl}
      </section>

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
              {profileBusy ? (
                <Spinner aria-hidden="true" data-icon="inline-start" />
              ) : null}
              保存并继续
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (!busy) setDeleteOpen(open)
        }}
      >
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
                <Spinner aria-hidden="true" data-icon="inline-start" />
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
