"use client"

import * as React from "react"

type DesktopTaskStatus = {
  taskId: string
  running: boolean
}

type UseDesktopTaskOptions<Task extends DesktopTaskStatus> = {
  enabled: boolean
  getStatus: (taskId?: string) => Promise<Task | null>
  initialPollDelayMs: number
  pollIntervalMs: number
  retryIntervalMs?: number
  onError: (error: unknown) => void
  onReattach?: (task: Task) => void
  onSettled?: (task: Task) => void
}

/**
 * Owns the shared lifecycle for a Tauri background task: reattach once on
 * mount, poll only while running, retry transient failures, and cancel every
 * scheduled update when the view unmounts or switches tasks.
 */
export function useDesktopTask<Task extends DesktopTaskStatus>({
  enabled,
  getStatus,
  initialPollDelayMs,
  pollIntervalMs,
  retryIntervalMs = 1_500,
  onError,
  onReattach,
  onSettled,
}: UseDesktopTaskOptions<Task>) {
  const [task, setTaskState] = React.useState<Task | null>(null)
  const taskRef = React.useRef(task)
  const runningRef = React.useRef(Boolean(task?.running))
  const taskVersion = React.useRef(0)
  const getStatusRef = React.useRef(getStatus)
  const onErrorRef = React.useRef(onError)
  const onReattachRef = React.useRef(onReattach)
  const onSettledRef = React.useRef(onSettled)

  const setTask = React.useCallback(
    (update: React.SetStateAction<Task | null>) => {
      const next =
        typeof update === "function" ? update(taskRef.current) : update
      taskVersion.current += 1
      taskRef.current = next
      runningRef.current = Boolean(next?.running)
      setTaskState(next)
    },
    []
  )

  React.useEffect(() => {
    getStatusRef.current = getStatus
    onErrorRef.current = onError
    onReattachRef.current = onReattach
    onSettledRef.current = onSettled
  }, [getStatus, onError, onReattach, onSettled])

  React.useEffect(() => {
    if (!enabled) {
      return
    }
    let disposed = false
    const version = taskVersion.current
    void getStatusRef
      .current()
      .then((latest) => {
        if (
          disposed ||
          !latest ||
          taskRef.current ||
          taskVersion.current !== version
        ) {
          return
        }
        setTask(latest)
        onReattachRef.current?.(latest)
      })
      .catch((error) => {
        if (!disposed && taskVersion.current === version) {
          onErrorRef.current(error)
        }
      })
    return () => {
      disposed = true
    }
  }, [enabled, setTask])

  React.useEffect(() => {
    if (!enabled || !task?.running) {
      return
    }
    let disposed = false
    let timeout: ReturnType<typeof setTimeout> | undefined

    const schedule = (delay: number) => {
      timeout = setTimeout(poll, delay)
    }
    const poll = async () => {
      try {
        const latest = await getStatusRef.current(task.taskId)
        if (disposed || !latest || taskRef.current?.taskId !== task.taskId) {
          return
        }
        setTask(latest)
        if (latest.running) {
          schedule(pollIntervalMs)
        } else {
          onSettledRef.current?.(latest)
        }
      } catch (error) {
        if (!disposed && taskRef.current?.taskId === task.taskId) {
          onErrorRef.current(error)
          schedule(retryIntervalMs)
        }
      }
    }

    schedule(initialPollDelayMs)
    return () => {
      disposed = true
      if (timeout) {
        clearTimeout(timeout)
      }
    }
  }, [
    enabled,
    initialPollDelayMs,
    pollIntervalMs,
    retryIntervalMs,
    setTask,
    task?.running,
    task?.taskId,
  ])

  return {
    task,
    setTask,
    running: Boolean(task?.running),
    runningRef,
  }
}
