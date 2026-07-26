type PlaceholderPageProps = {
  eyebrow: string
  title: string
  description: string
}

export function PlaceholderPage({
  eyebrow,
  title,
  description,
}: PlaceholderPageProps) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="mx-auto flex h-full w-full max-w-[720px] flex-col px-5 pt-6 pb-2">
        <header className="mb-3 shrink-0 text-center">
          <p className="text-[11px] font-medium tracking-[0.16em] text-muted-foreground uppercase">
            {eyebrow}
          </p>
          <h1 className="mt-1 text-lg font-semibold tracking-tight">{title}</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        </header>

        <div className="flex min-h-0 flex-1 items-center justify-center rounded-xl border border-dashed border-border bg-muted/30 px-6 text-center">
          <p className="text-sm font-medium text-foreground">页面 UI 待绘制</p>
        </div>
      </div>
    </div>
  )
}
