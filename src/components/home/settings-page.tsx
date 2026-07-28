"use client"

import {
  Archive,
  Cpu,
  Database,
  Download,
  ExternalLink,
  HardDrive,
  Package,
  Settings2,
} from "lucide-react"
import * as React from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  type DatabaseInfo,
  type FullEngineBundleStatus,
  type HashcatStatus,
  type JohnPerlStatus,
  downloadHashcat,
  getDatabaseInfo,
  getFullEngineBundleStatus,
  getHashcatStatus,
  getJohnPerlStatus,
  installFullEngineBundle,
  openPath,
  setJohnPerl as saveJohnPerlPaths,
  setToolsDirectory,
} from "@/lib/settings"
import { cn } from "@/lib/utils"

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
    description: "外部 hashcat 等工具的安装与路径",
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
  const [category, setCategory] = React.useState<SettingsCategory>("engine")
  const [dbInfo, setDbInfo] = React.useState<DatabaseInfo | null>(null)
  const [fullBundle, setFullBundle] =
    React.useState<FullEngineBundleStatus | null>(null)
  const [hashcat, setHashcat] = React.useState<HashcatStatus | null>(null)
  const [johnPerl, setJohnPerl] = React.useState<JohnPerlStatus | null>(null)
  const [toolsDirInput, setToolsDirInput] = React.useState("")
  const [johnDirInput, setJohnDirInput] = React.useState("")
  const [perlPathInput, setPerlPathInput] = React.useState("")
  const [engineBusy, setEngineBusy] = React.useState(false)
  const [engineMessage, setEngineMessage] = React.useState<string | null>(null)
  const [engineError, setEngineError] = React.useState(false)

  const refreshEngine = React.useCallback(async () => {
    try {
      const [bundle, status, john] = await Promise.all([
        getFullEngineBundleStatus(),
        getHashcatStatus(),
        getJohnPerlStatus(),
      ])
      setFullBundle(bundle)
      setHashcat(status)
      setJohnPerl(john)
      setToolsDirInput(status.configuredToolsDirectory || "")
      setJohnDirInput(john.johnToolsDirectory || "")
      setPerlPathInput(john.perlPath || "")
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error ?? "未知错误")
      setEngineMessage(`读取引擎状态失败：${message}`)
      setEngineError(true)
    }
  }, [])

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [info, bundle, status, john] = await Promise.all([
          getDatabaseInfo(),
          getFullEngineBundleStatus(),
          getHashcatStatus(),
          getJohnPerlStatus(),
        ])
        if (cancelled) {
          return
        }
        setDbInfo(info)
        setFullBundle(bundle)
        setHashcat(status)
        setJohnPerl(john)
        setToolsDirInput(status.configuredToolsDirectory || "")
        setJohnDirInput(john.johnToolsDirectory || "")
        setPerlPathInput(john.perlPath || "")
      } catch {
        if (!cancelled) {
          setDbInfo(null)
          setFullBundle(null)
          setHashcat(null)
          setJohnPerl(null)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const handleSaveToolsDir = () => {
    if (engineBusy) {
      return
    }
    setEngineBusy(true)
    setEngineError(false)
    setEngineMessage("正在保存公共工具目录…")
    void (async () => {
      try {
        await setToolsDirectory(toolsDirInput.trim())
        await refreshEngine()
        setEngineMessage(
          toolsDirInput.trim()
            ? "已保存公共工具目录；下载的引擎将安装到此目录。"
            : "已恢复默认工具目录（应用数据下的 tools）。"
        )
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error ?? "未知错误")
        setEngineError(true)
        setEngineMessage(`保存失败：${message}`)
      } finally {
        setEngineBusy(false)
      }
    })()
  }

  const handleResetToolsDir = () => {
    setToolsDirInput("")
    if (engineBusy) {
      return
    }
    setEngineBusy(true)
    setEngineError(false)
    void (async () => {
      try {
        await setToolsDirectory("")
        await refreshEngine()
        setEngineMessage("已恢复默认工具目录。")
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error ?? "未知错误")
        setEngineError(true)
        setEngineMessage(`恢复默认失败：${message}`)
      } finally {
        setEngineBusy(false)
      }
    })()
  }

  const handleDownloadHashcat = () => {
    if (engineBusy) {
      return
    }
    setEngineBusy(true)
    setEngineError(false)
    setEngineMessage("正在从 GitHub 下载 hashcat 固定版本（校验 SHA-256）…")
    void (async () => {
      try {
        const result = await downloadHashcat()
        setEngineError(!result.success)
        setEngineMessage(result.message)
        await refreshEngine()
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error ?? "未知错误")
        setEngineError(true)
        setEngineMessage(`下载失败：${message}`)
      } finally {
        setEngineBusy(false)
      }
    })()
  }

  const handleInstallFullBundle = () => {
    if (engineBusy) {
      return
    }
    setEngineBusy(true)
    setEngineError(false)
    setEngineMessage(
      "正在校验并离线展开完整引擎包；便携 Perl 体积较大，请稍候…"
    )
    void (async () => {
      try {
        const result = await installFullEngineBundle()
        setEngineError(!result.success)
        setEngineMessage(result.message)
        await refreshEngine()
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error ?? "未知错误")
        setEngineError(true)
        setEngineMessage(`完整引擎部署失败：${message}`)
      } finally {
        setEngineBusy(false)
      }
    })()
  }

  const handleSaveJohnPerl = () => {
    if (engineBusy) {
      return
    }
    setEngineBusy(true)
    setEngineError(false)
    setEngineMessage("正在保存 John / Perl 路径…")
    void (async () => {
      try {
        const status = await saveJohnPerlPaths(
          johnDirInput.trim(),
          perlPathInput.trim()
        )
        setJohnPerl(status)
        setEngineError(!status.ready)
        setEngineMessage(status.message)
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error ?? "未知错误")
        setEngineError(true)
        setEngineMessage(`保存失败：${message}`)
      } finally {
        setEngineBusy(false)
      }
    })()
  }

  const handleProbeJohnPerl = () => {
    if (engineBusy) {
      return
    }
    setEngineBusy(true)
    setEngineError(false)
    void (async () => {
      try {
        const status = await getJohnPerlStatus()
        setJohnPerl(status)
        setJohnDirInput(status.johnToolsDirectory || "")
        setPerlPathInput(status.perlPath || "")
        setEngineError(!status.ready && Boolean(status.johnToolsDirectory))
        setEngineMessage(status.message)
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error ?? "未知错误")
        setEngineError(true)
        setEngineMessage(`检测失败：${message}`)
      } finally {
        setEngineBusy(false)
      }
    })()
  }

  const handleOpenPath = (path: string) => {
    if (engineBusy || !path.trim()) {
      return
    }
    setEngineError(false)
    setEngineMessage(null)
    void openPath(path.trim()).catch((error) => {
      const message =
        error instanceof Error ? error.message : String(error ?? "未知错误")
      setEngineError(true)
      setEngineMessage(`无法跳转到该路径：${message}`)
    })
  }

  const activeMeta =
    CATEGORIES.find((item) => item.id === category) ?? CATEGORIES[0]!

  const hashcatReady =
    Boolean(hashcat?.installed) || Boolean(hashcat?.configuredExists)

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

            <TabsContent value="engine" className="mt-0 space-y-2 outline-none">
              <Card size="sm">
                <CardHeader className="border-b border-border/80">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <CardTitle className="text-sm">
                          Windows x64 完整离线包
                        </CardTitle>
                        <Badge variant="secondary" className="font-normal">
                          清单 v{fullBundle?.manifestVersion ?? 1}
                        </Badge>
                        <Badge
                          variant={fullBundle?.bundled ? "default" : "outline"}
                          className="font-normal"
                        >
                          {fullBundle?.bundled ? "资源已内置" : "精简构建"}
                        </Badge>
                        <Badge
                          variant={
                            fullBundle?.installed ? "default" : "outline"
                          }
                          className="font-normal"
                        >
                          {fullBundle?.installed ? "全部就绪" : "待部署"}
                        </Badge>
                      </div>
                      <CardDescription className="text-xs">
                        安装器内包含 7-Zip、Hashcat、John CPU 引擎、Strawberry
                        Perl，以及 7z2john / rar2john / zip2john。部署时逐包校验
                        SHA-256，再展开到可写工具目录。
                      </CardDescription>
                    </div>
                    <Button
                      size="sm"
                      disabled={
                        engineBusy ||
                        !fullBundle?.bundled ||
                        !fullBundle?.platformSupported
                      }
                      onClick={handleInstallFullBundle}
                    >
                      <Package data-icon="inline-start" />
                      {fullBundle?.installed ? "重新检测 / 补全" : "离线部署"}
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3 pt-4">
                  <div className="flex flex-wrap gap-1.5">
                    {[
                      { id: "7zip", component: fullBundle?.sevenZip },
                      { id: "hashcat", component: fullBundle?.hashcat },
                      { id: "john", component: fullBundle?.john },
                      { id: "perl", component: fullBundle?.perl },
                    ].map(({ id, component }) => (
                      <Badge
                        key={id}
                        variant={component?.runnable ? "default" : "outline"}
                        className="font-normal"
                      >
                        {component?.name ?? "检测中"}{" "}
                        {component?.version ?? "—"} ·{" "}
                        {component?.runnable ? "可运行" : "未就绪"}
                      </Badge>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Badge
                      variant={fullBundle?.has7z2john ? "default" : "outline"}
                      className="font-normal"
                    >
                      7z2john {fullBundle?.has7z2john ? "可用" : "缺失"}
                    </Badge>
                    <Badge
                      variant={fullBundle?.hasRar2john ? "default" : "outline"}
                      className="font-normal"
                    >
                      rar2john {fullBundle?.hasRar2john ? "可用" : "缺失"}
                    </Badge>
                    <Badge
                      variant={fullBundle?.hasZip2john ? "default" : "outline"}
                      className="font-normal"
                    >
                      zip2john {fullBundle?.hasZip2john ? "可用" : "缺失"}
                    </Badge>
                    <Badge
                      variant={fullBundle?.johnCpuReady ? "default" : "outline"}
                      className="font-normal"
                    >
                      CPU 回退 {fullBundle?.johnCpuReady ? "可用" : "缺失"}
                    </Badge>
                  </div>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {fullBundle?.message ?? "正在读取完整包状态…"}
                    GPU 驱动、CUDA、HIP 与 OpenCL
                    由系统提供，不进入发行包；无可用加速后端时使用 John CPU
                    回退。
                  </p>
                  {engineMessage ? (
                    <p
                      className={cn(
                        "rounded-xl px-2.5 py-2 text-xs leading-relaxed",
                        engineError
                          ? "bg-destructive/10 text-destructive"
                          : "bg-muted/50 text-muted-foreground"
                      )}
                    >
                      {engineMessage}
                    </p>
                  ) : null}
                </CardContent>
              </Card>

              <Card size="sm">
                <CardHeader className="border-b border-border/80">
                  <CardTitle className="text-sm">工具公共目录</CardTitle>
                  <CardDescription className="text-xs">
                    引擎下载安装的根目录。可设为公共/共享路径，供本机多处复用；留空则使用应用默认
                    tools 目录。
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 pt-4">
                  <div className="space-y-2">
                    <Label
                      htmlFor="tools-dir"
                      className="text-xs text-muted-foreground"
                    >
                      公共目录（绝对路径）
                    </Label>
                    <div className="flex gap-2">
                      <Input
                        id="tools-dir"
                        value={toolsDirInput}
                        onChange={(event) =>
                          setToolsDirInput(event.target.value)
                        }
                        disabled={engineBusy}
                        placeholder={
                          hashcat?.defaultToolsDirectory ||
                          "留空 = 使用默认 tools 目录"
                        }
                        className="h-9 min-w-0 flex-1 rounded-xl font-mono text-xs"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        className="h-9 rounded-xl"
                        disabled={
                          engineBusy ||
                          !(
                            toolsDirInput.trim() ||
                            hashcat?.defaultToolsDirectory
                          )
                        }
                        onClick={() =>
                          handleOpenPath(
                            toolsDirInput.trim() ||
                              hashcat?.defaultToolsDirectory ||
                              ""
                          )
                        }
                      >
                        <ExternalLink data-icon="inline-start" />
                        跳转
                      </Button>
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      默认：{hashcat?.defaultToolsDirectory || "—"}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      当前生效：{hashcat?.toolsDirectory || "—"}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      disabled={engineBusy}
                      onClick={handleSaveToolsDir}
                    >
                      保存目录
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={engineBusy}
                      onClick={handleResetToolsDir}
                    >
                      恢复默认
                    </Button>
                  </div>
                </CardContent>
              </Card>

              <Card size="sm">
                <CardHeader className="border-b border-border/80">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <CardTitle className="text-sm">hashcat</CardTitle>
                        <Badge variant="secondary" className="font-normal">
                          v{hashcat?.version ?? "—"}
                        </Badge>
                        <Badge
                          variant={hashcatReady ? "default" : "outline"}
                          className="font-normal"
                        >
                          {hashcatReady ? "已就绪" : "未安装"}
                        </Badge>
                      </div>
                      <CardDescription className="text-xs">
                        完整发行包已内置固定版本；这里保留 GitHub
                        下载作为精简构建或修复安装的后备路径。下载同样执行
                        SHA-256 校验，不静默更新、不提权。
                      </CardDescription>
                    </div>
                    <Button
                      size="sm"
                      disabled={engineBusy}
                      onClick={handleDownloadHashcat}
                    >
                      <Download data-icon="inline-start" />
                      {hashcat?.installed ? "重新检测 / 补全" : "下载并安装"}
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3 pt-4">
                  <InfoRow
                    icon={<HardDrive className="size-3.5" />}
                    label="可执行文件"
                    value={
                      hashcat?.configuredPath || hashcat?.executablePath || "—"
                    }
                  />
                  <InfoRow
                    icon={<HardDrive className="size-3.5" />}
                    label="安装目录"
                    value={hashcat?.installDirectory || "—"}
                  />
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <a
                      href={
                        hashcat?.githubRepo ??
                        "https://github.com/hashcat/hashcat"
                      }
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-foreground underline-offset-4 hover:underline"
                    >
                      GitHub 仓库
                      <ExternalLink className="size-3" />
                    </a>
                    <span aria-hidden>·</span>
                    <a
                      href={hashcat?.downloadUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-foreground underline-offset-4 hover:underline"
                    >
                      固定 release 包
                      <ExternalLink className="size-3" />
                    </a>
                  </div>
                </CardContent>
              </Card>

              <Card size="sm">
                <CardHeader className="border-b border-border/80">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <CardTitle className="text-sm">John / Perl</CardTitle>
                        <Badge
                          variant={johnPerl?.ready ? "default" : "outline"}
                          className="font-normal"
                        >
                          {johnPerl?.ready ? "已就绪" : "未就绪"}
                        </Badge>
                      </div>
                      <CardDescription className="text-xs">
                        完整包会自动写入 John 工具目录与
                        perl.exe；也可在此覆盖为 自备版本。提供
                        7z2john、rar2john、zip2john 哈希转换及 John CPU 回退。
                      </CardDescription>
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={engineBusy}
                        onClick={handleProbeJohnPerl}
                      >
                        重新检测
                      </Button>
                      <Button
                        size="sm"
                        disabled={engineBusy}
                        onClick={handleSaveJohnPerl}
                      >
                        保存
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3 pt-4">
                  <div className="space-y-2">
                    <Label
                      htmlFor="john-dir"
                      className="text-xs text-muted-foreground"
                    >
                      John 工具目录
                    </Label>
                    <div className="flex gap-2">
                      <Input
                        id="john-dir"
                        value={johnDirInput}
                        onChange={(event) =>
                          setJohnDirInput(event.target.value)
                        }
                        disabled={engineBusy}
                        placeholder="含 john / 7z2john / rar2john / zip2john 的目录"
                        className="h-9 min-w-0 flex-1 rounded-xl font-mono text-xs"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        className="h-9 rounded-xl"
                        disabled={engineBusy || !johnDirInput.trim()}
                        onClick={() => handleOpenPath(johnDirInput)}
                      >
                        <ExternalLink data-icon="inline-start" />
                        跳转
                      </Button>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label
                      htmlFor="perl-path"
                      className="text-xs text-muted-foreground"
                    >
                      perl.exe 路径
                    </Label>
                    <div className="flex gap-2">
                      <Input
                        id="perl-path"
                        value={perlPathInput}
                        onChange={(event) =>
                          setPerlPathInput(event.target.value)
                        }
                        disabled={engineBusy}
                        placeholder="可选；使用 7z2john.pl 时需要"
                        className="h-9 min-w-0 flex-1 rounded-xl font-mono text-xs"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        className="h-9 rounded-xl"
                        disabled={engineBusy || !perlPathInput.trim()}
                        onClick={() => handleOpenPath(perlPathInput)}
                      >
                        <ExternalLink data-icon="inline-start" />
                        跳转
                      </Button>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Badge
                      variant={
                        johnPerl?.sevenZipConverterReady ? "default" : "outline"
                      }
                      className="font-normal"
                    >
                      7z2john{" "}
                      {johnPerl?.sevenZipConverterReady ? "可用" : "缺失"}
                    </Badge>
                    <Badge
                      variant={
                        johnPerl?.rarConverterReady ? "default" : "outline"
                      }
                      className="font-normal"
                    >
                      rar2john {johnPerl?.rarConverterReady ? "可用" : "缺失"}
                    </Badge>
                    <Badge
                      variant={
                        johnPerl?.zipConverterReady ? "default" : "outline"
                      }
                      className="font-normal"
                    >
                      zip2john {johnPerl?.zipConverterReady ? "可用" : "缺失"}
                    </Badge>
                    <Badge
                      variant={johnPerl?.johnCpuReady ? "default" : "outline"}
                      className="font-normal"
                    >
                      John CPU {johnPerl?.johnCpuReady ? "可用" : "缺失"}
                    </Badge>
                    <Badge
                      variant={johnPerl?.perlExists ? "default" : "outline"}
                      className="font-normal"
                    >
                      perl {johnPerl?.perlExists ? "可用" : "未配置"}
                    </Badge>
                  </div>
                  {johnPerl?.message ? (
                    <p className="text-xs text-muted-foreground">
                      {johnPerl.message}
                    </p>
                  ) : null}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="app" className="mt-0 outline-none">
              <div className="space-y-2">
                <PlaceholderCategory
                  title="应用日志"
                  body="日志级别与诊断输出将在此配置；日志不会写入明文密码或完整 7-Zip 参数。"
                />
                <Card size="sm">
                  <CardHeader>
                    <div className="flex items-center gap-2">
                      <CardTitle className="text-sm">内置 7-Zip</CardTitle>
                      <Badge
                        variant={
                          fullBundle?.sevenZip.runnable ? "default" : "outline"
                        }
                        className="font-normal"
                      >
                        {fullBundle?.sevenZip.runnable ? "可运行" : "未就绪"}
                      </Badge>
                    </div>
                    <CardDescription className="text-xs leading-relaxed">
                      {fullBundle?.sevenZip.message ??
                        "正在读取 7-Zip 进程探测状态…"}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <InfoRow
                      icon={<HardDrive className="size-3.5" />}
                      label="7z.exe"
                      value={fullBundle?.sevenZip.executablePath ?? "—"}
                    />
                  </CardContent>
                </Card>
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
                  <InfoRow
                    icon={<HardDrive className="size-3.5" />}
                    label="外部工具目录"
                    value={dbInfo?.toolsPath ?? "—"}
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
