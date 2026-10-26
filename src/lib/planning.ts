import { invoke } from "@tauri-apps/api/core"
import { isDesktopRuntime } from "./runtime"
import { openRememberingDirectory } from "./file-dialog"

export type ProcessingOptions = {
  outputDirectory: string | null
  recursive: boolean
  computeMode: "cpuOnly" | "gpuPreferred"
  dictionaryGroup: string | null
  openWhenDone: boolean
}
export type ProcessingPreset = ProcessingOptions & { name: string }
export type FolderScanResult = {
  entries: {
    path: string
    volumePaths: string[]
    format: string
    fileSize: number
    volumeCount: number
  }[]
  warnings: { path: string; message: string }[]
  visitedEntries: number
  ignoredFiles: number
  skippedLinks: number
  truncated: boolean
  cancelled: boolean
}
export const listPresets = (): Promise<ProcessingPreset[]> =>
  isDesktopRuntime() ? invoke("processing_presets_list") : Promise.resolve([])
export const applyPreset = (name: string): Promise<ProcessingPreset> =>
  invoke("processing_preset_apply", { name })
export const savePreset = (
  preset: ProcessingPreset,
  overwrite: boolean
): Promise<void> => invoke("processing_preset_save", { preset, overwrite })
export const deletePreset = (name: string): Promise<void> =>
  invoke("processing_preset_delete", { name })
export const scanFolder = (
  id: string,
  path: string,
  includeSubfolders: boolean
): Promise<FolderScanResult> =>
  invoke("archive_folder_scan", { id, path, includeSubfolders })
export async function pickScanFolder(): Promise<string | null> {
  const value = await openRememberingDirectory("extract-source", {
    directory: true,
    multiple: false,
    title: "选择要扫描的文件夹",
  })
  return typeof value === "string" ? value : null
}
