import { invoke } from "@tauri-apps/api/core"

const notified = new Set<string>()
export function notifyTaskCompletion(task: {
  taskId: string
  running: boolean
  success: boolean
  cancelled: boolean
}) {
  if (task.running || task.cancelled || notified.has(task.taskId)) return
  notified.add(task.taskId)
  void invoke("notify_task_finished", { success: task.success }).catch(() => {
    // Notification availability must never affect task execution.
  })
}
