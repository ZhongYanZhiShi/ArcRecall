import { invoke } from "@tauri-apps/api/core"

import { countDictionary, isDesktopRuntime } from "@/lib/dictionary"
import type { RecoveryComputeMode } from "@/lib/recovery"

export type EngineSettings = {
  /** Empty = app default tools dir under ArcRecall. */
  toolsDirectory?: string
  hashcatPath: string
  johnToolsDirectory?: string
  perlPath?: string
}

export type AppLogLevel = "error" | "warn" | "info" | "debug"

export const DEFAULT_LOG_MAX_DISK_MIB = 25
export const MIN_LOG_MAX_DISK_MIB = 5
export const MAX_LOG_MAX_DISK_MIB = 500
export const DEFAULT_SCAN_MAX_FILES_PER_DIRECTORY = 10
export const MAX_SCAN_MAX_FILES_PER_DIRECTORY = 0xffffffff

export type LoggingSettings = {
  level: AppLogLevel
  maxDiskMib: number
}

export type AppSettings = {
  version?: number
  engine?: EngineSettings
  logging?: LoggingSettings
  recovery?: {
    computeMode: RecoveryComputeMode
    scanMaxFilesPerDirectory?: number
  }
}

export type DatabaseInfo = {
  path: string
  exists: boolean
  candidateCount: number
  settingsPath: string
  rootPath: string
  logsPath: string
  toolsPath: string
}

export type HashcatStatus = {
  version: string
  downloadUrl: string
  githubRepo: string
  installed: boolean
  executablePath: string
  installDirectory: string
  toolsDirectory: string
  defaultToolsDirectory: string
  configuredToolsDirectory: string
  configuredPath: string
  configuredExists: boolean
}

export type HashcatInstallResult = {
  success: boolean
  message: string
  executablePath: string
}

export type EngineComponentStatus = {
  id: string
  name: string
  version: string
  bundled: boolean
  installed: boolean
  runnable: boolean
  executablePath: string
  message: string
}

export type FullEngineBundleStatus = {
  manifestVersion: number
  target: string
  platformSupported: boolean
  bundled: boolean
  installed: boolean
  resourceDirectory: string
  toolsDirectory: string
  sevenZip: EngineComponentStatus
  hashcat: EngineComponentStatus
  john: EngineComponentStatus
  perl: EngineComponentStatus
  has7z2john: boolean
  hasRar2john: boolean
  hasZip2john: boolean
  johnCpuReady: boolean
  message: string
}

export type FullEngineBundleInstallResult = {
  success: boolean
  message: string
  sevenZipPath: string
  hashcatPath: string
  johnToolsDirectory: string
  perlPath: string
}

export type JohnPerlStatus = {
  johnToolsDirectory: string
  perlPath: string
  directoryExists: boolean
  has7z2johnExe: boolean
  has7z2johnPl: boolean
  hasRar2johnExe: boolean
  hasZip2johnExe: boolean
  hasJohnExe: boolean
  perlExists: boolean
  sevenZipConverterReady: boolean
  rarConverterReady: boolean
  zipConverterReady: boolean
  johnCpuReady: boolean
  ready: boolean
  message: string
}

const browserComponent = (
  id: string,
  name: string,
  version: string
): EngineComponentStatus => ({
  id,
  name,
  version,
  bundled: false,
  installed: false,
  runnable: false,
  executablePath: "",
  message: "浏览器预览不包含桌面引擎。",
})

export async function getFullEngineBundleStatus(): Promise<FullEngineBundleStatus> {
  if (!isDesktopRuntime()) {
    return {
      manifestVersion: 1,
      target: "windows-x86_64",
      platformSupported: false,
      bundled: false,
      installed: false,
      resourceDirectory: "",
      toolsDirectory: "",
      sevenZip: browserComponent("7zip", "7-Zip", "26.02"),
      hashcat: browserComponent("hashcat", "Hashcat", "7.1.2"),
      john: browserComponent("john", "John the Ripper", "1.9.0-jumbo-1"),
      perl: browserComponent("perl", "Strawberry Perl", "5.42.2.1"),
      has7z2john: false,
      hasRar2john: false,
      hasZip2john: false,
      johnCpuReady: false,
      message: "浏览器预览不包含 Windows x64 完整引擎资源。",
    }
  }
  return invoke<FullEngineBundleStatus>("tool_full_bundle_status")
}

export async function installFullEngineBundle(): Promise<FullEngineBundleInstallResult> {
  if (!isDesktopRuntime()) {
    return {
      success: false,
      message: "浏览器预览无法部署完整引擎包。",
      sevenZipPath: "",
      hashcatPath: "",
      johnToolsDirectory: "",
      perlPath: "",
    }
  }
  return invoke<FullEngineBundleInstallResult>("tool_full_bundle_install")
}

export async function getSettings(): Promise<AppSettings> {
  if (!isDesktopRuntime()) {
    return {
      version: 0,
      engine: { hashcatPath: "", toolsDirectory: "" },
      logging: {
        level: "info",
        maxDiskMib: DEFAULT_LOG_MAX_DISK_MIB,
      },
      recovery: {
        computeMode: "gpuPreferred",
        scanMaxFilesPerDirectory: DEFAULT_SCAN_MAX_FILES_PER_DIRECTORY,
      },
    }
  }
  return invoke<AppSettings>("settings_get")
}

export async function setSettings(settings: AppSettings): Promise<AppSettings> {
  if (!isDesktopRuntime()) {
    return settings
  }
  return invoke<AppSettings>("settings_set", { settings })
}

export async function getDatabaseInfo(): Promise<DatabaseInfo> {
  if (!isDesktopRuntime()) {
    const candidateCount = await countDictionary()
    return {
      path: "（浏览器预览：内存字典，不落盘）",
      exists: false,
      candidateCount,
      settingsPath: "（浏览器预览）",
      rootPath: "（浏览器预览）",
      logsPath: "（浏览器预览：内存日志）",
      toolsPath: "（浏览器预览）",
    }
  }
  return invoke<DatabaseInfo>("database_info")
}

export async function getHashcatStatus(): Promise<HashcatStatus> {
  if (!isDesktopRuntime()) {
    return {
      version: "7.1.2",
      downloadUrl:
        "https://github.com/hashcat/hashcat/releases/download/v7.1.2/hashcat-7.1.2.7z",
      githubRepo: "https://github.com/hashcat/hashcat",
      installed: false,
      executablePath: "",
      installDirectory: "",
      toolsDirectory: "",
      defaultToolsDirectory: "",
      configuredToolsDirectory: "",
      configuredPath: "",
      configuredExists: false,
    }
  }
  return invoke<HashcatStatus>("tool_hashcat_status")
}

/**
 * Download pinned hashcat release into the configured tools directory.
 * Desktop only; browser preview returns a soft failure.
 */
export async function downloadHashcat(): Promise<HashcatInstallResult> {
  if (!isDesktopRuntime()) {
    return {
      success: false,
      message: "浏览器预览不支持下载工具，请使用桌面端。",
      executablePath: "",
    }
  }
  return invoke<HashcatInstallResult>("tool_hashcat_download")
}

/** Set public tools directory (empty string = restore app default). */
export async function setToolsDirectory(path: string): Promise<AppSettings> {
  if (!isDesktopRuntime()) {
    return {
      version: 0,
      engine: { hashcatPath: "", toolsDirectory: path },
    }
  }
  return invoke<AppSettings>("tool_set_tools_directory", { path })
}

export async function getJohnPerlStatus(): Promise<JohnPerlStatus> {
  if (!isDesktopRuntime()) {
    return {
      johnToolsDirectory: "",
      perlPath: "",
      directoryExists: false,
      has7z2johnExe: false,
      has7z2johnPl: false,
      hasRar2johnExe: false,
      hasZip2johnExe: false,
      hasJohnExe: false,
      perlExists: false,
      sevenZipConverterReady: false,
      rarConverterReady: false,
      zipConverterReady: false,
      johnCpuReady: false,
      ready: false,
      message: "浏览器预览：请在桌面端配置 John / Perl。",
    }
  }
  return invoke<JohnPerlStatus>("tool_john_perl_status")
}

export async function setJohnPerl(
  johnToolsDirectory: string,
  perlPath: string
): Promise<JohnPerlStatus> {
  if (!isDesktopRuntime()) {
    return getJohnPerlStatus()
  }
  return invoke<JohnPerlStatus>("tool_set_john_perl", {
    johnToolsDirectory,
    perlPath,
  })
}

export async function openPath(path: string): Promise<void> {
  if (!isDesktopRuntime()) {
    throw new Error("浏览器预览无法打开本机路径。")
  }
  await invoke("open_path", { path })
}
