"use client"

import { ArrowLeft, Cpu, Database, Sparkles, Settings2 } from "lucide-react"
import * as React from "react"
import { toast } from "sonner"

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
  canLeave: () => boolean
  saveAiChanges: () => Promise<boolean>
  discardAiChanges: () => void
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
  onDatabaseRestored: () => void
  initialCategory?: SettingsCategory
  categoryRequestId?: number
  returnAction?: {
    label: string
    onClick: () => void
  }
  onAiDirtyChange?: (dirty: boolean) => void
  onAppDirtyChange?: (dirty: boolean) => void
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
    onAppDirtyChange,
    onDatabaseRestored,
  },
  ref
) {
  const [dataRevision, setDataRevision] = React.useState(0)
  const aiSettingsPanelRef = React.useRef<AiSettingsPanelHandle>(null)
  const settingsScrollRef = React.useRef<HTMLDivElement>(null)
  const [category, setCategory] =
    React.useState<SettingsCategory>(initialCategory)
  React.useEffect(() => {
    settingsScrollRef.current?.scrollTo({ top: 0 })
  }, [category])
  const [visitedCategories, setVisitedCategories] = React.useState([
    initialCategory,
  ])
  const [handledCategoryRequestId, setHandledCategoryRequestId] =
    React.useState(categoryRequestId)
  const [aiDirty, setAiDirty] = React.useState(false)
  const [pendingSettingsLeave, setPendingSettingsLeave] =
    React.useState<PendingSettingsLeave | null>(null)
  const [leaveSaveBusy, setLeaveSaveBusy] = React.useState(false)
  const leaveOperation = React.useRef(false)
  const canLeave = () => {
    if (leaveOperation.current || aiSettingsPanelRef.current?.isSubmitting()) {
      toast.info("AI 操作正在进行，请等待完成后再切换。", {
        id: "settings-pending",
      })
      return false
    }
    return true
  }

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
    if (!canLeave()) return
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
    if (!canLeave()) return
    if (category === "ai" && aiDirty) {
      setPendingSettingsLeave({ type: "return" })
      return
    }
    returnAction?.onClick()
  }

  const handleSaveAndLeaveSettings = async () => {
    if (!pendingSettingsLeave || leaveSaveBusy || leaveOperation.current) {
      return
    }
    const pending = pendingSettingsLeave
    leaveOperation.current = true
    setLeaveSaveBusy(true)
    try {
      const saved = await aiSettingsPanelRef.current?.saveUnsavedChanges()
      if (saved !== false) {
        completeSettingsLeave(pending)
      }
    } finally {
      leaveOperation.current = false
      setLeaveSaveBusy(false)
    }
  }

  React.useImperativeHandle(ref, () => ({
    canLeave,
    saveAiChanges: async () =>
      (await aiSettingsPanelRef.current?.saveUnsavedChanges()) ?? true,
    discardAiChanges: () => aiSettingsPanelRef.current?.discardUnsavedChanges(),
  }))

  return (
    <WorkbenchPage data-workbench="settings">
      <WorkbenchPageContent className="gap-2">
        <WorkbenchPageHeader
          title="设置"
          description="解密引擎、AI 命名和本机数据，都由你决定。"
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

          <div
            ref={settingsScrollRef}
            className="byte-settings-scroll min-h-0 flex-1 scroll-fade overflow-y-auto pb-1"
          >
            <TabsContent
              value="ai"
              keepMounted={visitedCategories.includes("ai")}
              className="mt-0 outline-none"
            >
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
              <EngineSettingsPanel key={dataRevision} />
            </TabsContent>
            <TabsContent
              value="app"
              keepMounted={visitedCategories.includes("app")}
              className="mt-0 outline-none"
            >
              <AppSettingsPanel
                key={dataRevision}
                onDirtyChange={onAppDirtyChange}
              />
            </TabsContent>
            <TabsContent
              value="data"
              keepMounted={visitedCategories.includes("data")}
              className="mt-0 outline-none"
            >
              <DataSettingsPanel
                onRestored={() => {
                  setDataRevision((v) => v + 1)
                  onDatabaseRestored()
                }}
              />
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
                  aiSettingsPanelRef.current?.discardUnsavedChanges()
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
