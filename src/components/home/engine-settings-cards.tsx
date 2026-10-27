import { ExtractionLimitSettings } from "./desktop-settings"
import { WorkbenchDetailsActions } from "./workbench-details"
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
import { Spinner } from "@/components/ui/spinner"
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
import { Switch } from "@/components/ui/switch"
import type { RecoveryCapabilities, RecoveryComputeMode } from "@/lib/recovery"
import {
  type AppSettings,
  type FullEngineBundleStatus,
  type HashcatStatus,
  type JohnPerlStatus,
  DEFAULT_SCAN_MAX_FILES_PER_DIRECTORY,
  MAX_SCAN_MAX_FILES_PER_DIRECTORY,
} from "@/lib/settings"

type DefaultRecoveryProps = {
  appSettings: AppSettings | null
  capabilities: RecoveryCapabilities | null
  settingsBusy: boolean
  engineBusy: boolean
  message: string | null
  messageError: boolean
  onChange: (mode: RecoveryComputeMode) => void
  onRefresh: () => void
}

type ExtractionBehaviorProps = {
  scanLimitDirty: boolean
  onLimitsDirtyChange: (dirty: boolean) => void
  onLimitsBusyChange: (busy: boolean) => void
  onDiscardScanLimit: () => void
  appSettings: AppSettings | null
  settingsBusy: boolean
  message: string | null
  scanLimitValue: string
  onScanLimitChange: (value: string) => void
  onSaveScanLimit: () => void
  onRemoveEmptyDirectoriesChange: (value: boolean) => void
  onFlattenOutputDirectoriesChange: (value: boolean) => void
}

export function DefaultRecoveryCard({
  appSettings,
  capabilities,
  settingsBusy,
  engineBusy,
  message,
  messageError,
  onChange,
  onRefresh,
}: DefaultRecoveryProps) {
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
            </div>
            <CardDescription>
              GPU 不可用或失败时，自动使用 CPU。
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

export function ExtractionBehaviorSettings({
  scanLimitDirty,
  onLimitsDirtyChange,
  onLimitsBusyChange,
  onDiscardScanLimit,
  appSettings,
  settingsBusy,
  message,
  scanLimitValue,
  onScanLimitChange,
  onSaveScanLimit,
  onRemoveEmptyDirectoriesChange,
  onFlattenOutputDirectoriesChange,
}: ExtractionBehaviorProps) {
  return (
    <>
      <Card size="sm">
        <CardHeader className="border-b border-border/80">
          <CardTitle>解压后整理</CardTitle>
          <CardDescription>自动保存，下次任务生效。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="remove-empty-directories">
                智能清理空文件夹
              </FieldLabel>
              <FieldDescription id="remove-empty-directories-help">
                清理本次解压产生的空文件夹，保留已有目录和所有文件。
              </FieldDescription>
              <details className="text-sm text-muted-foreground">
                <summary className="cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-ring">
                  查看整理规则
                </summary>
                <p className="mt-2">
                  解压成功后，从内向外清理本次产生的多层空文件夹。保留文件、目录链接、
                  输出根目录、原有目录和带附加数据的目录，不移动文件。下次任务生效。
                </p>
              </details>
            </FieldContent>
            <Switch
              id="remove-empty-directories"
              aria-describedby="remove-empty-directories-help"
              checked={appSettings?.recovery?.removeEmptyDirectories ?? true}
              disabled={settingsBusy || appSettings === null}
              onCheckedChange={onRemoveEmptyDirectoriesChange}
            />
          </Field>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="flatten-output-directories">
                去除多层无效嵌套
              </FieldLabel>
              <FieldDescription id="flatten-output-directories-help">
                整理输出顶部重复的同名目录，保留普通目录结构。
              </FieldDescription>
              <details className="text-sm text-muted-foreground">
                <summary className="cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-ring">
                  查看整理规则
                </summary>
                <p className="mt-2">
                  仅整理新建解压目录顶部连续至少两层、与压缩包同名的重复目录，并保留一层原名。
                  普通目录层级、已有输出目录和含链接或附加数据的目录保持原样。默认开启；需完整保留原始路径时请关闭，下次任务生效。
                </p>
              </details>
            </FieldContent>
            <Switch
              id="flatten-output-directories"
              aria-describedby="flatten-output-directories-help"
              checked={appSettings?.recovery?.flattenOutputDirectories ?? true}
              disabled={settingsBusy || appSettings === null}
              onCheckedChange={onFlattenOutputDirectoriesChange}
            />
          </Field>
        </CardContent>
      </Card>
      <Card size="sm">
        <CardHeader className="border-b border-border/80">
          <CardTitle>扫描与安全限制</CardTitle>
          <CardDescription>
            修改后分别保存；可撤销尚未保存的修改。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <form
            id="recovery-scan-limit-form"
            onSubmit={(event) => {
              event.preventDefault()
              onSaveScanLimit()
            }}
          >
            <Field>
              <FieldLabel htmlFor="recursive-scan-file-limit">
                目录扫描文件数上限
              </FieldLabel>
              {scanLimitDirty ? <Badge variant="warning">未保存</Badge> : null}
              <FieldDescription id="recursive-scan-file-limit-help">
                默认 {DEFAULT_SCAN_MAX_FILES_PER_DIRECTORY}
                。直属文件超过上限时，跳过该目录及其子目录的嵌套压缩包扫描，保留已解压内容。设为
                0 不限制，下次任务生效。
              </FieldDescription>
              <div className="flex flex-wrap items-center gap-2">
                <InputGroup className="w-40">
                  <InputGroupInput
                    id="recursive-scan-file-limit"
                    data-settings-pending={scanLimitDirty || undefined}
                    type="number"
                    min={0}
                    max={MAX_SCAN_MAX_FILES_PER_DIRECTORY}
                    step={1}
                    required
                    value={scanLimitValue}
                    onChange={(event) => onScanLimitChange(event.target.value)}
                    aria-describedby="recursive-scan-file-limit-help"
                    disabled={settingsBusy || appSettings === null}
                  />
                </InputGroup>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="submit"
                    form="recovery-scan-limit-form"
                    className="min-w-24 scroll-my-4"
                    variant="outline"
                    size="sm"
                    disabled={settingsBusy || appSettings === null}
                    aria-busy={settingsBusy && message === "正在保存扫描上限…"}
                  >
                    {settingsBusy && message === "正在保存扫描上限…" ? (
                      <Spinner aria-hidden="true" data-icon="inline-start" />
                    ) : null}
                    {settingsBusy && message === "正在保存扫描上限…"
                      ? "保存中…"
                      : "保存上限"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={settingsBusy || !scanLimitDirty}
                    onClick={onDiscardScanLimit}
                  >
                    撤销修改
                  </Button>
                </div>
              </div>
            </Field>
            {message && !settingsBusy ? (
              <p
                role="status"
                className="max-h-20 w-full overflow-y-auto text-sm break-words text-muted-foreground"
              >
                {message}
              </p>
            ) : null}
          </form>
          <ExtractionLimitSettings
            onDirtyChange={onLimitsDirtyChange}
            onBusyChange={onLimitsBusyChange}
          />
        </CardContent>
      </Card>
    </>
  )
}

export function FullBundleCard({
  status,
  busy,
  onInstall,
  onOpen,
}: {
  status: FullEngineBundleStatus | null
  busy: boolean
  onInstall: () => void
  onOpen: (path: string) => void
}) {
  return (
    <Card size="sm" className="drawer-section">
      <CardHeader className="border-b border-border/80">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">Windows x64</Badge>
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
              离线安装 7-Zip、Hashcat、John 和 Perl，自动校验完整性。
            </CardDescription>
          </div>
          <WorkbenchDetailsActions>
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
          </WorkbenchDetailsActions>
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
              {status.message} GPU 驱动需自行安装；无可用 GPU 时使用 CPU。
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
      </CardContent>
    </Card>
  )
}

export function ToolsDirectoryCard({
  status,
  dirty,
  onDiscard,
  value,
  busy,
  onChange,
  onOpen,
  onSave,
  onReset,
}: {
  status: HashcatStatus | null
  value: string
  dirty: boolean
  onDiscard: () => void
  busy: boolean
  onChange: (value: string) => void
  onOpen: (path: string) => void
  onSave: () => void
  onReset: () => void
}) {
  const openPath = value.trim() || status?.defaultToolsDirectory || ""
  return (
    <Card size="sm" className="drawer-section">
      <CardHeader className="border-b border-border/80">
        <CardDescription>引擎安装位置；留空使用默认目录。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          修改后保存；关闭面板会保留草稿。
        </p>
        {dirty ? <Badge variant="warning">未保存</Badge> : null}
        <Field>
          <FieldLabel htmlFor="tools-dir">公共目录（绝对路径）</FieldLabel>
          <InputGroup>
            <InputGroupInput
              id="tools-dir"
              data-settings-pending={dirty || undefined}
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
        <WorkbenchDetailsActions>
          <Button size="sm" disabled={busy || !dirty} onClick={onSave}>
            保存目录
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={onReset}>
            恢复默认
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || !dirty}
            onClick={onDiscard}
          >
            撤销修改
          </Button>
        </WorkbenchDetailsActions>
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
    <Card size="sm" className="drawer-section">
      <CardHeader className="border-b border-border/80">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
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
              从 GitHub 下载并校验，用于补装或修复 Hashcat。
            </CardDescription>
          </div>
          <WorkbenchDetailsActions>
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
          </WorkbenchDetailsActions>
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
  dirty,
  onDiscard,
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
  dirty: boolean
  onDiscard: () => void
  busy: boolean
  onJohnDirectoryChange: (value: string) => void
  onPerlPathChange: (value: string) => void
  onOpen: (path: string) => void
  onProbe: () => void
  onSave: () => void
}) {
  return (
    <Card size="sm" className="drawer-section">
      <CardHeader className="border-b border-border/80">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              {status === null ? (
                <Badge variant="secondary">正在检测</Badge>
              ) : (
                <Badge variant={status.ready ? "success" : "warning"}>
                  {status.ready ? "已就绪" : "未就绪"}
                </Badge>
              )}
            </div>
            <CardDescription>
              离线包自动配置路径；使用自备 John 或 Perl 时可在此修改。
            </CardDescription>
          </div>
          <WorkbenchDetailsActions>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || status === null}
              onClick={onProbe}
            >
              检测已保存配置
            </Button>
            <Button
              size="sm"
              disabled={busy || status === null || !dirty}
              onClick={onSave}
            >
              保存
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || !dirty}
              onClick={onDiscard}
            >
              撤销修改
            </Button>
          </WorkbenchDetailsActions>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          修改后保存；关闭面板会保留草稿。
        </p>
        {dirty ? <Badge variant="warning">未保存</Badge> : null}
        <Field>
          <FieldLabel htmlFor="john-dir">John 工具目录</FieldLabel>
          <InputGroup>
            <InputGroupInput
              id="john-dir"
              data-settings-pending={
                johnDirectory !== (status?.johnToolsDirectory ?? "") ||
                undefined
              }
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
              data-settings-pending={
                perlPath !== (status?.perlPath ?? "") || undefined
              }
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
