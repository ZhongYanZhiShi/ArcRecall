"use client"

import { useEffect, useRef, useState, type CSSProperties } from "react"
import { isTauri } from "@tauri-apps/api/core"
import { getCurrentWindow } from "@tauri-apps/api/window"
import {
  BYTE_STREAM_RATES,
  type ByteStreamActivity,
} from "@/lib/byte-stream-motion"

// Fixed seeds and negative delays keep hydration stable and avoid a synchronized start.
const STREAMS = Array.from({ length: 16 }, (_, column) => {
  let seed = 29 + column * 71
  const bytes = Array.from({ length: 82 }, () => {
    seed = (seed * 9301 + 49297) % 233280
    return Math.floor((seed / 233280) * 256)
      .toString(16)
      .toUpperCase()
      .padStart(2, "0")
  })
  const duration = 32 + (column % 7) * 3
  return { bytes, duration, delay: -duration * ((column * 0.37 + 0.23) % 1) }
})

function ByteColumns({
  count,
  offset = 0,
}: {
  count: number
  offset?: number
}) {
  return STREAMS.slice(offset, offset + count).map((stream, index) => (
    <div
      className="byte-stream-column"
      key={index}
      style={
        {
          right: `${index * 30}px`,
          opacity: 0.35 + ((index * 7) % 11) / 20,
          animationDuration: `${stream.duration}s`,
          animationDelay: `${stream.delay}s`,
        } as CSSProperties
      }
    >
      {[...stream.bytes, ...stream.bytes].map((byte, position) => (
        <span
          key={position}
          style={{
            opacity:
              0.5 +
              0.5 *
                ((position % stream.bytes.length) / (stream.bytes.length - 1)),
          }}
        >
          {byte}
        </span>
      ))}
    </div>
  ))
}

export function ByteStreamBackground({
  activity = "idle",
}: {
  activity?: ByteStreamActivity
}) {
  const root = useRef<HTMLDivElement>(null)
  const [foreground, setForeground] = useState(false)

  useEffect(() => {
    let disposed = false
    let minimized = false
    let revision = 0
    const subscriptions: (() => void)[] = []
    const publish = () => {
      if (!disposed)
        setForeground(!minimized && document.visibilityState === "visible")
    }
    document.addEventListener("visibilitychange", publish)
    publish()

    if (isTauri()) {
      const nativeWindow = getCurrentWindow()
      const refresh = () => {
        const request = ++revision
        void nativeWindow
          .isMinimized()
          .then((value) => {
            if (!disposed && request === revision) {
              minimized = value
              publish()
            }
          })
          .catch(() => {
            /* Visibility events remain the fallback. */
          })
      }
      const subscribe = (pending: Promise<() => void>) => {
        void pending
          .then((stop) => {
            if (disposed) stop()
            else subscriptions.push(stop)
          })
          .catch(() => {
            /* Visibility events remain the fallback. */
          })
      }
      subscribe(nativeWindow.onResized(refresh))
      // Focus changes trigger a fresh minimization check, never a pause themselves.
      subscribe(nativeWindow.onFocusChanged(refresh))
      refresh()
    }
    return () => {
      disposed = true
      subscriptions.forEach((stop) => stop())
      document.removeEventListener("visibilitychange", publish)
    }
  }, [])

  useEffect(() => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)")
    const sync = () => {
      for (const animation of root.current?.getAnimations({ subtree: true }) ??
        []) {
        // Changing playbackRate preserves the current position; changing CSS duration would jump.
        animation.updatePlaybackRate(BYTE_STREAM_RATES[activity])
        if (foreground && !reducedMotion.matches) animation.play()
        else animation.pause()
      }
    }
    sync()
    reducedMotion.addEventListener("change", sync)
    return () => reducedMotion.removeEventListener("change", sync)
  }, [activity, foreground])

  return (
    <div
      ref={root}
      className="byte-stream"
      aria-hidden="true"
      data-activity={activity}
      data-paused={!foreground}
    >
      <div className="byte-stream-field byte-stream-right">
        <ByteColumns count={16} />
      </div>
    </div>
  )
}
