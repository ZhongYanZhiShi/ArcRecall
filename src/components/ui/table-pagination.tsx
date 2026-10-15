"use client"

import * as React from "react"
import {
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Pagination,
  PaginationContent,
  PaginationItem,
} from "@/components/ui/pagination"

type TablePaginationProps = {
  label: string
  pageIndex: number
  pageSize: number
  totalCount: number
  busy?: boolean
  onPageChange: (pageIndex: number) => void
  onPageSizeChange: (pageSize: number) => void
}

/** Shared pagination interactions; callers own fetching and committed query state. */
export function TablePagination({
  label,
  pageIndex,
  pageSize,
  totalCount,
  busy = false,
  onPageChange,
  onPageSizeChange,
}: TablePaginationProps) {
  const [jumpPage, setJumpPage] = React.useState<string | null>(null)
  const [customPageSize, setCustomPageSize] = React.useState(String(pageSize))
  const [customSizeMode, setCustomSizeMode] = React.useState(false)
  const pageCount = Math.ceil(totalCount / pageSize)
  const displayedPage = pageCount === 0 ? 0 : pageIndex + 1
  const hasPreviousPage = pageIndex > 0 && pageCount > 0
  const hasNextPage = pageIndex + 1 < pageCount

  const changePage = (index: number) => {
    setJumpPage(null)
    if (busy || index < 0 || index >= pageCount || index === pageIndex) return
    onPageChange(index)
  }
  const changePageSize = (size: number) => {
    if (busy || !Number.isSafeInteger(size) || size < 1) return
    setCustomSizeMode(false)
    setJumpPage(null)
    onPageSizeChange(size)
  }
  const commitJumpPage = () => {
    const page = Number(jumpPage)
    setJumpPage(null)
    if (jumpPage && Number.isInteger(page)) changePage(page - 1)
  }
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-3 py-2">
      <span className="text-xs text-muted-foreground tabular-nums">
        共 {totalCount} 条
      </span>
      <div className="flex flex-wrap items-center gap-1">
        {customSizeMode ? (
          <form
            className="flex items-center gap-1"
            onSubmit={(event) => {
              event.preventDefault()
              changePageSize(Number(customPageSize))
            }}
          >
            <Input
              type="number"
              min={1}
              step={1}
              required
              autoFocus
              aria-label="自定义每页条数"
              value={customPageSize}
              onChange={(event) => setCustomPageSize(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setCustomSizeMode(false)
              }}
              disabled={busy}
              className="h-8 w-24 text-xs"
            />
            <Button
              type="submit"
              size="icon-sm"
              variant="ghost"
              disabled={
                busy ||
                !Number.isSafeInteger(Number(customPageSize)) ||
                Number(customPageSize) < 1
              }
              aria-label="应用"
              title="应用"
            >
              <Check />
            </Button>
          </form>
        ) : (
          <Select
            value={String(pageSize)}
            onValueChange={(value) => {
              if (!value) return
              if (value === "custom") {
                setCustomPageSize(String(pageSize))
                setCustomSizeMode(true)
              } else changePageSize(Number(value))
            }}
            disabled={busy}
          >
            <SelectTrigger
              size="sm"
              aria-label="每页条数"
              className="bg-transparent px-1 text-xs text-muted-foreground"
            >
              <SelectValue>{pageSize} 行/页</SelectValue>
            </SelectTrigger>
            <SelectContent side="top" align="end" alignItemWithTrigger={false}>
              {[50, 100, 500, 1000].map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size} 行/页
                </SelectItem>
              ))}
              <SelectItem value="custom">自定义</SelectItem>
            </SelectContent>
          </Select>
        )}
        <Pagination aria-label={label} className="mx-0 w-auto shrink-0">
          <PaginationContent className="gap-0">
            <PaginationItem>
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={busy || !hasPreviousPage}
                onClick={() => changePage(0)}
                aria-label="首页"
                title="首页"
              >
                <ChevronsLeft />
              </Button>
            </PaginationItem>
            <PaginationItem>
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={busy || !hasPreviousPage}
                onClick={() => changePage(pageIndex - 1)}
                aria-label="上一页"
                title="上一页"
              >
                <ChevronLeft />
              </Button>
            </PaginationItem>
            <PaginationItem>
              <form
                className="flex items-center gap-1"
                onSubmit={(event) => {
                  event.preventDefault()
                  commitJumpPage()
                }}
              >
                <Input
                  type="number"
                  min={1}
                  max={pageCount || 1}
                  step={1}
                  required
                  aria-label="跳转页码"
                  title={`共 ${pageCount} 页`}
                  value={
                    pageCount === 0 ? "0" : (jumpPage ?? String(displayedPage))
                  }
                  onChange={(event) => {
                    const value = event.target.value
                    if (value === "") {
                      setJumpPage("")
                      return
                    }
                    const page = Number(value)
                    if (Number.isFinite(page))
                      setJumpPage(
                        String(
                          Math.min(
                            pageCount || 1,
                            Math.max(1, Math.trunc(page))
                          )
                        )
                      )
                  }}
                  onBlur={commitJumpPage}
                  disabled={busy || pageCount === 0}
                  className="h-8 w-16 [appearance:textfield] rounded-lg border-border bg-transparent text-center text-xs tabular-nums [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                />
                <span
                  className="shrink-0 text-xs text-muted-foreground tabular-nums"
                  aria-label={`共 ${pageCount} 页`}
                >
                  / {pageCount}
                </span>
              </form>
            </PaginationItem>
            <PaginationItem>
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={busy || !hasNextPage}
                onClick={() => changePage(pageIndex + 1)}
                aria-label="下一页"
                title="下一页"
              >
                <ChevronRight />
              </Button>
            </PaginationItem>
            <PaginationItem>
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={busy || !hasNextPage}
                onClick={() => changePage(pageCount - 1)}
                aria-label="末页"
                title="末页"
              >
                <ChevronsRight />
              </Button>
            </PaginationItem>
          </PaginationContent>
        </Pagination>
        <span
          role="status"
          className="sr-only"
        >{`第 ${displayedPage} / ${pageCount} 页 · 共 ${totalCount} 条`}</span>
      </div>
    </div>
  )
}
