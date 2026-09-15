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
      description: "请前往引擎设置重新检测。",
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
          ? "无可用 CPU 引擎，请在设置中补全。"
          : "无可用恢复引擎，请在设置中补全。",
      reasons,
    }
  }

  if (
    computeMode === "gpuPreferred" &&
    !capabilities.gpuAvailable &&
    capabilities.cpuAvailable
  ) {
    return {
      title: "GPU 未就绪，将使用 CPU",
      description: "可前往设置启用 GPU 加速。",
      reasons,
    }
  }

  if (
    computeMode === "gpuPreferred" &&
    capabilities.gpuAvailable &&
    !capabilities.cpuAvailable
  ) {
    return {
      title: "CPU 未就绪，GPU 可用",
      description: "补全 CPU 引擎后，可在 GPU 不可用时继续恢复。",
      reasons,
    }
  }

  return {
    title:
      computeMode === "cpuOnly" ? "部分 CPU 引擎未就绪" : "部分回退引擎未就绪",
    description:
      computeMode === "cpuOnly"
        ? "可继续使用现有 CPU 引擎；补全后可支持更多格式。"
        : "可继续使用现有引擎；补全后可在失败时自动切换。",
    reasons,
  }
}
