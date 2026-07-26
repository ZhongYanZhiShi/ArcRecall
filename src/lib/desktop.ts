import { invoke } from "@tauri-apps/api/core"

export interface HealthResponse {
  service: string
  status: string
}

export function getDesktopHealth(): Promise<HealthResponse> {
  return invoke<HealthResponse>("health")
}
