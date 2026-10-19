"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

import type { Layer } from "./mock-data"

const GAP = 84 // 相邻两层在 Z 轴上的距离
const LIFT = 64 // 已打开的层额外抬起的高度

/**
 * 等距层叠：把一个压缩包画成一摞板。最外层在最上面，越往里越深。
 * 已打开的层向上抬起并变淡，正在处理的层表面有进度，尚未打开的层
 * 只画虚线轮廓。宽屏时每层的说明对齐到对应的板并用引线相连；
 * 窄屏时说明按顺序排在图下方。读屏用户读到的是同一份按层排列的列表。
 */
export function Strata({
  layers,
  renderLabel,
}: {
  layers: Layer[]
  renderLabel: (layer: Layer) => React.ReactNode
}) {
  const sceneRef = React.useRef<HTMLDivElement>(null)
  const slabRefs = React.useRef<(HTMLDivElement | null)[]>([])
  const labelRefs = React.useRef<(HTMLLIElement | null)[]>([])
  const [layout, setLayout] = React.useState<{
    tops: number[]
    lines: string[]
    height: number
  } | null>(null)

  const count = layers.length
  const firstOpen = layers.findIndex((layer) => layer.state !== "done")
  const peeled = firstOpen === -1 ? count : firstOpen
  const stackHeight = 230 + (count - 1) * GAP * 0.85 + (peeled > 0 ? LIFT : 0)

  React.useLayoutEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    const measure = () => {
      const wide = window.matchMedia("(min-width: 768px)").matches
      if (!wide) {
        setLayout(null)
        return
      }
      const origin = scene.getBoundingClientRect()
      const tops: number[] = []
      const lines: string[] = []
      let floor = 0
      layers.forEach((_, i) => {
        const slab = slabRefs.current[i]?.getBoundingClientRect()
        const label = labelRefs.current[i]
        if (!slab || !label) return
        const center = slab.top + slab.height / 2 - origin.top
        // 说明尽量与板齐平，放不下时依次往下让
        const top = Math.max(center - 12, floor)
        floor = top + label.offsetHeight + 20
        tops.push(top)
        const x1 = slab.right - origin.left + 6
        const x2 = label.getBoundingClientRect().left - origin.left - 12
        lines.push(`${x1},${center} ${x1 + 18},${top + 12} ${x2},${top + 12}`)
      })
      setLayout({ tops, lines, height: Math.max(floor, stackHeight) })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(scene)
    return () => observer.disconnect()
  }, [layers, stackHeight])

  return (
    <div
      ref={sceneRef}
      className="relative flex flex-col gap-6 md:flex-row md:gap-0"
      style={layout ? { minHeight: layout.height } : undefined}
    >
      <div
        aria-hidden="true"
        className="relative w-full max-w-[20rem] shrink-0 self-center md:self-start"
        style={{ height: stackHeight }}
      >
        <div
          className="rd-iso"
          style={
            {
              "--iso-top": `${stackHeight - 118}px`,
              "--iso-size": "70%",
            } as React.CSSProperties
          }
        >
          {layers.map((layer, i) => {
            const base = (count - 1 - i) * GAP
            const lift = i < peeled ? LIFT : 0
            return (
              <div
                key={layer.id}
                ref={(el) => {
                  slabRefs.current[i] = el
                }}
                className={cn(
                  "rd-slab",
                  `rd-slab-d${Math.min(layer.depth, 3)}`,
                  layer.state === "done" && "rd-slab-peeled",
                  (layer.state === "unknown" || layer.state === "waiting") &&
                    "rd-slab-unknown",
                  layer.state === "needsPassword" && "rd-slab-warn",
                  layer.state === "blocked" && "rd-slab-danger",
                  layer.state === "running" && "rd-slab-active"
                )}
                style={
                  { "--z": `${base + lift}px`, "--i": i } as React.CSSProperties
                }
              >
                <span className="rd-slab-side rd-slab-side-a" />
                <span className="rd-slab-side rd-slab-side-b" />
                {layer.state === "running" ? (
                  <span
                    className="rd-slab-fill rd-live"
                    style={{
                      width: `${Math.round((layer.progress ?? 0) * 100)}%`,
                    }}
                  />
                ) : null}
              </div>
            )
          })}
        </div>
      </div>

      {layout ? (
        <svg
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
        >
          {layout.lines.map((points, i) => (
            <polyline
              key={layers[i]?.id ?? i}
              points={points}
              fill="none"
              stroke="currentColor"
              strokeWidth="1"
              className="text-foreground/30"
            />
          ))}
        </svg>
      ) : null}

      <ol
        aria-label="归档层级，由外到内"
        className="relative flex min-w-0 flex-1 flex-col gap-6 md:block md:pl-16"
      >
        {layers.map((layer, i) => (
          <li
            key={layer.id}
            ref={(el) => {
              labelRefs.current[i] = el
            }}
            className="min-w-0 md:absolute md:right-0 md:left-16"
            style={layout ? { top: layout.tops[i] } : undefined}
          >
            {renderLabel(layer)}
          </li>
        ))}
      </ol>
    </div>
  )
}
