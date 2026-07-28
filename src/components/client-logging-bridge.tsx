"use client"

import * as React from "react"

import { writeClientLog } from "@/lib/logging"

export function ClientLoggingBridge() {
  React.useEffect(() => {
    const writeSafely = (
      event: string,
      message: string,
      context: Record<string, string>
    ) => {
      void writeClientLog({
        level: "error",
        event,
        message,
        context,
      }).catch(() => {
        // Logging must never create another unhandled rejection.
      })
    }

    const handleError = (event: ErrorEvent) => {
      writeSafely("ui.unhandled_error", "前端发生未处理异常。", {
        error_name: event.error?.name ?? "Error",
      })
    }
    const handleRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason
      writeSafely("ui.unhandled_rejection", "前端异步任务发生未处理异常。", {
        error_name: reason instanceof Error ? reason.name : typeof reason,
      })
    }

    window.addEventListener("error", handleError)
    window.addEventListener("unhandledrejection", handleRejection)
    void writeClientLog({
      level: "debug",
      event: "ui.ready",
      message: "前端日志桥接已就绪。",
    }).catch(() => {
      // Desktop IPC may not be ready during development preview.
    })

    return () => {
      window.removeEventListener("error", handleError)
      window.removeEventListener("unhandledrejection", handleRejection)
    }
  }, [])

  return null
}
