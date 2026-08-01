"use client"

import { gsap } from "gsap"
import type { LucideIcon } from "lucide-react"
import * as React from "react"

import { cn } from "@/lib/utils"

export type PillNavItem<T extends string> = {
  id: T
  label: string
  icon: LucideIcon
  dividerBefore?: boolean
}

type PillNavProps<T extends string> = {
  items: PillNavItem<T>[]
  activeId: T
  onSelect: (id: T) => void
  className?: string
  ease?: string
  initialLoadAnimation?: boolean
}

/**
 * Adapted from React Bits' Pill Nav for ArcRecall's state-driven dock.
 * Source: https://www.reactbits.dev/components/pill-nav
 */
export function PillNav<T extends string>({
  items,
  activeId,
  onSelect,
  className,
  ease = "power3.out",
  initialLoadAnimation = true,
}: PillNavProps<T>) {
  const navRef = React.useRef<HTMLElement | null>(null)
  const circleRefs = React.useRef<Array<HTMLSpanElement | null>>([])
  const timelineRefs = React.useRef<Array<gsap.core.Timeline | null>>([])
  const activeTweenRefs = React.useRef<Array<gsap.core.Tween | null>>([])

  React.useEffect(() => {
    let disposed = false
    const timelines = timelineRefs.current
    const activeTweens = activeTweenRefs.current
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)")

    const layout = () => {
      if (disposed) {
        return
      }

      circleRefs.current.forEach((circle, index) => {
        if (!circle?.parentElement) {
          return
        }

        const pill = circle.parentElement
        const { width, height } = pill.getBoundingClientRect()
        const radius = ((width * width) / 4 + height * height) / (2 * height)
        const diameter = Math.ceil(2 * radius) + 2
        const delta =
          Math.ceil(
            radius -
              Math.sqrt(Math.max(0, radius * radius - (width * width) / 4))
          ) + 1
        const originY = diameter - delta
        const label = pill.querySelector<HTMLElement>(".pill-nav-label")
        const hoverLabel = pill.querySelector<HTMLElement>(
          ".pill-nav-label-hover"
        )

        circle.style.width = `${diameter}px`
        circle.style.height = `${diameter}px`
        circle.style.bottom = `-${delta}px`

        timelines[index]?.kill()
        activeTweens[index]?.kill()

        gsap.set(circle, {
          xPercent: -50,
          scale: 0,
          transformOrigin: `50% ${originY}px`,
        })
        if (label) {
          gsap.set(label, { y: 0 })
        }
        if (hoverLabel) {
          gsap.set(hoverLabel, { y: height + 12, opacity: 0 })
        }

        if (reducedMotion.matches) {
          timelines[index] = null
          return
        }

        const timeline = gsap.timeline({ paused: true })
        timeline.to(
          circle,
          {
            scale: 1.2,
            xPercent: -50,
            duration: 2,
            ease,
            overwrite: "auto",
          },
          0
        )
        if (label) {
          timeline.to(
            label,
            {
              y: -(height + 8),
              duration: 2,
              ease,
              overwrite: "auto",
            },
            0
          )
        }
        if (hoverLabel) {
          timeline.to(
            hoverLabel,
            {
              y: 0,
              opacity: 1,
              duration: 2,
              ease,
              overwrite: "auto",
            },
            0
          )
        }

        timelines[index] = timeline
      })
    }

    layout()
    window.addEventListener("resize", layout)
    reducedMotion.addEventListener("change", layout)
    void document.fonts?.ready.then(layout).catch(() => undefined)

    const revealTween =
      initialLoadAnimation && navRef.current && !reducedMotion.matches
        ? gsap.fromTo(
            navRef.current,
            {
              autoAlpha: 0,
              scale: 0.92,
              y: 14,
              transformOrigin: "center bottom",
            },
            {
              autoAlpha: 1,
              scale: 1,
              y: 0,
              duration: 0.55,
              ease,
            }
          )
        : null

    return () => {
      disposed = true
      window.removeEventListener("resize", layout)
      reducedMotion.removeEventListener("change", layout)
      revealTween?.kill()
      timelines.forEach((timeline) => timeline?.kill())
      activeTweens.forEach((tween) => tween?.kill())
    }
  }, [ease, initialLoadAnimation, items])

  const animateTo = (index: number, end: boolean) => {
    const timeline = timelineRefs.current[index]
    if (!timeline) {
      return
    }

    activeTweenRefs.current[index]?.kill()
    activeTweenRefs.current[index] = timeline.tweenTo(
      end ? timeline.duration() : 0,
      {
        duration: end ? 0.3 : 0.2,
        ease,
        overwrite: "auto",
      }
    )
  }

  return (
    <nav
      ref={navRef}
      aria-label="功能切换"
      className={cn(
        "pointer-events-auto relative flex items-stretch gap-0.5 rounded-full border border-border/80 bg-card/95 p-1",
        "shadow-lg shadow-foreground/8 dark:shadow-black/40",
        className
      )}
    >
      <ul className="flex items-stretch gap-0.5">
        {items.map((item, index) => {
          const Icon = item.icon
          const active = item.id === activeId

          return (
            <React.Fragment key={item.id}>
              {item.dividerBefore ? (
                <li
                  aria-hidden="true"
                  role="presentation"
                  className="mx-0.5 flex items-center px-0.5"
                >
                  <span className="h-6 w-px bg-border" />
                </li>
              ) : null}

              <li className="flex h-12 min-w-12">
                <button
                  type="button"
                  aria-label={item.label}
                  aria-current={active ? "page" : undefined}
                  data-active={active ? "true" : undefined}
                  onClick={() => onSelect(item.id)}
                  onMouseEnter={() => animateTo(index, true)}
                  onMouseLeave={() => animateTo(index, false)}
                  onFocus={() => animateTo(index, true)}
                  onBlur={() => animateTo(index, false)}
                  className={cn(
                    "group/pill relative inline-flex h-full min-w-12 items-center justify-center overflow-hidden rounded-full px-2",
                    "bg-background/70 text-xs leading-none font-semibold text-foreground data-[active=true]:bg-accent data-[active=true]:text-accent-foreground",
                    "transition-[box-shadow,transform] duration-200 outline-none active:scale-[0.97]",
                    "focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card"
                  )}
                >
                  <span
                    ref={(element) => {
                      circleRefs.current[index] = element
                    }}
                    aria-hidden="true"
                    className="pointer-events-none absolute bottom-0 left-1/2 z-[1] block rounded-full bg-primary will-change-transform"
                  />

                  <span className="relative z-[2] inline-flex h-full items-center justify-center">
                    <span className="pill-nav-label relative z-[2] inline-flex flex-col items-center gap-0.5 will-change-transform">
                      <Icon
                        aria-hidden="true"
                        className="size-4"
                        strokeWidth={active ? 2.35 : 1.9}
                      />
                      <span>{item.label}</span>
                    </span>
                    <span
                      aria-hidden="true"
                      className="pill-nav-label-hover absolute inset-0 z-[3] inline-flex flex-col items-center justify-center gap-0.5 text-primary-foreground will-change-[transform,opacity]"
                    >
                      <Icon className="size-4" strokeWidth={2.2} />
                      <span>{item.label}</span>
                    </span>
                  </span>

                  {active ? (
                    <span
                      aria-hidden="true"
                      className="absolute bottom-1 left-1/2 z-[4] h-0.5 w-4 -translate-x-1/2 rounded-full bg-primary"
                    />
                  ) : null}
                </button>
              </li>
            </React.Fragment>
          )
        })}
      </ul>
    </nav>
  )
}
