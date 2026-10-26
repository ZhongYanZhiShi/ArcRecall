import { invoke } from "@tauri-apps/api/core"

export type BackupPolicy = {
  enabled: boolean
  directory: string | null
  intervalHours: number
  keepCount: number
}
export type BackupOverview = {
  status: {
    policy: BackupPolicy
    lastAttemptMs: number | null
    lastSuccessMs: number | null
    lastError: string | null
  }
  entries: {
    path: string
    createdAtMs: number
    byteCount: number
    automatic: boolean
    exists: boolean
  }[]
}
export type RestorePreview = {
  unified: boolean
  presetCount: number
  compressionPresetCount?: number | null
  taskRecordCount: number
  includesSettings: boolean
  token: string
  candidateCount: number
  historyCount: number
  passwordCount: number
  unreadablePasswordCount: number
}

export const getBackupOverview = (): Promise<BackupOverview> =>
  invoke("backup_management_get")
export const saveBackupPolicy = (
  policy: BackupPolicy
): Promise<BackupOverview> => invoke("backup_policy_save", { policy })
export const runBackupNow = (): Promise<void> => invoke("backup_run_now")
export const previewDatabaseRestore = (path: string): Promise<RestorePreview> =>
  invoke("database_restore_preview", { path })
export const discardDatabaseRestore = (token: string): Promise<void> =>
  invoke("database_restore_discard", { token })
export const applyDatabaseRestore = (
  token: string
): Promise<{ safetyBackupPath: string }> =>
  invoke("database_restore_apply", { token })
