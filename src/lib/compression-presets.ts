import { invoke } from "@tauri-apps/api/core"
import type { CompressionDraft } from "./compression-draft"
import { isDesktopRuntime } from "./dictionary"

export type CompressionOptions = {
  format: CompressionDraft["format"]
  level: CompressionDraft["level"]
  encryptFileNames: boolean
  outputDirectory: string | null
}
export type CompressionPreset = {
  name: string
  options: CompressionOptions
  nameTemplate: string
  openWhenDone: boolean
}
export type CompressionRecordOptions = {
  options: CompressionOptions
  baseName: string
  passwordRequired: boolean
}
export type CompressionRetryDraft = {
  record: import("./workflows").TaskRecord
  missingSources: string[]
  outputMissing: boolean
}
export function prepareCompressionRetry(
  id: string
): Promise<CompressionRetryDraft> {
  return invoke("compression_retry_prepare", { id })
}
export function listCompressionPresets(): Promise<CompressionPreset[]> {
  return isDesktopRuntime()
    ? invoke("compression_presets_list")
    : Promise.resolve([])
}
export function saveCompressionPreset(
  preset: CompressionPreset,
  overwrite: boolean
): Promise<void> {
  return invoke("compression_preset_save", { preset, overwrite })
}
export function deleteCompressionPreset(name: string): Promise<void> {
  return invoke("compression_preset_delete", { name })
}
export function applyCompressionPreset(
  name: string
): Promise<CompressionPreset> {
  return invoke("compression_preset_apply", { name })
}
export function draftWithCompressionPreset(
  draft: CompressionDraft,
  preset: CompressionPreset,
  date = new Date()
): CompressionDraft {
  const day = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-")
  const sourceName = draft.sources[0]
    ?.replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop()
  const name = draft.baseName.trim() || sourceName || "归档"
  return {
    ...draft,
    ...preset.options,
    outputMode: preset.options.outputDirectory ? "custom" : "sibling",
    baseName: preset.nameTemplate.replace(
      /\{(name|date)\}/g,
      (_, field: string) => (field === "name" ? name : day)
    ),
    openWhenDone: preset.openWhenDone,
  }
}
