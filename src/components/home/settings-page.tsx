"use client"

import { ArrowLeft, Cpu, Database, Sparkles, Settings2 } from "lucide-react"
import * as React from "react"

import {
  AiSettingsPanel,
  type AiSettingsPanelHandle,
} from "@/components/home/ai-settings-panel"
import { AppSettingsPanel } from "@/components/home/app-settings-panel"
import { DataSettingsPanel } from "@/components/home/data-settings-panel"
import { EngineSettingsPanel } from "@/components/home/engine-settings-panel"
import {
  WorkbenchPage,
  WorkbenchPageContent,
  WorkbenchPageHeader,
} from "@/components/layout/workbench-page"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

export type SettingsCategory = "ai" | "engine" | "app" | "data"

export type SettingsPageHandle = {
  saveAiChanges: () => Promise<boolean>
}

const CATEGORIES: {
  id: SettingsCategory
  label: string
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>
}[] = [
  {
    id: "ai",
    label: "AI 模型",
    icon: Sparkles,
  },
  {
    id: "engine",
    label: "解密引擎",
    icon: Cpu,
  },
  {
    id: "app",
    label: "应用",
    icon: Settings2,
  },
  {
    id: "data",
    label: "数据",
    icon: Database,
  },
]

type SettingsPageProps = {
  initialCategory?: SettingsCategory
  categoryRequestId?: number
  returnAction?: {
    label: string
    onClick: () => void
  }
  onAiDirtyChange?: (dirty: boolean) => void
}

type PendingSettingsLeave =
  | { type: "category"; category: SettingsCategory }
  | { type: "return" }

export const SettingsPage = React.forwardRef<
  SettingsPageHandle,
  SettingsPageProps
>(function SettingsPage(
  {
    initialCategory = "engine",
    categoryRequestId = 0,
    returnAction,
    onAiDirtyChange,
  },
  ref
) {
  const aiSettingsPanelRef = React.useRef<AiSettingsPanelHandle>(null)
  const [category, setCategory] =
    React.useState<SettingsCategory>(initialCategory)
  const [visitedCategories, setVisitedCategories] = React.useState([
    initialCategory,
  ])
  const [handledCategoryRequestId, setHandledCategoryRequestId] =
    React.useState(categoryRequestId)
  const [aiDirty, setAiDirty] = React.useState(false)
  const [pendingSettingsLeave, setPendingSettingsLeave] =
    React.useState<PendingSettingsLeave | null>(null)
  const [leaveSaveBusy, setLeaveSaveBusy] = React.useState(false)

  if (handledCategoryRequestId !== categoryRequestId) {
    setHandledCategoryRequestId(categoryRequestId)
    setCategory(initialCategory)
  }

  if (!visitedCategories.includes(category)) {
    setVisitedCategories([...visitedCategories, category])
  }

  const handleAiDirtyChange = React.useCallback(
    (dirty: boolean) => {
      setAiDirty(dirty)
      onAiDirtyChange?.(dirty)
    },
    [onAiDirtyChange]
  )

  const completeSettingsLeave = React.useCallback(
    (pending: PendingSettingsLeave) => {
      setPendingSettingsLeave(null)
      handleAiDirtyChange(false)
      if (pending.type === "category") {
        setCategory(pending.category)
      } else {
        returnAction?.onClick()
      }
    },
    [handleAiDirtyChange, returnAction]
  )

  const requestCategoryChange = (next: SettingsCategory) => {
    if (next === category) {
      return
    }
    if (category === "ai" && aiDirty) {
      setPendingSettingsLeave({ type: "category", category: next })
      return
    }
    setCategory(next)
  }

  const requestReturn = () => {
    if (category === "ai" && aiDirty) {
      setPendingSettingsLeave({ type: "return" })
      return
    }
    returnAction?.onClick()
  }

  const handleSaveAndLeaveSettings = async () => {
    if (!pendingSettingsLeave || leaveSaveBusy) {
      return
    }
    const pending = pendingSettingsLeave
    setLeaveSaveBusy(true)
    try {
      const saved = await aiSettingsPanelRef.current?.saveUnsavedChanges()
      if (saved !== false) {
        completeSettingsLeave(pending)
      }
    } finally {
      setLeaveSaveBusy(false)
    }
  }

  React.useImperativeHandle(ref, () => ({
    saveAiChanges: async () =>
      (await aiSettingsPanelRef.current?.saveUnsavedChanges()) ?? true,
  }))

  return (
    <WorkbenchPage>
      <WorkbenchPageContent className="gap-2">
        <WorkbenchPageHeader
          title="设置"
          titleHidden
          actions={
            returnAction ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={requestReturn}
              >
                <ArrowLeft data-icon="inline-start" />
                {returnAction.label}
              </Button>
            ) : null
          }
        />

        <Tabs
          value={category}
          onValueChange={(value) => {
            if (value != null) {
              requestCategoryChange(value as SettingsCategory)
            }
          }}
          className="flex min-h-0 flex-1 flex-col gap-2"
        >
          <TabsList className="min-h-9 w-full shrink-0 flex-wrap justify-start gap-0.5 rounded-2xl group-data-horizontal/tabs:h-auto sm:rounded-full">
            {CATEGORIES.map((item) => {
              const Icon = item.icon
              return (
                <TabsTrigger
                  key={item.id}
                  value={item.id}
                  className="h-8 flex-none"
                >
                  <Icon data-icon="inline-start" />
                  {item.label}
                </TabsTrigger>
              )
            })}
          </TabsList>

          <div className="min-h-0 flex-1 scroll-fade overflow-y-auto pb-1">
            <TabsContent value="ai" className="mt-0 outline-none">
              <AiSettingsPanel
                ref={aiSettingsPanelRef}
                onDirtyChange={handleAiDirtyChange}
              />
            </TabsContent>
            <TabsContent
              value="engine"
              keepMounted={visitedCategories.includes("engine")}
              className="mt-0 outline-none"
            >
              <EngineSettingsPanel />
            </TabsContent>
            <TabsContent
              value="app"
              keepMounted={visitedCategories.includes("app")}
              className="mt-0 outline-none"
            >
              <AppSettingsPanel />
            </TabsContent>
            <TabsContent value="data" className="mt-0 outline-none">
              <DataSettingsPanel />
            </TabsContent>
          </div>
        </Tabs>
      </WorkbenchPageContent>

      <AlertDialog
        open={pendingSettingsLeave !== null}
        onOpenChange={(open) => {
          if (!open && !leaveSaveBusy) {
            setPendingSettingsLeave(null)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>保存 AI 设置更改？</AlertDialogTitle>
            <AlertDialogDescription>
              当前配置或重命名提示词有未保存更改。离开后，这些更改将丢失。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={leaveSaveBusy}>
              继续编辑
            </AlertDialogCancel>
            <Button
              type="button"
              variant="outline"
              disabled={leaveSaveBusy}
              onClick={() => {
                if (pendingSettingsLeave) {
                  completeSettingsLeave(pendingSettingsLeave)
                }
              }}
            >
              放弃更改
            </Button>
            <AlertDialogAction
              disabled={leaveSaveBusy}
              onClick={(event) => {
                event.preventDefault()
                void handleSaveAndLeaveSettings()
              }}
            >
              {leaveSaveBusy ? "正在保存…" : "保存并离开"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </WorkbenchPage>
  )
})
