"use client"

import { CircleAlert, RefreshCw } from "lucide-react"
import * as React from "react"

import {
  DefaultRecoveryCard,
  FullBundleCard,
  HashcatCard,
  JohnPerlCard,
  ToolsDirectoryCard,
} from "@/components/home/engine-settings-cards"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
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
  const [engineMessage, setEngineMessage] = React.useState<string | null>(null)
  const [engineError, setEngineError] = React.useState(false)
  const [recoveryBusy, setRecoveryBusy] = React.useState(false)
  const [recoveryMessage, setRecoveryMessage] = React.useState<string | null>(
    null
  )
  const [recoveryError, setRecoveryError] = React.useState(false)
  const [loadBusy, setLoadBusy] = React.useState(false)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const request = React.useRef(0)

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
    if (engineBusy) return
    setEngineBusy(true)
    setEngineError(false)
    setEngineMessage(pendingMessage)
    void operation()
      .then((result) => {
        setEngineError(Boolean(result.error))
        setEngineMessage(result.message)
      })
      .catch((error) => {
        setEngineError(true)
        setEngineMessage(`操作失败：${errorMessage(error)}`)
      })
      .finally(() => setEngineBusy(false))
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
    setEngineError(false)
    setEngineMessage(null)
    void openPath(path.trim()).catch((error) => {
      setEngineError(true)
      setEngineMessage(`无法跳转到该路径：${errorMessage(error)}`)
    })
  }

  const handleRecoveryModeChange = (mode: RecoveryComputeMode) => {
    if (
      recoveryBusy ||
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
    setRecoveryBusy(true)
    setRecoveryError(false)
    setRecoveryMessage("正在保存默认解密方式…")
    void updateSettings({ kind: "recoveryComputeMode", value: mode })
      .then((saved) => {
        setAppSettings(saved)
        setRecoveryMessage(
          mode === "gpuPreferred"
            ? "默认使用 GPU 优先；GPU 不可用或执行失败时自动回退 CPU。"
            : "默认仅使用 CPU，恢复任务不会调用 GPU。"
        )
      })
      .catch((error) => {
        setAppSettings(previous)
        setRecoveryError(true)
        setRecoveryMessage(`保存失败：${errorMessage(error)}`)
      })
      .finally(() => setRecoveryBusy(false))
  }

  const handleRefresh = () =>
    runEngineAction("正在重新探测解密引擎…", async () => {
      await refreshEngine()
      return { message: "解密引擎状态已刷新。" }
    })

  const scanLimitValue =
    scanLimitDraft ??
    String(
      appSettings?.recovery?.scanMaxFilesPerDirectory ??
        DEFAULT_SCAN_MAX_FILES_PER_DIRECTORY
    )
  const handleSaveScanLimit = async () => {
    if (recoveryBusy || appSettings === null) return
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
      setRecoveryMessage(
        limit === 0
          ? "已关闭目录文件数限制，下次任务生效。"
          : `已保存：直属文件超过 ${limit} 个时跳过该目录及其子目录的嵌套扫描，下次任务生效。`
      )
    } catch (error) {
      setRecoveryError(true)
      setRecoveryMessage(`保存失败：${errorMessage(error)}`)
    } finally {
      setRecoveryBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
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
      />
      <FullBundleCard
        status={fullBundle}
        busy={engineBusy}
        message={engineMessage}
        messageError={engineError}
        onInstall={handleInstallBundle}
        onOpen={handleOpenPath}
      />
      <ToolsDirectoryCard
        status={hashcat}
        value={toolsDirectory}
        busy={engineBusy}
        onChange={setToolsDirectoryInput}
        onOpen={handleOpenPath}
        onSave={handleSaveToolsDirectory}
        onReset={handleResetToolsDirectory}
      />
      <HashcatCard
        status={hashcat}
        busy={engineBusy}
        onDownload={handleDownloadHashcat}
      />
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
    </div>
  )
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "未知错误")
}
