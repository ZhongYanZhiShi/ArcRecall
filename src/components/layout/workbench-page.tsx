import * as React from "react"

import { cn } from "@/lib/utils"

function WorkbenchPage({
  className,
  ...props
}: React.ComponentProps<"section">) {
  return (
    <section
      data-slot="workbench-page"
      className={cn(
        "flex h-full min-h-0 min-w-0 flex-col overflow-hidden",
        className
      )}
      {...props}
    />
  )
}

type WorkbenchPageContentProps = React.ComponentProps<"div"> & {
  width?: "default" | "wide"
}

function WorkbenchPageContent({
  width = "default",
  className,
  ...props
}: WorkbenchPageContentProps) {
  return (
    <div
      data-slot="workbench-page-content"
      className={cn(
        "mx-auto flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden px-5 pt-6 pb-2",
        width === "default" ? "workbench-page" : "max-w-6xl",
        className
      )}
      {...props}
    />
  )
}

type WorkbenchPageHeaderProps = Omit<
  React.ComponentProps<"header">,
  "title"
> & {
  title: React.ReactNode
  titleHidden?: boolean
  description?: React.ReactNode
  actions?: React.ReactNode
  size?: "default" | "large"
  contentClassName?: string
  actionsClassName?: string
}

function WorkbenchPageHeader({
  title,
  titleHidden = false,
  description,
  actions,
  size = "default",
  className,
  contentClassName,
  actionsClassName,
  ...props
}: WorkbenchPageHeaderProps) {
  const large = size === "large"

  return (
    <header
      data-slot="workbench-page-header"
      className={cn(
        titleHidden && !actions
          ? "sr-only"
          : "flex shrink-0 flex-wrap items-start gap-3",
        titleHidden ? "justify-end" : "justify-between",
        className
      )}
      {...props}
    >
      <div
        className={cn(titleHidden ? "sr-only" : "min-w-0", contentClassName)}
      >
        <h1
          className={cn(
            "font-semibold tracking-tight",
            large ? "text-xl" : "text-lg"
          )}
        >
          {title}
        </h1>
        {description ? (
          <p
            className={cn(
              "text-xs text-muted-foreground",
              large ? "mt-1" : "mt-0.5"
            )}
          >
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div
          className={cn(
            "flex shrink-0 flex-wrap items-center justify-end gap-1.5",
            actionsClassName
          )}
        >
          {actions}
        </div>
      ) : null}
    </header>
  )
}

export { WorkbenchPage, WorkbenchPageContent, WorkbenchPageHeader }
