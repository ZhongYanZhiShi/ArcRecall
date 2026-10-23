import { invoke } from "@tauri-apps/api/core"

export type IntegrityState =
  | "waiting"
  | "checking"
  | "passed"
  | "failed"
  | "cancelled"
export type BatchCheckStatus = {
  id: string
  running: boolean
  cancelled: boolean
  items: {
    path: string
    sourcePaths?: string[]
    state: IntegrityState
    message: string
    elapsedMs: number
    checkedAtMs: number | null
  }[]
}

export const runBatchCheck = (
  id: string,
  paths: string[],
  password: string,
  retryFailed = false
): Promise<BatchCheckStatus> =>
  invoke("archive_batch_check_run", {
    id,
    paths,
    password: password || null,
    retryFailed,
  })

export const getBatchCheck = (id: string): Promise<BatchCheckStatus | null> =>
  invoke("archive_batch_check_status", { id })

export const exportBatchCheck = (
  id: string,
  format: "json" | "csv",
  includePaths: boolean
): Promise<string> =>
  invoke("archive_batch_check_export", { id, format, includePaths })
