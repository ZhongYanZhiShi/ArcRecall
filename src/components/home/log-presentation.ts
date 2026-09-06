import type { LogEntry } from "@/lib/logging"

const PHASE_LABELS: Record<string, string> = {
  preparing: "准备任务",
  verifying: "验证密码",
  converting: "转换压缩包哈希",
  hashcat: "使用 Hashcat 恢复密码",
  john: "使用 John 恢复密码",
  internal: "尝试候选密码",
  extracting: "解压文件",
  recursive: "扫描嵌套压缩包",
  completed: "完成任务",
  exhausted: "结束候选尝试",
  cancelled: "取消任务",
  failed: "处理失败",
}

const CONTEXT_LABELS: Record<string, string> = {
  added_count: "新增",
  deleted_count: "删除",
  duplicate_count: "重复",
  invalid_count: "无效",
  submitted_count: "提交",
  requested_count: "请求",
  byte_count: "数据量",
  entry_count: "记录",
  removed_file_count: "删除文件",
  log_level: "日志级别",
  log_max_disk_mib: "容量上限",
}

const ROUTINE_DETAIL_EVENTS = new Set([
  "app.started",
  "archive.analyzed",
  "logs.ready",
  "recovery.requested",
  "recovery.phase_changed",
  "settings.saved",
])

const TRAILING_SENTENCE_PATTERN = /[。；;]+$/

export type PresentedLogEntry = {
  title: string
  description?: string
}

export function isRoutineLogDetail(entry: LogEntry): boolean {
  return entry.level === "debug" || ROUTINE_DETAIL_EVENTS.has(entry.event)
}

export function presentLogEntry(entry: LogEntry): PresentedLogEntry {
  const engine = entry.context.engine
  const nestedExtracted = parseCount(entry.context.nested_extracted)
  const nestedSkipped = parseCount(entry.context.nested_skipped)

  switch (entry.event) {
    case "app.started":
      return {
        title: "ArcRecall 已启动",
        description: joinSummary([
          entry.context.version ? `版本 ${entry.context.version}` : undefined,
          entry.context.platform
            ? `运行环境 ${entry.context.platform}`
            : undefined,
        ]),
      }
    case "logs.ready":
      return {
        title: "日志功能已就绪",
        description: entry.context.retention
          ? `当前保留策略：${entry.context.retention}`
          : undefined,
      }
    case "recovery.requested":
      return {
        title: "已收到恢复与解压请求",
        description:
          entry.context.mode === "known"
            ? "使用手动输入的密码优先验证"
            : "将在需要时使用候选字典恢复密码",
      }
    case "archive.analyzed":
      return {
        title: "压缩包分析完成",
        description: entry.context.format
          ? `识别为 ${entry.context.format} 格式`
          : undefined,
      }
    case "recovery.started":
      return {
        title: "开始恢复与解压",
        description: joinSummary([
          entry.context.archive_format
            ? `压缩格式 ${entry.context.archive_format}`
            : undefined,
          entry.context.candidate_count
            ? `候选密码 ${entry.context.candidate_count} 条`
            : undefined,
        ]),
      }
    case "recovery.phase_changed": {
      const phase = phaseLabel(entry.context.phase)
      return {
        title: phase ? `正在${phase}` : "恢复任务进入下一阶段",
        description: joinSummary([
          engine ? `使用 ${engine}` : undefined,
          "这是故障排查用的过程记录",
        ]),
      }
    }
    case "recovery.completed":
      return {
        title: "恢复与解压完成",
        description: joinSummary([
          engine ? `使用 ${engine}` : undefined,
          nestedExtracted > 0
            ? `处理了 ${nestedExtracted} 个嵌套压缩包`
            : "没有需要处理的嵌套压缩包",
          nestedSkipped > 0 ? `${nestedSkipped} 个嵌套压缩包未处理` : undefined,
        ]),
      }
    case "recovery.cancel_requested":
      return {
        title: "正在停止恢复任务",
        description: "已向外部引擎发送取消请求",
      }
    case "recovery.cancelled":
      return { title: "恢复任务已取消" }
    case "recovery.unsuccessful":
      return {
        title: "未找到可用密码",
        description: engine ? `已使用 ${engine} 完成当前候选尝试` : undefined,
      }
    case "recovery.failed":
      return {
        title: "恢复与解压失败",
        description: "展开技术详情可获取用于排查的事件编号",
      }
    case "database.backup_completed":
      return {
        title: "数据库备份已创建",
        description: entry.context.byte_count
          ? `备份大小 ${formatBytes(Number(entry.context.byte_count))}`
          : undefined,
      }
    case "logs.exported":
      return {
        title: "日志已导出",
        description: entry.context.entry_count
          ? `共导出 ${entry.context.entry_count} 条记录`
          : undefined,
      }
    case "logs.cleared":
      return { title: "历史日志已清空" }
    case "settings.saved":
      return { title: "应用设置已保存" }
    default:
      return {
        title: trimSentence(entry.message),
        description: genericContextSummary(entry.context),
      }
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "0 B"
  }
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

function phaseLabel(phase: string | undefined): string | undefined {
  if (!phase) {
    return undefined
  }
  return PHASE_LABELS[phase] ?? phase
}

function genericContextSummary(
  context: Record<string, string>
): string | undefined {
  const parts = Object.entries(context)
    .filter(([key]) => key in CONTEXT_LABELS)
    .slice(0, 3)
    .map(([key, value]) => {
      if (key === "byte_count") {
        return `${CONTEXT_LABELS[key]} ${formatBytes(Number(value))}`
      }
      if (key === "log_max_disk_mib") {
        return `${CONTEXT_LABELS[key]} ${value} MiB`
      }
      return `${CONTEXT_LABELS[key]} ${value}`
    })
  return parts.length ? parts.join(" · ") : undefined
}

function joinSummary(parts: Array<string | undefined>): string | undefined {
  const summary = parts.filter((part): part is string => Boolean(part))
  return summary.length ? summary.join(" · ") : undefined
}

function parseCount(value: string | undefined): number {
  const count = Number(value ?? 0)
  return Number.isFinite(count) ? count : 0
}

function trimSentence(message: string): string {
  return message.trim().replace(TRAILING_SENTENCE_PATTERN, "")
}
