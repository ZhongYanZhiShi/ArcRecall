// Window APIs require Tauri's native marker; an IPC adapter alone is insufficient.
export { isTauri } from "@tauri-apps/api/core"

/** Native IPC, including legacy bridges and browser preview adapters. */
export function isDesktopRuntime(): boolean {
  if (typeof window === "undefined") {
    return false
  }
  return (
    "__TAURI_INTERNALS__" in window ||
    "__TAURI__" in window ||
    navigator.userAgent.includes("Tauri")
  )
}
