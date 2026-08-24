"use client"

import {
  ArrowLeft,
  CircleAlert,
  Cpu,
  Database,
  Download,
  ExternalLink,
  HardDrive,
  Package,
  RefreshCw,
  Sparkles,
  Settings2,
  Zap,
} from "lucide-react"
import * as React from "react"

import {
  AiSettingsPanel,
  type AiSettingsPanelHandle,
} from "@/components/home/ai-settings-panel"
import {
  WorkbenchPage,
  WorkbenchPageContent,
  WorkbenchPageHeader,
} from "@/components/layout/workbench-page"
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
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  getRecoveryCapabilities,
  refreshRecoveryCapabilities,
  type RecoveryCapabilities,
  type RecoveryComputeMode,
} from "@/lib/recovery"
import {
  type AppLogLevel,
  type AppSettings,
  type DatabaseInfo,
  type FullEngineBundleStatus,
  type HashcatStatus,
  type JohnPerlStatus,
  DEFAULT_LOG_MAX_DISK_MIB,
  MAX_LOG_MAX_DISK_MIB,
  MIN_LOG_MAX_DISK_MIB,
  downloadHashcat,
  getDatabaseInfo,
  getFullEngineBundleStatus,
  getHashcatStatus,
  getJohnPerlStatus,
  getSettings,
  installFullEngineBundle,
  openPath,
  setJohnPerl as saveJohnPerlPaths,
  setSettings,
  setToolsDirectory,
} from "@/lib/settings"

export type SettingsCategory = "ai" | "engine" | "app" | "data"

export type SettingsPageHandle = {
  saveAiChanges: () => Promise<boolean>
}

const CATEGORIES: {
  id: SettingsCategory
  label: string
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>
  description: string
}[] = [
  {
    id: "ai",
    label: "AI 模型",
    icon: Sparkles,
    description: "模型服务、系统凭据、模型列表与重命名提示词",
  },
  {
    id: "engine",
    label: "解密引擎",
    icon: Cpu,
    description: "7-Zip、Hashcat、John 与 CPU / GPU 能力",
  },
  {
    id: "app",
    label: "应用",
    icon: Settings2,
    description: "日志级别、容量与 7-Zip 运行诊断",
  },
  {
    id: "data",
    label: "数据",
    icon: Database,
    description: "本机 SQLite 与设置文件位置",
  },
]

const LOG_LEVELS: {
  value: AppLogLevel
  label: string
  description: string
}[] = [
  { value: "error", label: "错误", description: "仅保留失败事件" },
  { value: "warn", label: "警告", description: "错误与风险提示" },
  { value: "info", label: "信息", description: "推荐的日常运行记录" },
  { value: "debug", label: "调试", description: "包含更细的界面诊断" },
]

const LOG_CAPACITY_PRESETS = [25, 100, 250, 500] as const

type EngineStatusSnapshot = {
  fullBundle: FullEngineBundleStatus
  hashcat: HashcatStatus
  johnPerl: JohnPerlStatus
  recoveryCapabilities: RecoveryCapabilities
}

let cachedEngineStatus: EngineStatusSnapshot | null = null

type SettingsPageProps = {
  initialCategory?: SettingsCategory
  categoryRequestId?: number
  returnAction?: {
    label: string
    onClick: () => void
  }
  onAiDirtyChange?: (dirty: boolean) => void
}

type PendingSettingsLeave =
  | { type: "category"; category: SettingsCategory }
  | { type: "return" }

export const SettingsPage = React.forwardRef<
  SettingsPageHandle,
  SettingsPageProps
>(function SettingsPage(
  {
    initialCategory = "engine",
    categoryRequestId = 0,
    returnAction,
    onAiDirtyChange,
  },
  ref
) {
  const aiSettingsPanelRef = React.useRef<AiSettingsPanelHandle>(null)
  const [category, setCategory] =
    React.useState<SettingsCategory>(initialCategory)
  const [handledCategoryRequestId, setHandledCategoryRequestId] =
    React.useState(categoryRequestId)
  const [aiDirty, setAiDirty] = React.useState(false)
  const [pendingSettingsLeave, setPendingSettingsLeave] =
    React.useState<PendingSettingsLeave | null>(null)
  const [leaveSaveBusy, setLeaveSaveBusy] = React.useState(false)
  const [dbInfo, setDbInfo] = React.useState<DatabaseInfo | null>(null)
  const [fullBundle, setFullBundle] =
    React.useState<FullEngineBundleStatus | null>(
      () => cachedEngineStatus?.fullBundle ?? null
    )
  const [hashcat, setHashcat] = React.useState<HashcatStatus | null>(
    () => cachedEngineStatus?.hashcat ?? null
  )
  const [johnPerl, setJohnPerl] = React.useState<JohnPerlStatus | null>(
    () => cachedEngineStatus?.johnPerl ?? null
  )
  const [appSettings, setAppSettings] = React.useState<AppSettings | null>(null)
  const [recoveryCapabilities, setRecoveryCapabilities] =
    React.useState<RecoveryCapabilities | null>(
      () => cachedEngineStatus?.recoveryCapabilities ?? null
    )
  const [recoverySettingsBusy, setRecoverySettingsBusy] = React.useState(false)
  const [recoverySettingsMessage, setRecoverySettingsMessage] = React.useState<
    string | null
  >(null)
  const [recoverySettingsError, setRecoverySettingsError] =
    React.useState(false)
  const [toolsDirInput, setToolsDirInput] = React.useState(
    () => cachedEngineStatus?.hashcat.configuredToolsDirectory ?? ""
  )
  const [johnDirInput, setJohnDirInput] = React.useState(
    () => cachedEngineStatus?.johnPerl.johnToolsDirectory ?? ""
  )
  const [perlPathInput, setPerlPathInput] = React.useState(
    () => cachedEngineStatus?.johnPerl.perlPath ?? ""
  )
  const [engineBusy, setEngineBusy] = React.useState(false)
  const [engineMessage, setEngineMessage] = React.useState<string | null>(null)
  const [engineError, setEngineError] = React.useState(false)
  const [logSettingsBusy, setLogSettingsBusy] = React.useState(false)
  const [logSettingsMessage, setLogSettingsMessage] = React.useState<
    string | null
  >(null)
  const [logSettingsError, setLogSettingsError] = React.useState(false)
  const [logMaxDiskInput, setLogMaxDiskInput] = React.useState(
    String(DEFAULT_LOG_MAX_DISK_MIB)
  )
  const [initialLoadBusy, setInitialLoadBusy] = React.useState(false)
  const [initialLoadError, setInitialLoadError] = React.useState<string | null>(
    null
  )
  const initialLoadRequest = React.useRef(0)
  const initialLoadStarted = React.useRef(false)

  if (handledCategoryRequestId !== categoryRequestId) {
    setHandledCategoryRequestId(categoryRequestId)
    setCategory(initialCategory)
  }

  const applyEngineStatus = React.useCallback(
    (snapshot: EngineStatusSnapshot) => {
      cachedEngineStatus = snapshot
      setFullBundle(snapshot.fullBundle)
      setHashcat(snapshot.hashcat)
      setJohnPerl(snapshot.johnPerl)
      setRecoveryCapabilities(snapshot.recoveryCapabilities)
      setToolsDirInput(snapshot.hashcat.configuredToolsDirectory || "")
      setJohnDirInput(snapshot.johnPerl.johnToolsDirectory || "")
      setPerlPathInput(snapshot.johnPerl.perlPath || "")
    },
    []
  )

  const applyJohnPerlStatus = React.useCallback((status: JohnPerlStatus) => {
    if (cachedEngineStatus) {
      cachedEngineStatus = { ...cachedEngineStatus, johnPerl: status }
    }
    setJohnPerl(status)
    setJohnDirInput(status.johnToolsDirectory || "")
    setPerlPathInput(status.perlPath || "")
  }, [])

  const refreshEngine = React.useCallback(async () => {
    try {
      const [bundle, status, john, recovery] = await Promise.all([
        getFullEngineBundleStatus(),
        getHashcatStatus(),
        getJohnPerlStatus(),
        refreshRecoveryCapabilities(),
      ])
      applyEngineStatus({
        fullBundle: bundle,
        hashcat: status,
        johnPerl: john,
        recoveryCapabilities: recovery,
      })
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error ?? "未知错误")
      setEngineMessage(`读取引擎状态失败：${message}`)
      setEngineError(true)
    }
  }, [applyEngineStatus])

  const loadInitialData = React.useCallback(async () => {
    const requestId = ++initialLoadRequest.current
    setInitialLoadBusy(true)
    setInitialLoadError(null)

    const results = await Promise.allSettled([
      getDatabaseInfo(),
      getFullEngineBundleStatus(),
      getHashcatStatus(),
      getJohnPerlStatus(),
      getSettings(),
      getRecoveryCapabilities(),
    ] as const)
    if (requestId !== initialLoadRequest.current) {
      return
    }

    const [info, bundle, status, john, settings, recovery] = results
    if (info.status === "fulfilled") {
      setDbInfo(info.value)
    }
    if (bundle.status === "fulfilled") {
      setFullBundle(bundle.value)
    }
    if (status.status === "fulfilled") {
      setHashcat(status.value)
      setToolsDirInput(status.value.configuredToolsDirectory || "")
    }
    if (john.status === "fulfilled") {
      applyJohnPerlStatus(john.value)
    }
    if (settings.status === "fulfilled") {
      setAppSettings(settings.value)
      setLogMaxDiskInput(
        String(settings.value.logging?.maxDiskMib ?? DEFAULT_LOG_MAX_DISK_MIB)
      )
    }
    if (recovery.status === "fulfilled") {
      setRecoveryCapabilities(recovery.value)
    }
    if (
      bundle.status === "fulfilled" &&
      status.status === "fulfilled" &&
      john.status === "fulfilled" &&
      recovery.status === "fulfilled"
    ) {
      applyEngineStatus({
        fullBundle: bundle.value,
        hashcat: status.value,
        johnPerl: john.value,
        recoveryCapabilities: recovery.value,
      })
    }

    const labels = [
      "数据库信息",
      "完整引擎包",
      "Hashcat",
      "John / Perl",
      "应用设置",
      "恢复能力",
    ]
    const failedLabels = results.flatMap((result, index) =>
      result.status === "rejected" ? [labels[index]] : []
    )
    if (failedLabels.length > 0) {
      setInitialLoadError(`读取失败：${failedLabels.join("、")}。`)
    }
    setInitialLoadBusy(false)
  }, [applyEngineStatus, applyJohnPerlStatus])

  React.useEffect(() => {
    if (initialLoadStarted.current) {
      return
    }
    const timeout = setTimeout(() => {
      initialLoadStarted.current = true
      void loadInitialData()
    }, 0)
    return () => {
      clearTimeout(timeout)
    }
  }, [loadInitialData])

  const handleSaveToolsDir = () => {
    if (engineBusy) {
      return
    }
    setEngineBusy(true)
    setEngineError(false)
    setEngineMessage("正在保存公共工具目录…")
    void (async () => {
      try {
        await setToolsDirectory(toolsDirInput.trim())
        await refreshEngine()
        setEngineMessage(
          toolsDirInput.trim()
            ? "已保存公共工具目录；下载的引擎将安装到此目录。"
            : "已恢复默认工具目录（应用数据下的 tools）。"
        )
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error ?? "未知错误")
        setEngineError(true)
        setEngineMessage(`保存失败：${message}`)
      } finally {
        setEngineBusy(false)
      }
    })()
  }

  const handleResetToolsDir = () => {
    setToolsDirInput("")
    if (engineBusy) {
      return
    }
    setEngineBusy(true)
    setEngineError(false)
    void (async () => {
      try {
        await setToolsDirectory("")
        await refreshEngine()
        setEngineMessage("已恢复默认工具目录。")
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error ?? "未知错误")
        setEngineError(true)
        setEngineMessage(`恢复默认失败：${message}`)
      } finally {
        setEngineBusy(false)
      }
    })()
  }

  const handleDownloadHashcat = () => {
    if (engineBusy) {
      return
    }
    setEngineBusy(true)
    setEngineError(false)
    setEngineMessage("正在从 GitHub 下载 hashcat 固定版本（校验 SHA-256）…")
    void (async () => {
      try {
        const result = await downloadHashcat()
        setEngineError(!result.success)
        setEngineMessage(result.message)
        await refreshEngine()
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error ?? "未知错误")
        setEngineError(true)
        setEngineMessage(`下载失败：${message}`)
      } finally {
        setEngineBusy(false)
      }
    })()
  }

  const handleInstallFullBundle = () => {
    if (engineBusy) {
      return
    }
    setEngineBusy(true)
    setEngineError(false)
    setEngineMessage(
      "正在校验并离线展开完整引擎包；便携 Perl 体积较大，请稍候…"
    )
    void (async () => {
      try {
        const result = await installFullEngineBundle()
        setEngineError(!result.success)
        setEngineMessage(result.message)
        await refreshEngine()
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error ?? "未知错误")
        setEngineError(true)
        setEngineMessage(`完整引擎部署失败：${message}`)
      } finally {
        setEngineBusy(false)
      }
    })()
  }

  const handleSaveJohnPerl = () => {
    if (engineBusy) {
      return
    }
    setEngineBusy(true)
    setEngineError(false)
    setEngineMessage("正在保存 John / Perl 路径…")
    void (async () => {
      try {
        const status = await saveJohnPerlPaths(
          johnDirInput.trim(),
          perlPathInput.trim()
        )
        applyJohnPerlStatus(status)
        setEngineError(!status.ready)
        setEngineMessage(status.message)
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error ?? "未知错误")
        setEngineError(true)
        setEngineMessage(`保存失败：${message}`)
      } finally {
        setEngineBusy(false)
      }
    })()
  }

  const handleProbeJohnPerl = () => {
    if (engineBusy) {
      return
    }
    setEngineBusy(true)
    setEngineError(false)
    void (async () => {
      try {
        const status = await getJohnPerlStatus()
        applyJohnPerlStatus(status)
        setEngineError(!status.ready && Boolean(status.johnToolsDirectory))
        setEngineMessage(status.message)
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error ?? "未知错误")
        setEngineError(true)
        setEngineMessage(`检测失败：${message}`)
      } finally {
        setEngineBusy(false)
      }
    })()
  }

  const handleOpenPath = (path: string) => {
    if (engineBusy || !path.trim()) {
      return
    }
    setEngineError(false)
    setEngineMessage(null)
    void openPath(path.trim()).catch((error) => {
      setEngineError(true)
      setEngineMessage(`无法跳转到该路径：${errorMessage(error)}`)
    })
  }

  const handleLogLevelChange = (level: AppLogLevel) => {
    if (
      logSettingsBusy ||
      appSettings === null ||
      appSettings.logging?.level === level
    ) {
      return
    }
    const previous = appSettings
    const next: AppSettings = {
      ...appSettings,
      logging: {
        level,
        maxDiskMib: appSettings.logging?.maxDiskMib ?? DEFAULT_LOG_MAX_DISK_MIB,
      },
    }
    setAppSettings(next)
    setLogSettingsBusy(true)
    setLogSettingsError(false)
    setLogSettingsMessage("正在保存日志级别…")
    void (async () => {
      try {
        const saved = await setSettings(next)
        setAppSettings(saved)
        setLogSettingsError(false)
        setLogSettingsMessage(`日志级别已切换为“${logLevelLabel(level)}”。`)
      } catch (error) {
        setAppSettings(previous)
        setLogSettingsError(true)
        setLogSettingsMessage(`保存失败：${errorMessage(error)}`)
      } finally {
        setLogSettingsBusy(false)
      }
    })()
  }

  const handleSaveLogCapacity = () => {
    if (logSettingsBusy || appSettings === null) {
      return
    }
    const maxDiskMib = Number(logMaxDiskInput)
    if (
      !Number.isInteger(maxDiskMib) ||
      maxDiskMib < MIN_LOG_MAX_DISK_MIB ||
      maxDiskMib > MAX_LOG_MAX_DISK_MIB
    ) {
      setLogSettingsError(true)
      setLogSettingsMessage(
        `请输入 ${MIN_LOG_MAX_DISK_MIB}–${MAX_LOG_MAX_DISK_MIB} 之间的整数。`
      )
      return
    }
    if (
      (appSettings.logging?.maxDiskMib ?? DEFAULT_LOG_MAX_DISK_MIB) ===
      maxDiskMib
    ) {
      setLogSettingsError(false)
      setLogSettingsMessage(`日志最大占用已是 ${maxDiskMib} MiB。`)
      return
    }

    const next: AppSettings = {
      ...appSettings,
      logging: {
        level: appSettings.logging?.level ?? "info",
        maxDiskMib,
      },
    }
    setLogSettingsBusy(true)
    setLogSettingsError(false)
    setLogSettingsMessage("正在保存日志容量…")
    void (async () => {
      try {
        const saved = await setSettings(next)
        const savedMaxDiskMib =
          saved.logging?.maxDiskMib ?? DEFAULT_LOG_MAX_DISK_MIB
        setAppSettings(saved)
        setLogMaxDiskInput(String(savedMaxDiskMib))
        setLogSettingsError(false)
        setLogSettingsMessage(`日志最大占用已调整为 ${savedMaxDiskMib} MiB。`)
      } catch (error) {
        setLogSettingsError(true)
        setLogSettingsMessage(`保存失败：${errorMessage(error)}`)
      } finally {
        setLogSettingsBusy(false)
      }
    })()
  }

  const handleRecoveryComputeModeChange = (mode: RecoveryComputeMode) => {
    if (
      recoverySettingsBusy ||
      appSettings === null ||
      (appSettings.recovery?.computeMode ?? "gpuPreferred") === mode
    ) {
      return
    }
    const previous = appSettings
    const next: AppSettings = {
      ...appSettings,
      recovery: { computeMode: mode },
    }
    setAppSettings(next)
    setRecoverySettingsBusy(true)
    setRecoverySettingsError(false)
    setRecoverySettingsMessage("正在保存默认解密方式…")
    void (async () => {
      try {
        const saved = await setSettings(next)
        setAppSettings(saved)
        setRecoverySettingsError(false)
        setRecoverySettingsMessage(
          mode === "gpuPreferred"
            ? "默认使用 GPU 优先；GPU 不可用或执行失败时自动回退 CPU。"
            : "默认仅使用 CPU，恢复任务不会调用 GPU。"
        )
      } catch (error) {
        setAppSettings(previous)
        setRecoverySettingsError(true)
        setRecoverySettingsMessage(`保存失败：${errorMessage(error)}`)
      } finally {
        setRecoverySettingsBusy(false)
      }
    })()
  }

  const activeMeta =
    CATEGORIES.find((item) => item.id === category) ?? CATEGORIES[0]!

  const hashcatReady =
    Boolean(hashcat?.installed) || Boolean(hashcat?.configuredExists)
  const hashcatCpuAvailable = Boolean(
    recoveryCapabilities?.methods.find((method) => method.id === "hashcatCpu")
      ?.available
  )
  const cpuRecoveryChain =
    recoveryCapabilities === null
      ? "正在探测 CPU 引擎…"
      : hashcatCpuAvailable
        ? "Hashcat CPU → John CPU → 7-Zip CPU"
        : "John CPU → 7-Zip CPU（Hashcat CPU 可选）"
  const parsedLogMaxDisk = Number(logMaxDiskInput)
  const logCapacityInvalid =
    appSettings !== null &&
    (!Number.isInteger(parsedLogMaxDisk) ||
      parsedLogMaxDisk < MIN_LOG_MAX_DISK_MIB ||
      parsedLogMaxDisk > MAX_LOG_MAX_DISK_MIB)
  const logCapacityDirty =
    appSettings !== null &&
    String(appSettings.logging?.maxDiskMib ?? DEFAULT_LOG_MAX_DISK_MIB) !==
      logMaxDiskInput

  const handleAiDirtyChange = React.useCallback(
    (dirty: boolean) => {
      setAiDirty(dirty)
      onAiDirtyChange?.(dirty)
    },
    [onAiDirtyChange]
  )

  const completeSettingsLeave = (pending: PendingSettingsLeave) => {
    setPendingSettingsLeave(null)
    handleAiDirtyChange(false)
    if (pending.type === "category") {
      setCategory(pending.category)
    } else {
      returnAction?.onClick()
    }
  }

  const requestCategoryChange = (next: SettingsCategory) => {
    if (next === category) {
      return
    }
    if (category === "ai" && aiDirty) {
      setPendingSettingsLeave({ type: "category", category: next })
      return
    }
    setCategory(next)
  }

  const requestReturn = () => {
    if (category === "ai" && aiDirty) {
      setPendingSettingsLeave({ type: "return" })
      return
    }
    returnAction?.onClick()
  }

  const handleSaveAndLeaveSettings = async () => {
    if (!pendingSettingsLeave || leaveSaveBusy) {
      return
    }
    const pending = pendingSettingsLeave
    setLeaveSaveBusy(true)
    const saved = await aiSettingsPanelRef.current?.saveUnsavedChanges()
    setLeaveSaveBusy(false)
    if (saved !== false) {
      completeSettingsLeave(pending)
    }
  }

  React.useImperativeHandle(ref, () => ({
    saveAiChanges: async () =>
      (await aiSettingsPanelRef.current?.saveUnsavedChanges()) ?? true,
  }))

  return (
    <WorkbenchPage>
      <WorkbenchPageContent className="gap-2">
        <WorkbenchPageHeader
          title="设置"
          description={activeMeta.description}
          actions={
            returnAction ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={requestReturn}
              >
                <ArrowLeft data-icon="inline-start" />
                {returnAction.label}
              </Button>
            ) : null
          }
        />

        {initialLoadError ? (
          <Alert variant="warning" className="shrink-0">
            <CircleAlert />
            <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
              <span>{initialLoadError} 已成功读取的区域仍可使用。</span>
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={initialLoadBusy}
                onClick={() => void loadInitialData()}
              >
                <RefreshCw data-icon="inline-start" />
                {initialLoadBusy ? "正在重试" : "重试读取"}
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        <Tabs
          value={category}
          onValueChange={(value) => {
            if (value == null) {
              return
            }
            requestCategoryChange(value as SettingsCategory)
          }}
          className="flex min-h-0 flex-1 flex-col gap-2"
        >
          <TabsList className="h-auto min-h-9 w-full shrink-0 flex-wrap justify-start gap-0.5">
            {CATEGORIES.map((item) => {
              const Icon = item.icon
              return (
                <TabsTrigger
                  key={item.id}
                  value={item.id}
                  className="flex-none"
                >
                  <Icon data-icon="inline-start" />
                  {item.label}
                </TabsTrigger>
              )
            })}
          </TabsList>

          <div className="min-h-0 flex-1 scroll-fade overflow-y-auto pb-1">
            <TabsContent value="ai" className="mt-0 outline-none">
              <AiSettingsPanel
                ref={aiSettingsPanelRef}
                onDirtyChange={handleAiDirtyChange}
              />
            </TabsContent>

            <TabsContent
              value="engine"
              className="mt-0 flex flex-col gap-2 outline-none"
            >
              <Card size="sm">
                <CardHeader className="border-b border-border/80">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <CardTitle>默认解密方式</CardTitle>
                        <Badge variant="secondary">可在解压页快速切换</Badge>
                      </div>
                      <CardDescription>
                        GPU 优先会自动回退 CPU；仅 CPU 模式不会启动 GPU
                        恢复进程。
                      </CardDescription>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={engineBusy || recoverySettingsBusy}
                      onClick={() => void refreshEngine()}
                    >
                      重新探测
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <FieldSet disabled={recoverySettingsBusy}>
                    <FieldLegend className="sr-only">默认解密方式</FieldLegend>
                    <RadioGroup
                      value={
                        appSettings?.recovery?.computeMode ?? "gpuPreferred"
                      }
                      onValueChange={(value) =>
                        handleRecoveryComputeModeChange(
                          value as RecoveryComputeMode
                        )
                      }
                      className="grid gap-2 sm:grid-cols-2"
                    >
                      <FieldLabel htmlFor="compute-gpu">
                        <Field orientation="horizontal">
                          <Zap className="mt-0.5 size-4 shrink-0" />
                          <FieldContent>
                            <FieldTitle>GPU 优先</FieldTitle>
                            <FieldDescription>
                              Hashcat GPU → {cpuRecoveryChain}
                            </FieldDescription>
                          </FieldContent>
                          <RadioGroupItem
                            id="compute-gpu"
                            value="gpuPreferred"
                          />
                        </Field>
                      </FieldLabel>
                      <FieldLabel htmlFor="compute-cpu">
                        <Field orientation="horizontal">
                          <Cpu className="mt-0.5 size-4 shrink-0" />
                          <FieldContent>
                            <FieldTitle>仅 CPU</FieldTitle>
                            <FieldDescription>
                              {cpuRecoveryChain}
                            </FieldDescription>
                          </FieldContent>
                          <RadioGroupItem id="compute-cpu" value="cpuOnly" />
                        </Field>
                      </FieldLabel>
                    </RadioGroup>
                  </FieldSet>
                  <div>
                    <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                      恢复方式与可选能力
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {recoveryCapabilities?.methods.map((method, index) => (
                        <Badge
                          key={method.id}
                          title={method.message}
                          style={{
                            animationDelay: `${Math.min(index, 4) * 45}ms`,
                          }}
                          variant={
                            method.available
                              ? "outline"
                              : method.optional
                                ? "secondary"
                                : "warning"
                          }
                          className="animate-status-chip-enter motion-safe-only"
                        >
                          {method.label} ·{" "}
                          {method.available
                            ? "可用"
                            : method.optional
                              ? "可选未启用"
                              : "未就绪"}
                        </Badge>
                      )) ?? <Badge variant="outline">正在探测…</Badge>}
                    </div>
                  </div>
                  {recoverySettingsMessage ? (
                    <Alert
                      variant={
                        recoverySettingsError
                          ? "destructive"
                          : recoverySettingsBusy
                            ? "default"
                            : "success"
                      }
                    >
                      <AlertDescription>
                        {recoverySettingsMessage}
                      </AlertDescription>
                    </Alert>
                  ) : null}
                </CardContent>
              </Card>

              <Card size="sm">
                <CardHeader className="border-b border-border/80">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="flex min-w-0 flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <CardTitle>Windows x64 完整离线包</CardTitle>
                        {fullBundle === null ? (
                          <Badge variant="secondary">正在检测</Badge>
                        ) : (
                          <>
                            <Badge variant="secondary">
                              {fullBundle.bundled ? "资源已内置" : "精简构建"}
                            </Badge>
                            <Badge
                              variant={
                                fullBundle.installed ? "success" : "warning"
                              }
                            >
                              {fullBundle.installed ? "全部就绪" : "待部署"}
                            </Badge>
                          </>
                        )}
                      </div>
                      <CardDescription>
                        安装器内包含 7-Zip、Hashcat、John CPU 引擎、Strawberry
                        Perl，以及 7z2john / rar2john / zip2john。部署时逐包校验
                        SHA-256，再展开到可写工具目录。
                      </CardDescription>
                    </div>
                    <Button
                      size="sm"
                      disabled={
                        engineBusy ||
                        !fullBundle?.bundled ||
                        !fullBundle?.platformSupported
                      }
                      onClick={handleInstallFullBundle}
                    >
                      <Package data-icon="inline-start" />
                      {fullBundle === null
                        ? "正在检测…"
                        : fullBundle.installed
                          ? "重新检测 / 补全"
                          : "离线部署"}
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  {fullBundle === null ? (
                    <div
                      className="flex min-h-24 items-center justify-center text-xs text-muted-foreground"
                      aria-live="polite"
                      aria-busy="true"
                    >
                      <span className="motion-safe:animate-pulse">
                        正在检测完整包状态…
                      </span>
                    </div>
                  ) : (
                    <>
                      <div className="flex flex-wrap gap-1.5">
                        {[
                          { id: "7zip", component: fullBundle.sevenZip },
                          { id: "hashcat", component: fullBundle.hashcat },
                          { id: "john", component: fullBundle.john },
                          { id: "perl", component: fullBundle.perl },
                        ].map(({ id, component }) => (
                          <Badge
                            key={id}
                            variant={component.runnable ? "outline" : "warning"}
                          >
                            {component.name} {component.version} ·{" "}
                            {component.runnable ? "可运行" : "未就绪"}
                          </Badge>
                        ))}
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        <Badge
                          variant={
                            fullBundle.has7z2john ? "outline" : "warning"
                          }
                        >
                          7z2john {fullBundle.has7z2john ? "可用" : "缺失"}
                        </Badge>
                        <Badge
                          variant={
                            fullBundle.hasRar2john ? "outline" : "warning"
                          }
                        >
                          rar2john {fullBundle.hasRar2john ? "可用" : "缺失"}
                        </Badge>
                        <Badge
                          variant={
                            fullBundle.hasZip2john ? "outline" : "warning"
                          }
                        >
                          zip2john {fullBundle.hasZip2john ? "可用" : "缺失"}
                        </Badge>
                        <Badge
                          variant={
                            fullBundle.johnCpuReady ? "outline" : "warning"
                          }
                        >
                          CPU 回退 {fullBundle.johnCpuReady ? "可用" : "缺失"}
                        </Badge>
                      </div>
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        {fullBundle.message} GPU 驱动、CUDA、HIP 与 OpenCL
                        由系统提供，不进入发行包；无可用加速后端时使用 John CPU
                        回退。
                      </p>
                    </>
                  )}
                  {engineMessage ? (
                    <Alert
                      variant={
                        engineError
                          ? "destructive"
                          : engineBusy
                            ? "default"
                            : "success"
                      }
                    >
                      <AlertDescription>{engineMessage}</AlertDescription>
                    </Alert>
                  ) : null}
                </CardContent>
              </Card>

              <Card size="sm">
                <CardHeader className="border-b border-border/80">
                  <CardTitle>工具公共目录</CardTitle>
                  <CardDescription>
                    引擎下载安装的根目录。可设为公共/共享路径，供本机多处复用；留空则使用应用默认
                    tools 目录。
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <Field>
                    <FieldLabel htmlFor="tools-dir">
                      公共目录（绝对路径）
                    </FieldLabel>
                    <InputGroup>
                      <InputGroupInput
                        id="tools-dir"
                        value={toolsDirInput}
                        onChange={(event) =>
                          setToolsDirInput(event.target.value)
                        }
                        disabled={engineBusy}
                        placeholder={
                          hashcat?.defaultToolsDirectory ||
                          "留空 = 使用默认 tools 目录"
                        }
                        className="font-mono text-xs"
                      />
                      <InputGroupAddon align="inline-end">
                        <InputGroupButton
                          variant="outline"
                          disabled={
                            engineBusy ||
                            !(
                              toolsDirInput.trim() ||
                              hashcat?.defaultToolsDirectory
                            )
                          }
                          onClick={() =>
                            handleOpenPath(
                              toolsDirInput.trim() ||
                                hashcat?.defaultToolsDirectory ||
                                ""
                            )
                          }
                        >
                          <ExternalLink data-icon="inline-start" />
                          跳转
                        </InputGroupButton>
                      </InputGroupAddon>
                    </InputGroup>
                    <FieldDescription>
                      默认：{hashcat?.defaultToolsDirectory || "—"}
                    </FieldDescription>
                    <FieldDescription>
                      当前生效：{hashcat?.toolsDirectory || "—"}
                    </FieldDescription>
                  </Field>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      disabled={engineBusy}
                      onClick={handleSaveToolsDir}
                    >
                      保存目录
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={engineBusy}
                      onClick={handleResetToolsDir}
                    >
                      恢复默认
                    </Button>
                  </div>
                </CardContent>
              </Card>

              <Card size="sm">
                <CardHeader className="border-b border-border/80">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="flex min-w-0 flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <CardTitle>hashcat</CardTitle>
                        {hashcat === null ? (
                          <Badge variant="secondary">正在检测</Badge>
                        ) : (
                          <>
                            <Badge variant="secondary">
                              v{hashcat.version}
                            </Badge>
                            <Badge
                              variant={hashcatReady ? "success" : "warning"}
                            >
                              {hashcatReady ? "已就绪" : "未安装"}
                            </Badge>
                          </>
                        )}
                      </div>
                      <CardDescription>
                        完整发行包已内置固定版本；这里保留 GitHub
                        下载作为精简构建或修复安装的后备路径。下载同样执行
                        SHA-256 校验，不静默更新、不提权。
                      </CardDescription>
                    </div>
                    <Button
                      size="sm"
                      disabled={engineBusy || hashcat === null}
                      onClick={handleDownloadHashcat}
                    >
                      <Download data-icon="inline-start" />
                      {hashcat === null
                        ? "正在检测…"
                        : hashcat.installed
                          ? "重新检测 / 补全"
                          : "下载并安装"}
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <InfoRow
                    icon={<HardDrive className="size-3.5" />}
                    label="可执行文件"
                    value={
                      hashcat?.configuredPath || hashcat?.executablePath || "—"
                    }
                  />
                  <InfoRow
                    icon={<HardDrive className="size-3.5" />}
                    label="安装目录"
                    value={hashcat?.installDirectory || "—"}
                  />
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <a
                      href={
                        hashcat?.githubRepo ??
                        "https://github.com/hashcat/hashcat"
                      }
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-foreground underline-offset-4 hover:underline"
                    >
                      GitHub 仓库
                      <ExternalLink className="size-3" />
                    </a>
                    <span aria-hidden>·</span>
                    <a
                      href={hashcat?.downloadUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-foreground underline-offset-4 hover:underline"
                    >
                      固定 release 包
                      <ExternalLink className="size-3" />
                    </a>
                  </div>
                </CardContent>
              </Card>

              <Card size="sm">
                <CardHeader className="border-b border-border/80">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="flex min-w-0 flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <CardTitle>John / Perl</CardTitle>
                        {johnPerl === null ? (
                          <Badge variant="secondary">正在检测</Badge>
                        ) : (
                          <Badge
                            variant={johnPerl.ready ? "success" : "warning"}
                          >
                            {johnPerl.ready ? "已就绪" : "未就绪"}
                          </Badge>
                        )}
                      </div>
                      <CardDescription>
                        完整包会自动写入 John 工具目录与
                        perl.exe；也可在此覆盖为 自备版本。提供
                        7z2john、rar2john、zip2john 哈希转换及 John CPU 回退。
                      </CardDescription>
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={engineBusy || johnPerl === null}
                        onClick={handleProbeJohnPerl}
                      >
                        重新检测
                      </Button>
                      <Button
                        size="sm"
                        disabled={engineBusy || johnPerl === null}
                        onClick={handleSaveJohnPerl}
                      >
                        保存
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <Field>
                    <FieldLabel htmlFor="john-dir">John 工具目录</FieldLabel>
                    <InputGroup>
                      <InputGroupInput
                        id="john-dir"
                        value={johnDirInput}
                        onChange={(event) =>
                          setJohnDirInput(event.target.value)
                        }
                        disabled={engineBusy}
                        placeholder="含 john / 7z2john / rar2john / zip2john 的目录"
                        className="font-mono text-xs"
                      />
                      <InputGroupAddon align="inline-end">
                        <InputGroupButton
                          variant="outline"
                          disabled={engineBusy || !johnDirInput.trim()}
                          onClick={() => handleOpenPath(johnDirInput)}
                        >
                          <ExternalLink data-icon="inline-start" />
                          跳转
                        </InputGroupButton>
                      </InputGroupAddon>
                    </InputGroup>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="perl-path">perl.exe 路径</FieldLabel>
                    <InputGroup>
                      <InputGroupInput
                        id="perl-path"
                        value={perlPathInput}
                        onChange={(event) =>
                          setPerlPathInput(event.target.value)
                        }
                        disabled={engineBusy}
                        placeholder="可选；使用 7z2john.pl 时需要"
                        className="font-mono text-xs"
                      />
                      <InputGroupAddon align="inline-end">
                        <InputGroupButton
                          variant="outline"
                          disabled={engineBusy || !perlPathInput.trim()}
                          onClick={() => handleOpenPath(perlPathInput)}
                        >
                          <ExternalLink data-icon="inline-start" />
                          跳转
                        </InputGroupButton>
                      </InputGroupAddon>
                    </InputGroup>
                  </Field>
                  {johnPerl === null ? (
                    <div className="flex flex-wrap gap-1.5">
                      <Badge variant="secondary">正在检测组件…</Badge>
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      <Badge
                        variant={
                          johnPerl.sevenZipConverterReady
                            ? "outline"
                            : "warning"
                        }
                      >
                        7z2john{" "}
                        {johnPerl.sevenZipConverterReady ? "可用" : "缺失"}
                      </Badge>
                      <Badge
                        variant={
                          johnPerl.rarConverterReady ? "outline" : "warning"
                        }
                      >
                        rar2john {johnPerl.rarConverterReady ? "可用" : "缺失"}
                      </Badge>
                      <Badge
                        variant={
                          johnPerl.zipConverterReady ? "outline" : "warning"
                        }
                      >
                        zip2john {johnPerl.zipConverterReady ? "可用" : "缺失"}
                      </Badge>
                      <Badge
                        variant={johnPerl.johnCpuReady ? "outline" : "warning"}
                      >
                        John CPU {johnPerl.johnCpuReady ? "可用" : "缺失"}
                      </Badge>
                      <Badge
                        variant={johnPerl.perlExists ? "outline" : "warning"}
                      >
                        perl {johnPerl.perlExists ? "可用" : "未配置"}
                      </Badge>
                    </div>
                  )}
                  {johnPerl?.message ? (
                    <p className="text-xs text-muted-foreground">
                      {johnPerl.message}
                    </p>
                  ) : null}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="app" className="mt-0 outline-none">
              <div className="flex flex-col gap-2">
                <Card size="sm">
                  <CardHeader className="border-b border-border/80">
                    <div className="flex items-center gap-2">
                      <CardTitle>应用日志</CardTitle>
                      <Badge variant="outline">
                        {appSettings?.logging?.maxDiskMib ??
                          DEFAULT_LOG_MAX_DISK_MIB}{" "}
                        MiB 上限
                      </Badge>
                    </div>
                    <CardDescription>
                      控制本机日志的详细程度和最大磁盘占用。密码、候选内容和用户路径会在写入前隐藏。
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3">
                    <FieldSet
                      disabled={logSettingsBusy || appSettings === null}
                    >
                      <FieldLegend className="sr-only">日志级别</FieldLegend>
                      <ToggleGroup
                        value={[appSettings?.logging?.level ?? "info"]}
                        onValueChange={(value) => {
                          const level = value[0] as AppLogLevel | undefined
                          if (level) {
                            void handleLogLevelChange(level)
                          }
                        }}
                        variant="outline"
                        className="grid w-full grid-cols-2 gap-2 sm:grid-cols-4"
                      >
                        {LOG_LEVELS.map((item) => (
                          <ToggleGroupItem
                            key={item.value}
                            value={item.value}
                            className="h-auto min-h-14 flex-col items-start gap-0.5 text-left"
                          >
                            <span className="block text-xs font-medium">
                              {item.label}
                            </span>
                            <span className="block text-xs leading-tight text-muted-foreground">
                              {item.description}
                            </span>
                          </ToggleGroupItem>
                        ))}
                      </ToggleGroup>
                    </FieldSet>
                    <FieldSeparator />
                    <FieldSet
                      className="gap-3"
                      disabled={logSettingsBusy || appSettings === null}
                    >
                      <FieldLegend className="sr-only">日志容量</FieldLegend>
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                        <FieldContent className="w-full sm:max-w-64">
                          <div className="flex items-center gap-2">
                            <FieldLabel htmlFor="log-max-disk-mib">
                              最大磁盘占用
                            </FieldLabel>
                            {logCapacityDirty ? (
                              <Badge variant="warning">未保存</Badge>
                            ) : null}
                          </div>
                          <InputGroup>
                            <InputGroupInput
                              id="log-max-disk-mib"
                              type="number"
                              inputMode="numeric"
                              min={MIN_LOG_MAX_DISK_MIB}
                              max={MAX_LOG_MAX_DISK_MIB}
                              step={5}
                              value={logMaxDiskInput}
                              onChange={(event) => {
                                setLogMaxDiskInput(event.target.value)
                                setLogSettingsMessage(null)
                              }}
                              aria-describedby="log-max-disk-hint"
                              aria-invalid={logCapacityInvalid}
                            />
                            <InputGroupAddon align="inline-end">
                              <InputGroupText>MiB</InputGroupText>
                            </InputGroupAddon>
                          </InputGroup>
                          {logCapacityInvalid ? (
                            <FieldError>
                              请输入 {MIN_LOG_MAX_DISK_MIB}–
                              {MAX_LOG_MAX_DISK_MIB} 之间的整数。
                            </FieldError>
                          ) : null}
                        </FieldContent>
                        <Button
                          type="button"
                          variant="outline"
                          disabled={
                            logSettingsBusy ||
                            appSettings === null ||
                            logCapacityInvalid ||
                            !logCapacityDirty
                          }
                          onClick={handleSaveLogCapacity}
                        >
                          保存
                        </Button>
                      </div>
                      <ToggleGroup
                        value={
                          LOG_CAPACITY_PRESETS.some(
                            (capacity) => String(capacity) === logMaxDiskInput
                          )
                            ? [logMaxDiskInput]
                            : []
                        }
                        onValueChange={(value) => {
                          if (value[0]) {
                            setLogMaxDiskInput(value[0])
                            setLogSettingsMessage(null)
                          }
                        }}
                        variant="outline"
                        size="sm"
                        className="flex-wrap"
                      >
                        {LOG_CAPACITY_PRESETS.map((capacity) => (
                          <ToggleGroupItem
                            key={capacity}
                            value={String(capacity)}
                          >
                            {capacity} MiB
                          </ToggleGroupItem>
                        ))}
                      </ToggleGroup>
                      <FieldDescription id="log-max-disk-hint">
                        可设置 {MIN_LOG_MAX_DISK_MIB}–{MAX_LOG_MAX_DISK_MIB}{" "}
                        MiB；日志按 5 MiB 分片，到达总上限后自动删除最旧文件。
                      </FieldDescription>
                    </FieldSet>
                    {logSettingsMessage ? (
                      <Alert
                        variant={
                          logSettingsError
                            ? "destructive"
                            : logSettingsBusy
                              ? "default"
                              : "success"
                        }
                      >
                        <AlertDescription aria-live="polite">
                          {logSettingsMessage}
                        </AlertDescription>
                      </Alert>
                    ) : null}
                  </CardContent>
                </Card>
                <Card size="sm">
                  <CardHeader>
                    <div className="flex items-center gap-2">
                      <CardTitle>内置 7-Zip</CardTitle>
                      {fullBundle === null ? (
                        <Badge variant="secondary">正在检测</Badge>
                      ) : (
                        <Badge
                          variant={
                            fullBundle.sevenZip.runnable ? "success" : "warning"
                          }
                        >
                          {fullBundle.sevenZip.runnable ? "可运行" : "未就绪"}
                        </Badge>
                      )}
                    </div>
                    <CardDescription>
                      {fullBundle?.sevenZip.message ??
                        "正在读取 7-Zip 进程探测状态…"}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <InfoRow
                      icon={<HardDrive className="size-3.5" />}
                      label="7z.exe"
                      value={fullBundle?.sevenZip.executablePath ?? "—"}
                      action={
                        fullBundle?.sevenZip.executablePath ? (
                          <Button
                            type="button"
                            size="xs"
                            variant="ghost"
                            disabled={engineBusy}
                            onClick={() =>
                              handleOpenPath(fullBundle.sevenZip.executablePath)
                            }
                          >
                            <ExternalLink data-icon="inline-start" />
                            打开位置
                          </Button>
                        ) : undefined
                      }
                    />
                  </CardContent>
                </Card>
              </div>
            </TabsContent>

            <TabsContent value="data" className="mt-0 outline-none">
              <Card size="sm">
                <CardHeader className="border-b border-border/80">
                  <div className="flex items-center gap-2">
                    <Database className="size-4 text-muted-foreground" />
                    <CardTitle>本地数据</CardTitle>
                  </div>
                  <CardDescription>
                    本机
                    SQLite，不在项目仓库内；缺失时自动创建。字典导入编码自动识别。
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <InfoRow
                    icon={<HardDrive className="size-3.5" />}
                    label="数据根目录"
                    value={dbInfo?.rootPath ?? "—"}
                  />
                  <InfoRow
                    icon={<HardDrive className="size-3.5" />}
                    label="数据库"
                    value={dbInfo?.path ?? "—"}
                    badge={
                      dbInfo
                        ? dbInfo.exists
                          ? `已存在 · ${dbInfo.candidateCount} 条候选`
                          : "将在首次写入时创建"
                        : undefined
                    }
                  />
                  <InfoRow
                    icon={<HardDrive className="size-3.5" />}
                    label="设置文件"
                    value={dbInfo?.settingsPath ?? "—"}
                  />
                  <InfoRow
                    icon={<HardDrive className="size-3.5" />}
                    label="日志目录"
                    value={dbInfo?.logsPath ?? "—"}
                  />
                  <InfoRow
                    icon={<HardDrive className="size-3.5" />}
                    label="外部工具目录"
                    value={dbInfo?.toolsPath ?? "—"}
                  />
                </CardContent>
              </Card>
            </TabsContent>
          </div>
        </Tabs>
      </WorkbenchPageContent>

      <AlertDialog
        open={pendingSettingsLeave !== null}
        onOpenChange={(open) => {
          if (!open && !leaveSaveBusy) {
            setPendingSettingsLeave(null)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>保存 AI 设置更改？</AlertDialogTitle>
            <AlertDialogDescription>
              当前配置或重命名提示词有未保存更改。离开后，这些更改将丢失。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={leaveSaveBusy}>
              继续编辑
            </AlertDialogCancel>
            <Button
              type="button"
              variant="outline"
              disabled={leaveSaveBusy}
              onClick={() => {
                if (pendingSettingsLeave) {
                  completeSettingsLeave(pendingSettingsLeave)
                }
              }}
            >
              放弃更改
            </Button>
            <AlertDialogAction
              disabled={leaveSaveBusy}
              onClick={(event) => {
                event.preventDefault()
                void handleSaveAndLeaveSettings()
              }}
            >
              {leaveSaveBusy ? "正在保存…" : "保存并离开"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </WorkbenchPage>
  )
})

function InfoRow({
  icon,
  label,
  value,
  badge,
  action,
}: {
  icon: React.ReactNode
  label: string
  value: string
  badge?: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {icon}
          <span>{label}</span>
          {badge ? <Badge variant="outline">{badge}</Badge> : null}
        </div>
        {action}
      </div>
      <p className="rounded-xl bg-muted/40 px-2.5 py-2 font-mono text-xs break-all text-foreground">
        {value}
      </p>
    </div>
  )
}

function logLevelLabel(level: AppLogLevel) {
  return LOG_LEVELS.find((item) => item.value === level)?.label ?? level
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "未知错误")
}
