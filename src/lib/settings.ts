import { invoke } from "@tauri-apps/api/core"

import { countDictionary, isDesktopRuntime } from "@/lib/dictionary"

export type AppSettings = {
  version?: number
}

export type DatabaseInfo = {
  path: string
  exists: boolean
  candidateCount: number
  settingsPath: string
  rootPath: string
}

export async function getSettings(): Promise<AppSettings> {
  if (!isDesktopRuntime()) {
    return { version: 0 }
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
    }
  }
  return invoke<DatabaseInfo>("database_info")
}
