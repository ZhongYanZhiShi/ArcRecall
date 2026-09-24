import type { RecoveryTaskStatus } from "./recovery"
import type { createRecoveryQueue } from "./recovery-queue"

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
