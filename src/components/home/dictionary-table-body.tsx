"use client"

import * as React from "react"

import { TableBody } from "@/components/ui/table"

const WINDOW_THRESHOLD = 200
const OVERSCAN = 8

/** Keep page-wide selection/data intact; only window the mounted table rows. */
export function DictionaryTableBody({
  count,
  scrollAreaRef,
  children,
}: {
  count: number
  scrollAreaRef: React.RefObject<HTMLDivElement | null>
  children: (index: number) => React.ReactNode
}) {
  const bodyRef = React.useRef<HTMLTableSectionElement>(null)
  const [window, setWindow] = React.useState({
    start: 0,
    end: 32,
    rowHeight: 49,
  })
  const [focusedIndex, setFocusedIndex] = React.useState<number | null>(null)
  const [focusRequest, setFocusRequest] = React.useState<{
    index: number
    last: boolean
  } | null>(null)
  const virtual = count > WINDOW_THRESHOLD

  React.useLayoutEffect(() => {
    if (!virtual) return
    const viewport = scrollAreaRef.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]'
    )
    const body = bodyRef.current
    if (!viewport || !body) return
    let frame = 0
    const measure = () => {
      frame = 0
      const row = body.querySelector<HTMLElement>("[data-dictionary-index]")
      const rowHeight = row?.getBoundingClientRect().height
      if (!rowHeight || !viewport.clientHeight) return
      const bodyTop =
        body.getBoundingClientRect().top -
        viewport.getBoundingClientRect().top +
        viewport.scrollTop
      const first = Math.floor(
        Math.max(0, viewport.scrollTop - bodyTop) / rowHeight
      )
      const start = Math.min(
        Math.max(0, first - OVERSCAN),
        Math.max(0, count - 1)
      )
      const end = Math.min(
        count,
        first + Math.ceil(viewport.clientHeight / rowHeight) + OVERSCAN
      )
      setWindow((previous) =>
        previous.start === start &&
        previous.end === end &&
        previous.rowHeight === rowHeight
          ? previous
          : { start, end, rowHeight }
      )
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    const observer = new ResizeObserver(schedule)
    observer.observe(viewport)
    const firstRow = body.querySelector<HTMLElement>("[data-dictionary-index]")
    if (firstRow) observer.observe(firstRow)
    viewport.addEventListener("scroll", schedule, { passive: true })
    measure()
    return () => {
      observer.disconnect()
      viewport.removeEventListener("scroll", schedule)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [count, scrollAreaRef, virtual])

  React.useLayoutEffect(() => {
    if (!focusRequest) return
    const row = bodyRef.current?.querySelector<HTMLElement>(
      `[data-dictionary-index="${focusRequest.index}"]`
    )
    const controls = row ? rowControls(row) : []
    const target = focusRequest.last ? controls.at(-1) : controls[0]
    if (target) {
      target.focus({ preventScroll: true })
      target.scrollIntoView({ block: "nearest" })
      setFocusRequest(null)
    }
  }, [focusRequest])

  const start = Math.min(window.start, Math.max(0, count - 1))
  const end = Math.max(start + 1, Math.min(count, window.end))
  const indexes = virtual
    ? Array.from({ length: end - start }, (_, offset) => start + offset)
    : Array.from({ length: count }, (_, index) => index)
  // Scrolling with the mouse must not unmount the focused control. Keep at
  // most one extra row, with spacers around it, rather than widening the window.
  if (
    virtual &&
    focusedIndex !== null &&
    focusedIndex < count &&
    !indexes.includes(focusedIndex)
  ) {
    indexes.push(focusedIndex)
    indexes.sort((a, b) => a - b)
  }
  const rows: React.ReactNode[] = []
  let previous = 0
  for (const index of indexes) {
    if (index > previous)
      rows.push(spacer(previous, (index - previous) * window.rowHeight))
    rows.push(
      <React.Fragment key={`row-${index}`}>{children(index)}</React.Fragment>
    )
    previous = index + 1
  }
  if (previous < count)
    rows.push(spacer(previous, (count - previous) * window.rowHeight))

  return (
    <TableBody
      ref={bodyRef}
      onFocusCapture={(event) => {
        const row = (event.target as HTMLElement).closest<HTMLElement>(
          "[data-dictionary-index]"
        )
        if (row) setFocusedIndex(Number(row.dataset.dictionaryIndex))
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setFocusedIndex(null)
      }}
      onKeyDownCapture={(event) => {
        if (
          !virtual ||
          event.key !== "Tab" ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey
        )
          return
        const row = (event.target as HTMLElement).closest<HTMLElement>(
          "[data-dictionary-index]"
        )
        if (!row) return
        const controls = rowControls(row)
        const boundary = event.shiftKey ? controls[0] : controls.at(-1)
        if (event.target !== boundary) return
        const index =
          Number(row.dataset.dictionaryIndex) + (event.shiftKey ? -1 : 1)
        if (index < 0 || index >= count) return
        event.preventDefault()
        setFocusedIndex(index)
        setFocusRequest({ index, last: event.shiftKey })
      }}
    >
      {rows}
    </TableBody>
  )
}

function rowControls(row: HTMLElement) {
  return Array.from(
    row.querySelectorAll<HTMLElement>("button, input, [tabindex]")
  ).filter(
    (control) =>
      control.tabIndex >= 0 &&
      !control.matches(":disabled") &&
      control.getClientRects().length > 0
  )
}

function spacer(index: number, height: number) {
  return (
    <tr key={`space-${index}`} aria-hidden="true" style={{ height, border: 0 }}>
      <td colSpan={4} style={{ height, padding: 0, border: 0 }} />
    </tr>
  )
}
