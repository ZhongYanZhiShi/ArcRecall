import {
  WorkbenchPage,
  WorkbenchPageContent,
  WorkbenchPageHeader,
} from "@/components/layout/workbench-page"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"

type PlaceholderPageProps = {
  title: string
  description: string
}

export function PlaceholderPage({ title, description }: PlaceholderPageProps) {
  return (
    <WorkbenchPage>
      <WorkbenchPageContent>
        <WorkbenchPageHeader
          title={title}
          description={description}
          className="mb-3 text-center"
          contentClassName="w-full"
        />

        <Empty className="min-h-0 flex-1 border border-border bg-muted/30 px-6">
          <EmptyHeader>
            <EmptyTitle className="text-sm">页面 UI 待绘制</EmptyTitle>
            <EmptyDescription className="text-xs">
              {description}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </WorkbenchPageContent>
    </WorkbenchPage>
  )
}
