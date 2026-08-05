export function forgetCompletedArchiveBaseName<
  Draft extends { baseName: string },
>(draft: Draft): Draft {
  return { ...draft, baseName: "" }
}

export function shouldForgetArchiveBaseName(
  task: {
    taskId: string
    running: boolean
    completed: boolean
    success: boolean
  },
  awaitingCompletion: Set<string>
): boolean {
  if (task.running) {
    awaitingCompletion.add(task.taskId)
    return false
  }
  if (!task.completed) {
    return false
  }
  return awaitingCompletion.delete(task.taskId) && task.success
}
