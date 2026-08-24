import { invoke } from "@tauri-apps/api/core"

import { isDesktopRuntime } from "@/lib/dictionary"

const SENSITIVE_CLIPBOARD_TTL_MS = 30_000

export async function copySensitiveText(value: string): Promise<void> {
  await navigator.clipboard.writeText(value)
  window.setTimeout(() => {
    if (isDesktopRuntime()) {
      void invoke("clipboard_clear_if_matches", { expected: value }).catch(
        () => undefined
      )
      return
    }
    void navigator.clipboard
      .readText()
      .then((current) => {
        if (current === value) {
          return navigator.clipboard.writeText("")
        }
      })
      .catch(() => undefined)
  }, SENSITIVE_CLIPBOARD_TTL_MS)
}
