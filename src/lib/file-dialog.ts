import { open, type OpenDialogOptions } from "@tauri-apps/plugin-dialog"

type DialogLocation =
  | "extract-source"
  | "extract-output"
  | "compression-files"
  | "compression-folder"
  | "compression-output"
  | "database-backup"

const lastDirectories = new Map<DialogLocation, string>()

export async function openRememberingDirectory(
  location: DialogLocation,
  options: OpenDialogOptions
): Promise<string | string[] | null> {
  const storageKey = `arc-recall:dialog-directory:${location}`
  let defaultPath = lastDirectories.get(location)
  try {
    defaultPath ??= window.localStorage.getItem(storageKey) || undefined
  } catch {
    // Storage restrictions must not prevent opening a native dialog.
  }

  const selected = await open({ ...options, defaultPath })
  const path = Array.isArray(selected) ? selected[0] : selected
  if (path) {
    // Keep the separator so drive roots (C:\) and POSIX roots remain absolute.
    const directory = options.directory
      ? path
      : path.slice(
          0,
          Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1
        )
    if (directory) {
      lastDirectories.set(location, directory)
      try {
        window.localStorage.setItem(storageKey, directory)
      } catch {
        // Retain the location for this session when persistence is unavailable.
      }
    }
  }
  return selected
}
