import type { RecoveryTaskStatus } from "./recovery"

/** Project only documented fields; messages, events and passwords may contain secrets. */
export function buildRecoveryReport(
  task: RecoveryTaskStatus,
  includePaths = false
) {
  return {
    version: 1,
    summary: {
      status: task.running
        ? "running"
        : task.cancelled
          ? "cancelled"
          : task.success
            ? "success"
            : "failed",
      archiveFormat: task.archiveFormat,
      computeMode: task.computeMode,
      recursive: task.recursiveEnabled,
      rootExtractionCompleted: task.rootExtractionCompleted,
      elapsedMs: task.elapsedMs,
      candidateCount: task.candidateCount,
      attemptedCount: task.attemptedCount,
      completedArchives: task.completedArchivePaths?.length ?? 0,
      skippedArchives: task.skippedArchivePaths?.length ?? 0,
      pendingArchives: task.pendingArchivePaths?.length ?? 0,
      scannedFiles: task.scannedFileCount,
      unscannedDirectories: task.skippedScanDirectories?.length ?? 0,
      scanInterrupted: Boolean(task.scanInterrupted),
      depthLimitReached: task.depthLimitReached,
      countLimitReached: task.countLimitReached,
      budgetLimitReached: Boolean(task.budgetLimitReached),
    },
    timings: (task.timings ?? []).map(({ operation, durationMs }) => ({
      operation,
      durationMs,
    })),
    ...(includePaths
      ? {
          paths: {
            archive: task.archivePath,
            output: task.outputDirectory,
            completed: task.completedArchivePaths ?? [],
            skipped: task.skippedArchivePaths ?? [],
            pending: task.pendingArchivePaths ?? [],
            unscanned: task.skippedScanDirectories ?? [],
          },
        }
      : {}),
  }
}
