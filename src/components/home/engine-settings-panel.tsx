"use client"

import { WorkbenchDetails } from "./workbench-details"

import { CircleAlert, RefreshCw } from "lucide-react"
import * as React from "react"
import { toast } from "sonner"

import {
  DefaultRecoveryCard,
  FullBundleCard,
  HashcatCard,
  JohnPerlCard,
  ToolsDirectoryCard,
} from "@/components/home/engine-settings-cards"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import {
  getRecoveryCapabilities,
  refreshRecoveryCapabilities,
  type RecoveryCapabilities,
  type RecoveryComputeMode,
} from "@/lib/recovery"
import {
  type AppSettings,
  type FullEngineBundleStatus,
  type HashcatStatus,
  type JohnPerlStatus,
  DEFAULT_SCAN_MAX_FILES_PER_DIRECTORY,
  MAX_SCAN_MAX_FILES_PER_DIRECTORY,
  downloadHashcat,
  getFullEngineBundleStatus,
  getHashcatStatus,
  getJohnPerlStatus,
  getSettings,
  installFullEngineBundle,
  openPath,
  setJohnPerl,
  updateSettings,
  setToolsDirectory,
} from "@/lib/settings"

type EngineStatusSnapshot = {
  fullBundle: FullEngineBundleStatus
  hashcat: HashcatStatus
  johnPerl: JohnPerlStatus
  recoveryCapabilities: RecoveryCapabilities
}

type EngineActionResult = {
  message: string
  error?: boolean
}

let cachedEngineStatus: EngineStatusSnapshot | null = null

export function EngineSettingsPanel() {
  const [scanLimitDraft, setScanLimitDraft] = React.useState<string | null>(
    null
  )
  const [fullBundle, setFullBundle] =
    React.useState<FullEngineBundleStatus | null>(
      () => cachedEngineStatus?.fullBundle ?? null
    )
  const [hashcat, setHashcat] = React.useState<HashcatStatus | null>(
    () => cachedEngineStatus?.hashcat ?? null
  )
  const [johnPerl, setJohnPerlStatus] = React.useState<JohnPerlStatus | null>(
    () => cachedEngineStatus?.johnPerl ?? null
  )
  const [capabilities, setCapabilities] =
    React.useState<RecoveryCapabilities | null>(
      () => cachedEngineStatus?.recoveryCapabilities ?? null
    )
  const [appSettings, setAppSettings] = React.useState<AppSettings | null>(null)
  const [toolsDirectory, setToolsDirectoryInput] = React.useState(
    () => cachedEngineStatus?.hashcat.configuredToolsDirectory ?? ""
  )
  const [johnDirectory, setJohnDirectory] = React.useState(
    () => cachedEngineStatus?.johnPerl.johnToolsDirectory ?? ""
  )
  const [perlPath, setPerlPath] = React.useState(
    () => cachedEngineStatus?.johnPerl.perlPath ?? ""
  )
  const [engineBusy, setEngineBusy] = React.useState(false)
  const engineOperation = React.useRef(false)
  const recoveryOperation = React.useRef(false)
  const [engineMessage, setEngineMessage] = React.useState<string | null>(null)
  const [recoveryBusy, setRecoveryBusy] = React.useState(false)
  const [recoveryMessage, setRecoveryMessage] = React.useState<string | null>(
    null
  )
  const [recoveryError, setRecoveryError] = React.useState(false)
  const [loadBusy, setLoadBusy] = React.useState(false)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const request = React.useRef(0)
  const loaded = React.useRef(false)

  const applyJohnStatus = React.useCallback((status: JohnPerlStatus) => {
    if (cachedEngineStatus) {
      cachedEngineStatus = { ...cachedEngineStatus, johnPerl: status }
    }
    setJohnPerlStatus(status)
    setJohnDirectory(status.johnToolsDirectory || "")
    setPerlPath(status.perlPath || "")
  }, [])

  const applyEngineStatus = React.useCallback(
    (snapshot: EngineStatusSnapshot) => {
      cachedEngineStatus = snapshot
      setFullBundle(snapshot.fullBundle)
      setHashcat(snapshot.hashcat)
      setJohnPerlStatus(snapshot.johnPerl)
      setCapabilities(snapshot.recoveryCapabilities)
      setToolsDirectoryInput(snapshot.hashcat.configuredToolsDirectory || "")
      setJohnDirectory(snapshot.johnPerl.johnToolsDirectory || "")
      setPerlPath(snapshot.johnPerl.perlPath || "")
    },
    []
  )

  const refreshEngine = React.useCallback(async () => {
    const [bundle, status, john, recovery, settings] = await Promise.all([
      getFullEngineBundleStatus(),
      getHashcatStatus(),
      getJohnPerlStatus(),
      refreshRecoveryCapabilities(),
      getSettings(),
    ])
    setAppSettings(settings)
    applyEngineStatus({
      fullBundle: bundle,
      hashcat: status,
      johnPerl: john,
      recoveryCapabilities: recovery,
    })
  }, [applyEngineStatus])

  const load = React.useCallback(async () => {
    const requestId = ++request.current
    setLoadBusy(true)
    setLoadError(null)
    const results = await Promise.allSettled([
      getFullEngineBundleStatus(),
      getHashcatStatus(),
      getJohnPerlStatus(),
      getRecoveryCapabilities(),
      getSettings(),
    ] as const)
    if (requestId !== request.current) {
      return
    }
    loaded.current = true

    const [bundle, hashcatStatus, john, recovery, settings] = results
    if (bundle.status === "fulfilled") setFullBundle(bundle.value)
    if (hashcatStatus.status === "fulfilled") {
      setHashcat(hashcatStatus.value)
      setToolsDirectoryInput(hashcatStatus.value.configuredToolsDirectory || "")
    }
    if (john.status === "fulfilled") applyJohnStatus(john.value)
    if (recovery.status === "fulfilled") setCapabilities(recovery.value)
    if (settings.status === "fulfilled") setAppSettings(settings.value)
    if (
      bundle.status === "fulfilled" &&
      hashcatStatus.status === "fulfilled" &&
      john.status === "fulfilled" &&
      recovery.status === "fulfilled"
    ) {
      applyEngineStatus({
        fullBundle: bundle.value,
        hashcat: hashcatStatus.value,
        johnPerl: john.value,
        recoveryCapabilities: recovery.value,
      })
    }

    const labels = [
      "完整引擎包",
      "Hashcat",
      "John / Perl",
      "恢复能力",
      "应用设置",
    ]
    const failedLabels = results.flatMap((result, index) =>
      result.status === "rejected" ? [labels[index]] : []
    )
    if (failedLabels.length > 0) {
      setLoadError(`读取失败：${failedLabels.join("、")}。`)
    }
    setLoadBusy(false)
  }, [applyEngineStatus, applyJohnStatus])

  React.useEffect(() => {
    if (loaded.current || engineOperation.current || recoveryOperation.current)
      return
    const timeout = setTimeout(() => void load(), 0)
    return () => {
      clearTimeout(timeout)
      request.current += 1
    }
  }, [load])

  const runEngineAction = (
    pendingMessage: string,
    operation: () => Promise<EngineActionResult>
  ) => {
    if (engineBusy || engineOperation.current) return
    engineOperation.current = true
    setEngineBusy(true)
    setEngineMessage(pendingMessage)
    void operation()
      .then((result) => {
        setEngineMessage(null)
        if (result.error) {
          toast.error(result.message, { id: "engine-action", duration: 6_000 })
        } else {
          toast.success(result.message, {
            id: "engine-action",
            duration: 6_000,
          })
        }
      })
      .catch((error) => {
        setEngineMessage(null)
        toast.error(`操作失败：${errorMessage(error)}`, {
          id: "engine-action",
          duration: 6_000,
        })
      })
      .finally(() => {
        engineOperation.current = false
        setEngineBusy(false)
      })
  }

  const handleSaveToolsDirectory = () =>
    runEngineAction("正在保存公共工具目录…", async () => {
      await setToolsDirectory(toolsDirectory.trim())
      await refreshEngine()
      return {
        message: toolsDirectory.trim()
          ? "已保存公共工具目录；下载的引擎将安装到此目录。"
          : "已恢复默认工具目录（应用数据下的 tools）。",
      }
    })

  const handleResetToolsDirectory = () => {
    if (engineOperation.current) return
    setToolsDirectoryInput("")
    runEngineAction("正在恢复默认工具目录…", async () => {
      await setToolsDirectory("")
      await refreshEngine()
      return { message: "已恢复默认工具目录。" }
    })
  }

  const handleDownloadHashcat = () =>
    runEngineAction(
      "正在从 GitHub 下载 hashcat 固定版本（校验 SHA-256）…",
      async () => {
        const result = await downloadHashcat()
        await refreshEngine()
        return { message: result.message, error: !result.success }
      }
    )

  const handleInstallBundle = () =>
    runEngineAction(
      "正在校验并离线展开完整引擎包；便携 Perl 体积较大，请稍候…",
      async () => {
        const result = await installFullEngineBundle()
        await refreshEngine()
        return { message: result.message, error: !result.success }
      }
    )

  const handleSaveJohnPerl = () =>
    runEngineAction("正在保存 John / Perl 路径…", async () => {
      const status = await setJohnPerl(johnDirectory.trim(), perlPath.trim())
      applyJohnStatus(status)
      await refreshEngine()
      return { message: status.message, error: !status.ready }
    })

  const handleProbeJohnPerl = () =>
    runEngineAction("正在检测 John / Perl…", async () => {
      const status = await getJohnPerlStatus()
      applyJohnStatus(status)
      return {
        message: status.message,
        error: !status.ready && Boolean(status.johnToolsDirectory),
      }
    })

  const handleOpenPath = (path: string) => {
    if (engineBusy || !path.trim()) return
    setEngineMessage(null)
    void openPath(path.trim()).catch((error) => {
      toast.error(`无法跳转到该路径：${errorMessage(error)}`, {
        id: "engine-action",
        duration: 6_000,
      })
    })
  }

  const handleRecoveryModeChange = (mode: RecoveryComputeMode) => {
    if (
      recoveryBusy ||
      recoveryOperation.current ||
      appSettings === null ||
      (appSettings.recovery?.computeMode ?? "gpuPreferred") === mode
    ) {
      return
    }
    const previous = appSettings
    const next = {
      ...appSettings,
      recovery: { ...appSettings.recovery, computeMode: mode },
    }
    setAppSettings(next)
    recoveryOperation.current = true
    setRecoveryBusy(true)
    setRecoveryError(false)
    setRecoveryMessage("正在保存默认解密方式…")
    void updateSettings({ kind: "recoveryComputeMode", value: mode })
      .then((saved) => {
        setAppSettings(saved)
        setRecoveryMessage(null)
        toast.success(
          mode === "gpuPreferred"
            ? "默认使用 GPU 优先；GPU 不可用或执行失败时自动回退 CPU。"
            : "默认仅使用 CPU，恢复任务不会调用 GPU。",
          { id: "recovery-settings", duration: 4_000 }
        )
      })
      .catch((error) => {
        setAppSettings(previous)
        setRecoveryError(true)
        setRecoveryMessage(null)
        toast.error(`保存失败：${errorMessage(error)}`, {
          id: "recovery-settings",
          duration: 6_000,
        })
      })
      .finally(() => {
        recoveryOperation.current = false
        setRecoveryBusy(false)
      })
  }

  const handleRefresh = () =>
    runEngineAction("正在重新探测解密引擎…", async () => {
      await refreshEngine()
      return { message: "解密引擎状态已刷新。" }
    })

  const handleDirectorySettingChange = async (
    kind: "removeEmptyDirectories" | "flattenOutputDirectories",
    value: boolean
  ) => {
    if (recoveryBusy || recoveryOperation.current || appSettings === null)
      return
    const label =
      kind === "removeEmptyDirectories"
        ? "智能清理空文件夹"
        : "去除多层无效嵌套"
    recoveryOperation.current = true
    setRecoveryBusy(true)
    setRecoveryError(false)
    setRecoveryMessage("正在保存目录整理设置…")
    try {
      setAppSettings(await updateSettings({ kind, value }))
      setRecoveryMessage(null)
      toast.success(`已${value ? "开启" : "关闭"}${label}，下次任务生效。`, {
        id: "recovery-settings",
        duration: 4_000,
      })
    } catch (error) {
      setRecoveryError(true)
      setRecoveryMessage(null)
      toast.error(`保存失败：${errorMessage(error)}`, {
        id: "recovery-settings",
        duration: 6_000,
      })
    } finally {
      recoveryOperation.current = false
      setRecoveryBusy(false)
    }
  }

  const scanLimitValue =
    scanLimitDraft ??
    String(
      appSettings?.recovery?.scanMaxFilesPerDirectory ??
        DEFAULT_SCAN_MAX_FILES_PER_DIRECTORY
    )
  const handleSaveScanLimit = async () => {
    if (recoveryBusy || recoveryOperation.current || appSettings === null)
      return
    const limit = Number(scanLimitValue)
    if (
      !scanLimitValue.trim() ||
      !Number.isInteger(limit) ||
      limit < 0 ||
      limit > MAX_SCAN_MAX_FILES_PER_DIRECTORY
    ) {
      setRecoveryError(true)
      setRecoveryMessage(
        `文件数上限必须是 0 到 ${MAX_SCAN_MAX_FILES_PER_DIRECTORY} 之间的整数。`
      )
      return
    }
    recoveryOperation.current = true
    setRecoveryBusy(true)
    setRecoveryError(false)
    setRecoveryMessage("正在保存扫描上限…")
    try {
      const saved = await updateSettings({
        kind: "scanMaxFilesPerDirectory",
        value: limit,
      })
      setAppSettings(saved)
      setScanLimitDraft(null)
      setRecoveryMessage(null)
      toast.success(
        limit === 0
          ? "已关闭目录文件数限制，下次任务生效。"
          : `已保存扫描上限：${limit} 个文件，下次任务生效。`,
        { id: "recovery-settings", duration: 4_000 }
      )
    } catch (error) {
      setRecoveryError(true)
      setRecoveryMessage(null)
      toast.error(`保存失败：${errorMessage(error)}`, {
        id: "recovery-settings",
        duration: 6_000,
      })
    } finally {
      recoveryOperation.current = false
      setRecoveryBusy(false)
    }
  }

  return (
    <div className="byte-engine-panel flex flex-col gap-6">
      {loadError ? (
        <Alert variant="warning">
          <CircleAlert />
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>{loadError} 已成功读取的区域仍可使用。</span>
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={loadBusy}
              onClick={() => void load()}
            >
              <RefreshCw data-icon="inline-start" />
              {loadBusy ? "正在重试" : "重试读取"}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      <DefaultRecoveryCard
        appSettings={appSettings}
        capabilities={capabilities}
        settingsBusy={recoveryBusy}
        engineBusy={engineBusy}
        message={recoveryMessage}
        messageError={recoveryError}
        onChange={handleRecoveryModeChange}
        onRefresh={handleRefresh}
        scanLimitValue={scanLimitValue}
        onScanLimitChange={setScanLimitDraft}
        onSaveScanLimit={() => void handleSaveScanLimit()}
        onRemoveEmptyDirectoriesChange={(value) =>
          void handleDirectorySettingChange("removeEmptyDirectories", value)
        }
        onFlattenOutputDirectoriesChange={(value) =>
          void handleDirectorySettingChange("flattenOutputDirectories", value)
        }
      />
      <section className="byte-engine-actions flex flex-col items-start gap-3 border-t pt-6">
        <div>
          <h3 className="text-sm font-medium">引擎与工具</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            管理完整引擎包、工具目录与运行环境。
          </p>
        </div>
        <Tabs defaultValue="bundle" className="w-full">
          <WorkbenchDetails
            title="引擎管理"
            description="安装引擎、配置工具路径与检查运行环境。"
            footer={
              engineMessage ? (
                <p
                  role="status"
                  className="order-first mb-3 flex max-h-20 items-start gap-2 overflow-y-auto text-sm break-words text-muted-foreground"
                >
                  {engineBusy ? <Spinner className="mt-0.5 shrink-0" /> : null}
                  {engineMessage}
                </p>
              ) : null
            }
            toolbar={
              <TabsList className="grid h-auto w-full grid-cols-2 gap-1 sm:grid-cols-4">
                <TabsTrigger value="bundle">完整引擎包</TabsTrigger>
                <TabsTrigger value="tools">工具目录</TabsTrigger>
                <TabsTrigger value="hashcat">Hashcat</TabsTrigger>
                <TabsTrigger value="john">John / Perl</TabsTrigger>
              </TabsList>
            }
          >
            <TabsContent value="bundle" className="mt-0">
              <FullBundleCard
                status={fullBundle}
                busy={engineBusy}
                onInstall={handleInstallBundle}
                onOpen={handleOpenPath}
              />
            </TabsContent>
            <TabsContent value="tools" className="mt-0">
              <ToolsDirectoryCard
                status={hashcat}
                value={toolsDirectory}
                busy={engineBusy}
                onChange={setToolsDirectoryInput}
                onOpen={handleOpenPath}
                onSave={handleSaveToolsDirectory}
                onReset={handleResetToolsDirectory}
              />
            </TabsContent>
            <TabsContent value="hashcat" className="mt-0">
              <HashcatCard
                status={hashcat}
                busy={engineBusy}
                onDownload={handleDownloadHashcat}
              />
            </TabsContent>
            <TabsContent value="john" className="mt-0">
              <JohnPerlCard
                status={johnPerl}
                johnDirectory={johnDirectory}
                perlPath={perlPath}
                busy={engineBusy}
                onJohnDirectoryChange={setJohnDirectory}
                onPerlPathChange={setPerlPath}
                onOpen={handleOpenPath}
                onProbe={handleProbeJohnPerl}
                onSave={handleSaveJohnPerl}
              />
            </TabsContent>
          </WorkbenchDetails>
        </Tabs>
      </section>
    </div>
  )
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "未知错误")
}
