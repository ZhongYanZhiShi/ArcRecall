import type { RecoveryTaskStatus } from "./recovery"
import type { createRecoveryQueue } from "./recovery-queue"

/**
 * The desktop process keeps the latest recovery task for the lifetime of the
 * application. Both running and completed tasks must be reattached after the
 * user navigates away from the recovery page, otherwise a task that completes
 * while the page is unmounted loses its visible result.
 */
export function recoveryTaskAttachmentId(
  task: { taskId: string } | null
): string | null {
  return task?.taskId ?? null
}

/** Reconnect a paused view without replaying a queue result it already saw. */
export function createRecoveryTaskSubscription(
  queue: Pick<
    ReturnType<typeof createRecoveryQueue>,
    "getSnapshot" | "subscribe"
  >,
  onTask: (task: RecoveryTaskStatus) => void
) {
  let previous: RecoveryTaskStatus | null = null
  const synchronize = () => {
    const current = queue.getSnapshot()
    const latest =
      current.items.find((item) => item.id === current.currentItemId)?.task ??
      current.items.findLast((item) => item.task)?.task
    if (latest && latest !== previous) {
      previous = latest
      onTask(latest)
    }
  }
  return () => {
    const unsubscribe = queue.subscribe(synchronize)
    synchronize()
    return unsubscribe
  }
}
