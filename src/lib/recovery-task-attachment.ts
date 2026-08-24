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
