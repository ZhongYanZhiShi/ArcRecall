export type ByteStreamActivity = "idle" | "running" | "waiting"

export function recoveryStreamActivity(
  task: { running: boolean; phase: string } | null,
  queueRunning = false
): ByteStreamActivity {
  if (queueRunning || task?.running) return "running"
  return task?.phase === "exhausted" ? "waiting" : "idle"
}

export const BYTE_STREAM_RATES: Record<ByteStreamActivity, number> = {
  idle: 0.7,
  running: 1.15,
  waiting: 0.35,
}
