import {
  Cpu,
  Download,
  ExternalLink,
  HardDrive,
  Package,
  Zap,
} from "lucide-react"

import { SettingsInfoRow } from "@/components/home/settings-info-row"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import type { RecoveryCapabilities, RecoveryComputeMode } from "@/lib/recovery"
import type {
  AppSettings,
  FullEngineBundleStatus,
  HashcatStatus,
  JohnPerlStatus,
} from "@/lib/settings"

export function DefaultRecoveryCard({
  appSettings,
  capabilities,
  settingsBusy,
  engineBusy,
  message,
  messageError,
  onChange,
  onRefresh,
}: {
  appSettings: AppSettings | null
  capabilities: RecoveryCapabilities | null
  settingsBusy: boolean
  engineBusy: boolean
  message: string | null
  messageError: boolean
  onChange: (mode: RecoveryComputeMode) => void
  onRefresh: () => void
}) {
  const hashcatCpuAvailable = Boolean(
    capabilities?.methods.find((method) => method.id === "hashcatCpu")
      ?.available
  )
  const cpuRecoveryChain =
    capabilities === null
      ? "正在探测 CPU 引擎…"
      : hashcatCpuAvailable
        ? "Hashcat CPU → John CPU → 7-Zip CPU"
        : "John CPU → 7-Zip CPU（Hashcat CPU 可选）"

  return (
    <Card size="sm">
      <CardHeader className="border-b border-border/80">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <CardTitle>默认解密方式</CardTitle>
              <Badge variant="secondary">可在解压页快速切换</Badge>
            </div>
            <CardDescription>
              GPU 优先会自动回退 CPU；仅 CPU 模式不会启动 GPU 恢复进程。
            </CardDescription>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={engineBusy || settingsBusy}
            onClick={onRefresh}
          >
            重新探测
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <FieldSet disabled={settingsBusy || appSettings === null}>
          <FieldLegend className="sr-only">默认解密方式</FieldLegend>
          <RadioGroup
            value={appSettings?.recovery?.computeMode ?? "gpuPreferred"}
            onValueChange={(value) => onChange(value as RecoveryComputeMode)}
            className="grid gap-2 sm:grid-cols-2"
          >
            <FieldLabel htmlFor="compute-gpu">
              <Field orientation="horizontal">
                <Zap className="mt-0.5 size-4 shrink-0" />
                <FieldContent>
                  <FieldTitle>GPU 优先</FieldTitle>
                  <FieldDescription>
                    Hashcat GPU → {cpuRecoveryChain}
                  </FieldDescription>
                </FieldContent>
                <RadioGroupItem id="compute-gpu" value="gpuPreferred" />
              </Field>
            </FieldLabel>
            <FieldLabel htmlFor="compute-cpu">
              <Field orientation="horizontal">
                <Cpu className="mt-0.5 size-4 shrink-0" />
                <FieldContent>
                  <FieldTitle>仅 CPU</FieldTitle>
                  <FieldDescription>{cpuRecoveryChain}</FieldDescription>
                </FieldContent>
                <RadioGroupItem id="compute-cpu" value="cpuOnly" />
              </Field>
            </FieldLabel>
          </RadioGroup>
        </FieldSet>
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">
            恢复方式与可选能力
          </p>
          <div className="flex flex-wrap gap-1.5">
            {capabilities?.methods.map((method, index) => (
              <Badge
                key={method.id}
                title={method.message}
                style={{ animationDelay: `${Math.min(index, 4) * 45}ms` }}
                variant={
                  method.available
                    ? "outline"
                    : method.optional
                      ? "secondary"
                      : "warning"
                }
                className="animate-status-chip-enter motion-safe-only"
              >
                {method.label} ·{" "}
                {method.available
                  ? "可用"
                  : method.optional
                    ? "可选未启用"
                    : "未就绪"}
              </Badge>
            )) ?? <Badge variant="outline">正在探测…</Badge>}
          </div>
        </div>
        {message ? (
          <Alert
            variant={
              messageError
                ? "destructive"
                : settingsBusy
                  ? "default"
                  : "success"
            }
          >
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  )
}

export function FullBundleCard({
  status,
  busy,
  message,
  messageError,
  onInstall,
  onOpen,
}: {
  status: FullEngineBundleStatus | null
  busy: boolean
  message: string | null
  messageError: boolean
  onInstall: () => void
  onOpen: (path: string) => void
}) {
  return (
    <Card size="sm">
      <CardHeader className="border-b border-border/80">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>Windows x64 完整离线包</CardTitle>
              {status === null ? (
                <Badge variant="secondary">正在检测</Badge>
              ) : (
                <>
                  <Badge variant="secondary">
                    {status.bundled ? "资源已内置" : "精简构建"}
                  </Badge>
                  <Badge variant={status.installed ? "success" : "warning"}>
                    {status.installed ? "全部就绪" : "待部署"}
                  </Badge>
                </>
              )}
            </div>
            <CardDescription>
              安装器内包含 7-Zip、Hashcat、John CPU 引擎、Strawberry Perl，以及
              7z2john / rar2john / zip2john。部署时逐包校验
              SHA-256，再展开到可写工具目录。
            </CardDescription>
          </div>
          <Button
            size="sm"
            disabled={busy || !status?.bundled || !status?.platformSupported}
            onClick={onInstall}
          >
            <Package data-icon="inline-start" />
            {status === null
              ? "正在检测…"
              : status.installed
                ? "重新检测 / 补全"
                : "离线部署"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {status === null ? (
          <div
            className="flex min-h-24 items-center justify-center text-xs text-muted-foreground"
            aria-live="polite"
            aria-busy="true"
          >
            <span className="motion-safe:animate-pulse">
              正在检测完整包状态…
            </span>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5">
              {[
                { id: "7zip", component: status.sevenZip },
                { id: "hashcat", component: status.hashcat },
                { id: "john", component: status.john },
                { id: "perl", component: status.perl },
              ].map(({ id, component }) => (
                <Badge
                  key={id}
                  variant={component.runnable ? "outline" : "warning"}
                >
                  {component.name} {component.version} ·{" "}
                  {component.runnable ? "可运行" : "未就绪"}
                </Badge>
              ))}
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Badge variant={status.has7z2john ? "outline" : "warning"}>
                7z2john {status.has7z2john ? "可用" : "缺失"}
              </Badge>
              <Badge variant={status.hasRar2john ? "outline" : "warning"}>
                rar2john {status.hasRar2john ? "可用" : "缺失"}
              </Badge>
              <Badge variant={status.hasZip2john ? "outline" : "warning"}>
                zip2john {status.hasZip2john ? "可用" : "缺失"}
              </Badge>
              <Badge variant={status.johnCpuReady ? "outline" : "warning"}>
                CPU 回退 {status.johnCpuReady ? "可用" : "缺失"}
              </Badge>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {status.message} GPU 驱动、CUDA、HIP 与 OpenCL
              由系统提供，不进入发行包；无可用加速后端时使用 John CPU 回退。
            </p>
            <div className="flex flex-col gap-2 border-t pt-3">
              <p className="text-sm font-medium">7-Zip 运行诊断</p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {status.sevenZip.message}
              </p>
              <SettingsInfoRow
                icon={<HardDrive className="size-3.5" />}
                label="7z.exe"
                value={status.sevenZip.executablePath || "—"}
                action={
                  status.sevenZip.executablePath ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => onOpen(status.sevenZip.executablePath)}
                    >
                      <ExternalLink data-icon="inline-start" />
                      打开位置
                    </Button>
                  ) : undefined
                }
              />
            </div>
          </>
        )}
        {message ? (
          <Alert
            variant={
              messageError ? "destructive" : busy ? "default" : "success"
            }
          >
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  )
}

export function ToolsDirectoryCard({
  status,
  value,
  busy,
  onChange,
  onOpen,
  onSave,
  onReset,
}: {
  status: HashcatStatus | null
  value: string
  busy: boolean
  onChange: (value: string) => void
  onOpen: (path: string) => void
  onSave: () => void
  onReset: () => void
}) {
  const openPath = value.trim() || status?.defaultToolsDirectory || ""
  return (
    <Card size="sm">
      <CardHeader className="border-b border-border/80">
        <CardTitle>工具公共目录</CardTitle>
        <CardDescription>
          引擎下载安装的根目录。可设为公共/共享路径，供本机多处复用；留空则使用应用默认
          tools 目录。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Field>
          <FieldLabel htmlFor="tools-dir">公共目录（绝对路径）</FieldLabel>
          <InputGroup>
            <InputGroupInput
              id="tools-dir"
              value={value}
              onChange={(event) => onChange(event.target.value)}
              disabled={busy}
              placeholder={
                status?.defaultToolsDirectory || "留空 = 使用默认 tools 目录"
              }
              className="font-mono text-xs"
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                variant="outline"
                disabled={busy || !openPath}
                onClick={() => onOpen(openPath)}
              >
                <ExternalLink data-icon="inline-start" />
                跳转
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
          <FieldDescription>
            默认：{status?.defaultToolsDirectory || "—"}
          </FieldDescription>
          <FieldDescription>
            当前生效：{status?.toolsDirectory || "—"}
          </FieldDescription>
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy} onClick={onSave}>
            保存目录
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={onReset}>
            恢复默认
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

export function HashcatCard({
  status,
  busy,
  onDownload,
}: {
  status: HashcatStatus | null
  busy: boolean
  onDownload: () => void
}) {
  const ready = Boolean(status?.installed) || Boolean(status?.configuredExists)
  return (
    <Card size="sm">
      <CardHeader className="border-b border-border/80">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>hashcat</CardTitle>
              {status === null ? (
                <Badge variant="secondary">正在检测</Badge>
              ) : (
                <>
                  <Badge variant="secondary">v{status.version}</Badge>
                  <Badge variant={ready ? "success" : "warning"}>
                    {ready ? "已就绪" : "未安装"}
                  </Badge>
                </>
              )}
            </div>
            <CardDescription>
              完整发行包已内置固定版本；这里保留 GitHub
              下载作为精简构建或修复安装的后备路径。下载同样执行 SHA-256
              校验，不静默更新、不提权。
            </CardDescription>
          </div>
          <Button
            size="sm"
            disabled={busy || status === null}
            onClick={onDownload}
          >
            <Download data-icon="inline-start" />
            {status === null
              ? "正在检测…"
              : status.installed
                ? "重新检测 / 补全"
                : "下载并安装"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <SettingsInfoRow
          icon={<HardDrive className="size-3.5" />}
          label="可执行文件"
          value={status?.configuredPath || status?.executablePath || "—"}
        />
        <SettingsInfoRow
          icon={<HardDrive className="size-3.5" />}
          label="安装目录"
          value={status?.installDirectory || "—"}
        />
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <a
            href={status?.githubRepo ?? "https://github.com/hashcat/hashcat"}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-foreground underline-offset-4 hover:underline"
          >
            GitHub 仓库
            <ExternalLink className="size-3" />
          </a>
          <span aria-hidden>·</span>
          <a
            href={status?.downloadUrl}
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
  )
}

export function JohnPerlCard({
  status,
  johnDirectory,
  perlPath,
  busy,
  onJohnDirectoryChange,
  onPerlPathChange,
  onOpen,
  onProbe,
  onSave,
}: {
  status: JohnPerlStatus | null
  johnDirectory: string
  perlPath: string
  busy: boolean
  onJohnDirectoryChange: (value: string) => void
  onPerlPathChange: (value: string) => void
  onOpen: (path: string) => void
  onProbe: () => void
  onSave: () => void
}) {
  return (
    <Card size="sm">
      <CardHeader className="border-b border-border/80">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>John / Perl</CardTitle>
              {status === null ? (
                <Badge variant="secondary">正在检测</Badge>
              ) : (
                <Badge variant={status.ready ? "success" : "warning"}>
                  {status.ready ? "已就绪" : "未就绪"}
                </Badge>
              )}
            </div>
            <CardDescription>
              完整包会自动写入 John 工具目录与
              perl.exe；也可在此覆盖为自备版本。提供 7z2john、rar2john、zip2john
              哈希转换及 John CPU 回退。
            </CardDescription>
          </div>
          <div className="flex shrink-0 flex-wrap gap-1.5">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || status === null}
              onClick={onProbe}
            >
              重新检测
            </Button>
            <Button
              size="sm"
              disabled={busy || status === null}
              onClick={onSave}
            >
              保存
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Field>
          <FieldLabel htmlFor="john-dir">John 工具目录</FieldLabel>
          <InputGroup>
            <InputGroupInput
              id="john-dir"
              value={johnDirectory}
              onChange={(event) => onJohnDirectoryChange(event.target.value)}
              disabled={busy}
              placeholder="含 john / 7z2john / rar2john / zip2john 的目录"
              className="font-mono text-xs"
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                variant="outline"
                disabled={busy || !johnDirectory.trim()}
                onClick={() => onOpen(johnDirectory)}
              >
                <ExternalLink data-icon="inline-start" />
                跳转
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </Field>
        <Field>
          <FieldLabel htmlFor="perl-path">perl.exe 路径</FieldLabel>
          <InputGroup>
            <InputGroupInput
              id="perl-path"
              value={perlPath}
              onChange={(event) => onPerlPathChange(event.target.value)}
              disabled={busy}
              placeholder="可选；使用 7z2john.pl 时需要"
              className="font-mono text-xs"
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                variant="outline"
                disabled={busy || !perlPath.trim()}
                onClick={() => onOpen(perlPath)}
              >
                <ExternalLink data-icon="inline-start" />
                跳转
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </Field>
        {status === null ? (
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="secondary">正在检测组件…</Badge>
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            <Badge
              variant={status.sevenZipConverterReady ? "outline" : "warning"}
            >
              7z2john {status.sevenZipConverterReady ? "可用" : "缺失"}
            </Badge>
            <Badge variant={status.rarConverterReady ? "outline" : "warning"}>
              rar2john {status.rarConverterReady ? "可用" : "缺失"}
            </Badge>
            <Badge variant={status.zipConverterReady ? "outline" : "warning"}>
              zip2john {status.zipConverterReady ? "可用" : "缺失"}
            </Badge>
            <Badge variant={status.johnCpuReady ? "outline" : "warning"}>
              John CPU {status.johnCpuReady ? "可用" : "缺失"}
            </Badge>
            <Badge variant={status.perlExists ? "outline" : "warning"}>
              perl {status.perlExists ? "可用" : "未配置"}
            </Badge>
          </div>
        )}
        {status?.message ? (
          <p className="text-xs text-muted-foreground">{status.message}</p>
        ) : null}
      </CardContent>
    </Card>
  )
}
