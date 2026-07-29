"use client"

import {
  ArrowLeft,
  Cpu,
  Database,
  Download,
  ExternalLink,
  HardDrive,
  Package,
  Sparkles,
  Settings2,
  Zap,
} from "lucide-react"
import * as React from "react"

import { AiSettingsPanel } from "@/components/home/ai-settings-panel"
import { Alert, AlertDescription } from "@/components/ui/alert"
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

export function SettingsPage({
  initialCategory = "engine",
  onReturnToCompression,
}: {
  initialCategory?: SettingsCategory
  onReturnToCompression?: () => void
}) {
  const [category, setCategory] =
    React.useState<SettingsCategory>(initialCategory)
  const [dbInfo, setDbInfo] = React.useState<DatabaseInfo | null>(null)
  const [fullBundle, setFullBundle] =
    React.useState<FullEngineBundleStatus | null>(null)
  const [hashcat, setHashcat] = React.useState<HashcatStatus | null>(null)
  const [johnPerl, setJohnPerl] = React.useState<JohnPerlStatus | null>(null)
  const [appSettings, setAppSettings] = React.useState<AppSettings | null>(null)
  const [recoveryCapabilities, setRecoveryCapabilities] =
    React.useState<RecoveryCapabilities | null>(null)
  const [recoverySettingsBusy, setRecoverySettingsBusy] = React.useState(false)
  const [recoverySettingsMessage, setRecoverySettingsMessage] = React.useState<
    string | null
  >(null)
  const [toolsDirInput, setToolsDirInput] = React.useState("")
  const [johnDirInput, setJohnDirInput] = React.useState("")
  const [perlPathInput, setPerlPathInput] = React.useState("")
  const [engineBusy, setEngineBusy] = React.useState(false)
  const [engineMessage, setEngineMessage] = React.useState<string | null>(null)
  const [engineError, setEngineError] = React.useState(false)
  const [logSettingsBusy, setLogSettingsBusy] = React.useState(false)
  const [logSettingsMessage, setLogSettingsMessage] = React.useState<
    string | null
  >(null)
  const [logMaxDiskInput, setLogMaxDiskInput] = React.useState(
    String(DEFAULT_LOG_MAX_DISK_MIB)
  )

  const refreshEngine = React.useCallback(async () => {
    try {
      const [bundle, status, john, recovery] = await Promise.all([
        getFullEngineBundleStatus(),
        getHashcatStatus(),
        getJohnPerlStatus(),
        getRecoveryCapabilities(),
      ])
      setFullBundle(bundle)
      setHashcat(status)
      setJohnPerl(john)
      setRecoveryCapabilities(recovery)
      setToolsDirInput(status.configuredToolsDirectory || "")
      setJohnDirInput(john.johnToolsDirectory || "")
      setPerlPathInput(john.perlPath || "")
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error ?? "未知错误")
      setEngineMessage(`读取引擎状态失败：${message}`)
      setEngineError(true)
    }
  }, [])

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [info, bundle, status, john, settings, recovery] =
          await Promise.all([
            getDatabaseInfo(),
            getFullEngineBundleStatus(),
            getHashcatStatus(),
            getJohnPerlStatus(),
            getSettings(),
            getRecoveryCapabilities(),
          ])
        if (cancelled) {
          return
        }
        setDbInfo(info)
        setFullBundle(bundle)
        setHashcat(status)
        setJohnPerl(john)
        setAppSettings(settings)
        setRecoveryCapabilities(recovery)
        setLogMaxDiskInput(
          String(settings.logging?.maxDiskMib ?? DEFAULT_LOG_MAX_DISK_MIB)
        )
        setToolsDirInput(status.configuredToolsDirectory || "")
        setJohnDirInput(john.johnToolsDirectory || "")
        setPerlPathInput(john.perlPath || "")
      } catch {
        if (!cancelled) {
          setDbInfo(null)
          setFullBundle(null)
          setHashcat(null)
          setJohnPerl(null)
          setAppSettings(null)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

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
        setJohnPerl(status)
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
        setJohnPerl(status)
        setJohnDirInput(status.johnToolsDirectory || "")
        setPerlPathInput(status.perlPath || "")
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
    setLogSettingsMessage("正在保存日志级别…")
    void (async () => {
      try {
        const saved = await setSettings(next)
        setAppSettings(saved)
        setLogSettingsMessage(`日志级别已切换为“${logLevelLabel(level)}”。`)
      } catch (error) {
        setAppSettings(previous)
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
      setLogSettingsMessage(
        `请输入 ${MIN_LOG_MAX_DISK_MIB}–${MAX_LOG_MAX_DISK_MIB} 之间的整数。`
      )
      return
    }
    if (
      (appSettings.logging?.maxDiskMib ?? DEFAULT_LOG_MAX_DISK_MIB) ===
      maxDiskMib
    ) {
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
    setLogSettingsMessage("正在保存日志容量…")
    void (async () => {
      try {
        const saved = await setSettings(next)
        const savedMaxDiskMib =
          saved.logging?.maxDiskMib ?? DEFAULT_LOG_MAX_DISK_MIB
        setAppSettings(saved)
        setLogMaxDiskInput(String(savedMaxDiskMib))
        setLogSettingsMessage(`日志最大占用已调整为 ${savedMaxDiskMib} MiB。`)
      } catch (error) {
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
    setRecoverySettingsMessage("正在保存默认解密方式…")
    void (async () => {
      try {
        const saved = await setSettings(next)
        setAppSettings(saved)
        setRecoverySettingsMessage(
          mode === "gpuPreferred"
            ? "默认使用 GPU 优先；GPU 不可用或执行失败时自动回退 CPU。"
            : "默认仅使用 CPU，恢复任务不会调用 GPU。"
        )
      } catch (error) {
        setAppSettings(previous)
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

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="workbench-page flex h-full min-h-0 flex-col gap-2 px-5 pt-6 pb-2">
        <header className="shrink-0">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] font-medium tracking-[0.16em] text-muted-foreground uppercase">
                Preferences
              </p>
              <h1 className="mt-1 text-lg font-semibold tracking-tight">
                设置
              </h1>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {activeMeta.description}
              </p>
            </div>
            {onReturnToCompression ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={onReturnToCompression}
              >
                <ArrowLeft data-icon="inline-start" />
                返回压缩
              </Button>
            ) : null}
          </div>
        </header>

        <Tabs
          value={category}
          onValueChange={(value) => {
            if (value == null) {
              return
            }
            setCategory(value as SettingsCategory)
          }}
          className="flex min-h-0 flex-1 flex-col gap-2"
        >
          <TabsList className="h-auto w-full shrink-0 flex-wrap justify-start gap-0.5 rounded-2xl p-1">
            {CATEGORIES.map((item) => {
              const Icon = item.icon
              return (
                <TabsTrigger
                  key={item.id}
                  value={item.id}
                  className="flex-none gap-1.5 px-2.5 text-xs sm:text-sm"
                >
                  <Icon className="size-3.5" strokeWidth={1.9} />
                  {item.label}
                </TabsTrigger>
              )
            })}
          </TabsList>

          <div className="min-h-0 flex-1 scroll-fade overflow-y-auto pb-1">
            <TabsContent value="ai" className="mt-0 outline-none">
              <AiSettingsPanel />
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
                        <CardTitle className="text-sm">默认解密方式</CardTitle>
                        <Badge variant="secondary" className="font-normal">
                          可在解压页快速切换
                        </Badge>
                      </div>
                      <CardDescription className="text-xs">
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
                <CardContent className="flex flex-col gap-3 pt-4">
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
                            <FieldDescription className="text-[11px]">
                              Hashcat GPU → Hashcat / John / 7-Zip CPU
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
                            <FieldDescription className="text-[11px]">
                              Hashcat CPU → John CPU → 7-Zip CPU
                            </FieldDescription>
                          </FieldContent>
                          <RadioGroupItem id="compute-cpu" value="cpuOnly" />
                        </Field>
                      </FieldLabel>
                    </RadioGroup>
                  </FieldSet>
                  <div>
                    <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">
                      当前支持的恢复方式
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {recoveryCapabilities?.methods.map((method, index) => (
                        <Badge
                          key={method.id}
                          title={method.message}
                          style={{
                            animationDelay: `${Math.min(index, 4) * 45}ms`,
                          }}
                          variant={method.available ? "default" : "outline"}
                          className="animate-status-chip-enter motion-safe-only font-normal"
                        >
                          {method.label} ·{" "}
                          {method.available ? "可用" : "未就绪"}
                        </Badge>
                      )) ?? (
                        <Badge variant="outline" className="font-normal">
                          正在探测…
                        </Badge>
                      )}
                    </div>
                  </div>
                  {recoverySettingsMessage ? (
                    <Alert>
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
                        <CardTitle className="text-sm">
                          Windows x64 完整离线包
                        </CardTitle>
                        <Badge variant="secondary" className="font-normal">
                          清单 v{fullBundle?.manifestVersion ?? 1}
                        </Badge>
                        <Badge
                          variant={fullBundle?.bundled ? "default" : "outline"}
                          className="font-normal"
                        >
                          {fullBundle?.bundled ? "资源已内置" : "精简构建"}
                        </Badge>
                        <Badge
                          variant={
                            fullBundle?.installed ? "default" : "outline"
                          }
                          className="font-normal"
                        >
                          {fullBundle?.installed ? "全部就绪" : "待部署"}
                        </Badge>
                      </div>
                      <CardDescription className="text-xs">
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
                      {fullBundle?.installed ? "重新检测 / 补全" : "离线部署"}
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="flex flex-col gap-3 pt-4">
                  <div className="flex flex-wrap gap-1.5">
                    {[
                      { id: "7zip", component: fullBundle?.sevenZip },
                      { id: "hashcat", component: fullBundle?.hashcat },
                      { id: "john", component: fullBundle?.john },
                      { id: "perl", component: fullBundle?.perl },
                    ].map(({ id, component }) => (
                      <Badge
                        key={id}
                        variant={component?.runnable ? "default" : "outline"}
                        className="font-normal"
                      >
                        {component?.name ?? "检测中"}{" "}
                        {component?.version ?? "—"} ·{" "}
                        {component?.runnable ? "可运行" : "未就绪"}
                      </Badge>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Badge
                      variant={fullBundle?.has7z2john ? "default" : "outline"}
                      className="font-normal"
                    >
                      7z2john {fullBundle?.has7z2john ? "可用" : "缺失"}
                    </Badge>
                    <Badge
                      variant={fullBundle?.hasRar2john ? "default" : "outline"}
                      className="font-normal"
                    >
                      rar2john {fullBundle?.hasRar2john ? "可用" : "缺失"}
                    </Badge>
                    <Badge
                      variant={fullBundle?.hasZip2john ? "default" : "outline"}
                      className="font-normal"
                    >
                      zip2john {fullBundle?.hasZip2john ? "可用" : "缺失"}
                    </Badge>
                    <Badge
                      variant={fullBundle?.johnCpuReady ? "default" : "outline"}
                      className="font-normal"
                    >
                      CPU 回退 {fullBundle?.johnCpuReady ? "可用" : "缺失"}
                    </Badge>
                  </div>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {fullBundle?.message ?? "正在读取完整包状态…"}
                    GPU 驱动、CUDA、HIP 与 OpenCL
                    由系统提供，不进入发行包；无可用加速后端时使用 John CPU
                    回退。
                  </p>
                  {engineMessage ? (
                    <Alert variant={engineError ? "destructive" : "default"}>
                      <AlertDescription>{engineMessage}</AlertDescription>
                    </Alert>
                  ) : null}
                </CardContent>
              </Card>

              <Card size="sm">
                <CardHeader className="border-b border-border/80">
                  <CardTitle className="text-sm">工具公共目录</CardTitle>
                  <CardDescription className="text-xs">
                    引擎下载安装的根目录。可设为公共/共享路径，供本机多处复用；留空则使用应用默认
                    tools 目录。
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3 pt-4">
                  <Field>
                    <FieldLabel
                      htmlFor="tools-dir"
                      className="text-xs text-muted-foreground"
                    >
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
                          <ExternalLink />
                          跳转
                        </InputGroupButton>
                      </InputGroupAddon>
                    </InputGroup>
                    <FieldDescription className="text-[11px]">
                      默认：{hashcat?.defaultToolsDirectory || "—"}
                    </FieldDescription>
                    <FieldDescription className="text-[11px]">
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
                        <CardTitle className="text-sm">hashcat</CardTitle>
                        <Badge variant="secondary" className="font-normal">
                          v{hashcat?.version ?? "—"}
                        </Badge>
                        <Badge
                          variant={hashcatReady ? "default" : "outline"}
                          className="font-normal"
                        >
                          {hashcatReady ? "已就绪" : "未安装"}
                        </Badge>
                      </div>
                      <CardDescription className="text-xs">
                        完整发行包已内置固定版本；这里保留 GitHub
                        下载作为精简构建或修复安装的后备路径。下载同样执行
                        SHA-256 校验，不静默更新、不提权。
                      </CardDescription>
                    </div>
                    <Button
                      size="sm"
                      disabled={engineBusy}
                      onClick={handleDownloadHashcat}
                    >
                      <Download data-icon="inline-start" />
                      {hashcat?.installed ? "重新检测 / 补全" : "下载并安装"}
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="flex flex-col gap-3 pt-4">
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
                        <CardTitle className="text-sm">John / Perl</CardTitle>
                        <Badge
                          variant={johnPerl?.ready ? "default" : "outline"}
                          className="font-normal"
                        >
                          {johnPerl?.ready ? "已就绪" : "未就绪"}
                        </Badge>
                      </div>
                      <CardDescription className="text-xs">
                        完整包会自动写入 John 工具目录与
                        perl.exe；也可在此覆盖为 自备版本。提供
                        7z2john、rar2john、zip2john 哈希转换及 John CPU 回退。
                      </CardDescription>
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={engineBusy}
                        onClick={handleProbeJohnPerl}
                      >
                        重新检测
                      </Button>
                      <Button
                        size="sm"
                        disabled={engineBusy}
                        onClick={handleSaveJohnPerl}
                      >
                        保存
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="flex flex-col gap-3 pt-4">
                  <Field>
                    <FieldLabel
                      htmlFor="john-dir"
                      className="text-xs text-muted-foreground"
                    >
                      John 工具目录
                    </FieldLabel>
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
                          <ExternalLink />
                          跳转
                        </InputGroupButton>
                      </InputGroupAddon>
                    </InputGroup>
                  </Field>
                  <Field>
                    <FieldLabel
                      htmlFor="perl-path"
                      className="text-xs text-muted-foreground"
                    >
                      perl.exe 路径
                    </FieldLabel>
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
                          <ExternalLink />
                          跳转
                        </InputGroupButton>
                      </InputGroupAddon>
                    </InputGroup>
                  </Field>
                  <div className="flex flex-wrap gap-1.5">
                    <Badge
                      variant={
                        johnPerl?.sevenZipConverterReady ? "default" : "outline"
                      }
                      className="font-normal"
                    >
                      7z2john{" "}
                      {johnPerl?.sevenZipConverterReady ? "可用" : "缺失"}
                    </Badge>
                    <Badge
                      variant={
                        johnPerl?.rarConverterReady ? "default" : "outline"
                      }
                      className="font-normal"
                    >
                      rar2john {johnPerl?.rarConverterReady ? "可用" : "缺失"}
                    </Badge>
                    <Badge
                      variant={
                        johnPerl?.zipConverterReady ? "default" : "outline"
                      }
                      className="font-normal"
                    >
                      zip2john {johnPerl?.zipConverterReady ? "可用" : "缺失"}
                    </Badge>
                    <Badge
                      variant={johnPerl?.johnCpuReady ? "default" : "outline"}
                      className="font-normal"
                    >
                      John CPU {johnPerl?.johnCpuReady ? "可用" : "缺失"}
                    </Badge>
                    <Badge
                      variant={johnPerl?.perlExists ? "default" : "outline"}
                      className="font-normal"
                    >
                      perl {johnPerl?.perlExists ? "可用" : "未配置"}
                    </Badge>
                  </div>
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
                      <CardTitle className="text-sm">应用日志</CardTitle>
                      <Badge variant="outline" className="font-normal">
                        {appSettings?.logging?.maxDiskMib ??
                          DEFAULT_LOG_MAX_DISK_MIB}{" "}
                        MiB 上限
                      </Badge>
                    </div>
                    <CardDescription className="text-xs leading-relaxed">
                      控制本机 JSONL
                      日志的详细程度和最大磁盘占用。密码、候选内容和用户路径会在写入前隐藏。
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3 pt-4">
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
                            className="h-auto min-h-14 flex-col items-start gap-0.5 rounded-xl px-2.5 py-2 text-left"
                          >
                            <span className="block text-xs font-medium">
                              {item.label}
                            </span>
                            <span className="block text-[10px] leading-tight text-muted-foreground">
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
                      <div className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
                        <Field className="max-w-48 gap-1.5">
                          <FieldLabel htmlFor="log-max-disk-mib">
                            最大磁盘占用
                          </FieldLabel>
                          <InputGroup>
                            <InputGroupInput
                              id="log-max-disk-mib"
                              type="number"
                              inputMode="numeric"
                              min={MIN_LOG_MAX_DISK_MIB}
                              max={MAX_LOG_MAX_DISK_MIB}
                              step={5}
                              value={logMaxDiskInput}
                              onChange={(event) =>
                                setLogMaxDiskInput(event.target.value)
                              }
                              aria-describedby="log-max-disk-hint"
                            />
                            <InputGroupAddon align="inline-end">
                              <InputGroupText>MiB</InputGroupText>
                            </InputGroupAddon>
                          </InputGroup>
                        </Field>
                        <Button
                          type="button"
                          size="sm"
                          onClick={handleSaveLogCapacity}
                        >
                          保存容量
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
                      <FieldDescription
                        id="log-max-disk-hint"
                        className="text-[11px] leading-relaxed text-muted-foreground"
                      >
                        可设置 {MIN_LOG_MAX_DISK_MIB}–{MAX_LOG_MAX_DISK_MIB}{" "}
                        MiB；日志按 5 MiB 分片，到达总上限后自动删除最旧文件。
                      </FieldDescription>
                    </FieldSet>
                    {logSettingsMessage ? (
                      <Alert>
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
                      <CardTitle className="text-sm">内置 7-Zip</CardTitle>
                      <Badge
                        variant={
                          fullBundle?.sevenZip.runnable ? "default" : "outline"
                        }
                        className="font-normal"
                      >
                        {fullBundle?.sevenZip.runnable ? "可运行" : "未就绪"}
                      </Badge>
                    </div>
                    <CardDescription className="text-xs leading-relaxed">
                      {fullBundle?.sevenZip.message ??
                        "正在读取 7-Zip 进程探测状态…"}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <InfoRow
                      icon={<HardDrive className="size-3.5" />}
                      label="7z.exe"
                      value={fullBundle?.sevenZip.executablePath ?? "—"}
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
                    <CardTitle className="text-sm">本地数据</CardTitle>
                  </div>
                  <CardDescription className="text-xs">
                    本机
                    SQLite，不在项目仓库内；缺失时自动创建。字典导入编码自动识别。
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3 pt-4">
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
      </div>
    </div>
  )
}

function InfoRow({
  icon,
  label,
  value,
  badge,
}: {
  icon: React.ReactNode
  label: string
  value: string
  badge?: string
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        <span>{label}</span>
        {badge ? (
          <Badge variant="outline" className="font-normal">
            {badge}
          </Badge>
        ) : null}
      </div>
      <p className="rounded-xl bg-muted/40 px-2.5 py-2 font-mono text-[11px] break-all text-foreground">
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
