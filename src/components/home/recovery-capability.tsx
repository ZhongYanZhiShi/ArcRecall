import { Check, CircleAlert, Settings2 } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type {
  RecoveryCapabilities,
  RecoveryComputeMode,
  RecoveryMethodCapability,
} from "@/lib/recovery"

type CapabilityNotice = {
  title: string
  description: string
  reasons: string[]
}

export function RecoveryCapabilityBadge({
  method,
}: {
  method: RecoveryMethodCapability
}) {
  const status = !method.supported
    ? "不支持"
    : method.available
      ? "可用"
      : method.optional
        ? "可选未启用"
        : "未就绪"

  return (
    <Badge
      variant={
        !method.supported
          ? "secondary"
          : method.available
            ? "outline"
            : method.optional
              ? "secondary"
              : "warning"
      }
      className="font-normal"
      aria-label={`${method.label}，${status}。${method.message}`}
    >
      {method.available ? (
        <Check data-icon="inline-start" aria-hidden />
      ) : method.supported && !method.optional ? (
        <CircleAlert data-icon="inline-start" aria-hidden />
      ) : null}
      {method.label} · {status}
    </Badge>
  )
}

export function RecoveryCapabilityNotice({
  capabilities,
  computeMode,
  error,
  onOpenEngineSettings,
}: {
  capabilities: RecoveryCapabilities | null
  computeMode: RecoveryComputeMode
  error: string | null
  onOpenEngineSettings: () => void
}) {
  const notice = resolveRecoveryCapabilityNotice(
    capabilities,
    computeMode,
    error
  )
  if (!notice) {
    return null
  }

  return (
    <Alert className="border-warning/25 bg-warning/8 text-warning-foreground">
      <CircleAlert aria-hidden />
      <AlertTitle>{notice.title}</AlertTitle>
      <AlertDescription className="space-y-2 text-pretty text-warning-foreground/90">
        <p>{notice.description}</p>
        {notice.reasons.length > 0 ? (
          <ul className="list-disc space-y-1 pl-4">
            {notice.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onOpenEngineSettings}
        >
          <Settings2 data-icon="inline-start" />
          前往解密引擎设置
        </Button>
      </AlertDescription>
    </Alert>
  )
}

export function resolveRecoveryCapabilityNotice(
  capabilities: RecoveryCapabilities | null,
  computeMode: RecoveryComputeMode,
  error: string | null
): CapabilityNotice | null {
  if (error) {
    return {
      title: "能力探测失败",
      description: "暂时无法确认可用的计算设备与引擎，请前往设置重新检测。",
      reasons: [error],
    }
  }
  if (!capabilities) {
    return null
  }

  const relevantMethods = capabilities.methods.filter(
    (method) =>
      method.supported &&
      (computeMode === "gpuPreferred" || method.device === "cpu")
  )
  const unavailableMethods = relevantMethods.filter(
    (method) => !method.available && !method.optional
  )
  if (unavailableMethods.length === 0) {
    return null
  }

  const reasons = Array.from(
    new Set(
      unavailableMethods.map((method) => method.message.trim()).filter(Boolean)
    )
  )
  const usableForMode =
    computeMode === "cpuOnly"
      ? capabilities.cpuAvailable
      : capabilities.gpuAvailable || capabilities.cpuAvailable

  if (!usableForMode) {
    return {
      title: "密码恢复引擎未就绪",
      description:
        computeMode === "cpuOnly"
          ? "当前未检测到可用的 CPU 恢复引擎，自动密码恢复能力受限。"
          : "当前未检测到可用的 GPU 或 CPU 恢复引擎，自动密码恢复能力受限。",
      reasons,
    }
  }

  if (
    computeMode === "gpuPreferred" &&
    !capabilities.gpuAvailable &&
    capabilities.cpuAvailable
  ) {
    return {
      title: "GPU 未就绪，仍可使用 CPU 回退",
      description:
        "任务会自动使用当前可用的 CPU 引擎；可前往设置补全 GPU 加速能力。",
      reasons,
    }
  }

  if (
    computeMode === "gpuPreferred" &&
    capabilities.gpuAvailable &&
    !capabilities.cpuAvailable
  ) {
    return {
      title: "CPU 回退未就绪，GPU 仍可使用",
      description:
        "当前可以使用 GPU 恢复；建议补全 CPU 引擎，以便 GPU 不可用时自动回退。",
      reasons,
    }
  }

  return {
    title:
      computeMode === "cpuOnly" ? "部分 CPU 引擎未就绪" : "部分回退引擎未就绪",
    description:
      computeMode === "cpuOnly"
        ? "当前仍可使用已就绪的 CPU 引擎；补全其他引擎可提高格式兼容性。"
        : "当前仍可使用已就绪的恢复引擎；补全回退能力可提高任务稳定性。",
    reasons,
  }
}
