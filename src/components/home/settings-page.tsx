"use client"

import { Archive, Cpu, Database, HardDrive, Settings2 } from "lucide-react"
import * as React from "react"

import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { type DatabaseInfo, getDatabaseInfo } from "@/lib/settings"

type SettingsCategory = "compress" | "engine" | "app" | "data"

const CATEGORIES: {
  id: SettingsCategory
  label: string
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>
  description: string
}[] = [
  {
    id: "compress",
    label: "压缩",
    icon: Archive,
    description: "默认格式、级别、密码与文件名加密",
  },
  {
    id: "engine",
    label: "引擎",
    icon: Cpu,
    description: "外部 hashcat / John / Perl 路径",
  },
  {
    id: "app",
    label: "应用",
    icon: Settings2,
    description: "日志级别、7-Zip 诊断与快捷入口",
  },
  {
    id: "data",
    label: "数据",
    icon: Database,
    description: "本机 SQLite 与设置文件位置",
  },
]

export function SettingsPage() {
  const [category, setCategory] = React.useState<SettingsCategory>("data")
  const [dbInfo, setDbInfo] = React.useState<DatabaseInfo | null>(null)

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const info = await getDatabaseInfo()
        if (!cancelled) {
          setDbInfo(info)
        }
      } catch {
        if (!cancelled) {
          setDbInfo(null)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const activeMeta =
    CATEGORIES.find((item) => item.id === category) ?? CATEGORIES[0]!

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="mx-auto flex h-full min-h-0 w-full max-w-[720px] flex-col gap-2 px-5 pt-6 pb-2">
        <header className="shrink-0">
          <div className="min-w-0">
            <p className="text-[11px] font-medium tracking-[0.16em] text-muted-foreground uppercase">
              Preferences
            </p>
            <h1 className="mt-1 text-lg font-semibold tracking-tight">设置</h1>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {activeMeta.description}
            </p>
          </div>
        </header>

        <Tabs
          value={category}
          onValueChange={(value) => {
            if (value == null) {
              return
            }
            setCategory(value as SettingsCategory)
          }}
          className="flex min-h-0 flex-1 flex-col gap-2"
        >
          <TabsList className="h-auto w-full shrink-0 flex-wrap justify-start gap-0.5 rounded-2xl p-1">
            {CATEGORIES.map((item) => {
              const Icon = item.icon
              return (
                <TabsTrigger
                  key={item.id}
                  value={item.id}
                  className="flex-none gap-1.5 px-2.5 text-xs sm:text-sm"
                >
                  <Icon className="size-3.5" strokeWidth={1.9} />
                  {item.label}
                </TabsTrigger>
              )
            })}
          </TabsList>

          <div className="min-h-0 flex-1 overflow-y-auto pb-1">
            <TabsContent value="compress" className="mt-0 outline-none">
              <PlaceholderCategory
                title="压缩默认值"
                body="默认格式（7z / ZIP）、压缩级别、默认密码与 7z 文件名加密将在此配置。"
              />
            </TabsContent>

            <TabsContent value="engine" className="mt-0 outline-none">
              <PlaceholderCategory
                title="外部字典引擎"
                body="可配置 Auto / InternalCpu / HashcatGpu / HashcatCpu，以及 hashcat.exe、John 工具目录与 perl 路径。不捆绑外部工具。"
              />
            </TabsContent>

            <TabsContent value="app" className="mt-0 outline-none">
              <div className="space-y-2">
                <PlaceholderCategory
                  title="应用日志"
                  body="日志级别与诊断输出将在此配置；日志不会写入明文密码或完整 7-Zip 参数。"
                />
                <PlaceholderCategory
                  title="内置 7-Zip"
                  body="启动时自动诊断内置 7-Zip 可用性，状态将显示在此。"
                />
                <PlaceholderCategory
                  title="资源管理器快捷解压"
                  body="可启用 / 禁用「用 ArcRecall 快捷解压」右键菜单（HKCU，无需管理员）。"
                />
              </div>
            </TabsContent>

            <TabsContent value="data" className="mt-0 outline-none">
              <Card size="sm">
                <CardHeader className="border-b border-border/80">
                  <div className="flex items-center gap-2">
                    <Database className="size-4 text-muted-foreground" />
                    <CardTitle className="text-sm">本地数据</CardTitle>
                  </div>
                  <CardDescription className="text-xs">
                    本机
                    SQLite，不在项目仓库内；缺失时自动创建。字典导入编码自动识别。
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 pt-4">
                  <InfoRow
                    icon={<HardDrive className="size-3.5" />}
                    label="数据根目录"
                    value={dbInfo?.rootPath ?? "—"}
                  />
                  <InfoRow
                    icon={<HardDrive className="size-3.5" />}
                    label="数据库"
                    value={dbInfo?.path ?? "—"}
                    badge={
                      dbInfo
                        ? dbInfo.exists
                          ? `已存在 · ${dbInfo.candidateCount} 条候选`
                          : "将在首次写入时创建"
                        : undefined
                    }
                  />
                  <InfoRow
                    icon={<HardDrive className="size-3.5" />}
                    label="设置文件"
                    value={dbInfo?.settingsPath ?? "—"}
                  />
                </CardContent>
              </Card>
            </TabsContent>
          </div>
        </Tabs>
      </div>
    </div>
  )
}

function PlaceholderCategory({ title, body }: { title: string; body: string }) {
  return (
    <Card size="sm">
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle className="text-sm">{title}</CardTitle>
          <Badge variant="outline" className="font-normal">
            待接入
          </Badge>
        </div>
        <CardDescription className="text-xs leading-relaxed">
          {body}
        </CardDescription>
      </CardHeader>
    </Card>
  )
}

function InfoRow({
  icon,
  label,
  value,
  badge,
}: {
  icon: React.ReactNode
  label: string
  value: string
  badge?: string
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        <span>{label}</span>
        {badge ? (
          <Badge variant="outline" className="font-normal">
            {badge}
          </Badge>
        ) : null}
      </div>
      <p className="rounded-xl bg-muted/40 px-2.5 py-2 font-mono text-[11px] break-all text-foreground">
        {value}
      </p>
    </div>
  )
}
