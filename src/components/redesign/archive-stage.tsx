"use client"

import * as React from "react"

import {
  archiveNameFromPath,
  formatFileSize,
} from "@/components/home/recovery-view-utils"
import type { ArchiveAnalysis, RecoveryTaskStatus } from "@/lib/recovery"

type ArchiveLayer = {
  id: string
  name: string
  depth: number | null
  format?: string
  size?: string
  state: "unknown" | "done" | "running" | "blocked" | "waiting"
  progress?: number
}

/** Only paths observed by the real task appear here; unopened contents stay unknown. */
export function ArchiveStage({
  analysis,
  task,
}: {
  analysis: ArchiveAnalysis | null
  task: RecoveryTaskStatus | null
}) {
  const root = task?.archivePath ?? analysis?.archivePath
  const rootAnalysis = analysis?.archivePath === root ? analysis : null
  const layers = React.useMemo<ArchiveLayer[]>(() => {
    if (!root)
      return [
        {
          id: "unopened",
          depth: null,
          name: "等待选择压缩包",
          state: "unknown",
        },
      ]
    const completed = new Set(task?.completedArchivePaths ?? [])
    if (task?.rootExtractionCompleted) completed.add(root)
    const skipped = new Set(task?.skippedArchivePaths ?? [])
    const paths = [
      ...new Set(
        [
          root,
          task?.currentArchivePath,
          ...completed,
          ...(task?.pendingArchivePaths ?? []),
          ...skipped,
        ].filter((path): path is string => Boolean(path))
      ),
    ]
    return paths.map((path) => {
      const current =
        path === task?.currentArchivePath ||
        (path === root && !task?.currentArchivePath)
      const state = completed.has(path)
        ? "done"
        : current && task?.running
          ? "running"
          : skipped.has(path) ||
              (current && task?.completed && !task.success && !task.cancelled)
            ? "blocked"
            : "waiting"
      return {
        id: path,
        name: archiveNameFromPath(path),
        depth:
          path === root
            ? 0
            : (task?.events.find((event) => event.archivePath === path)
                ?.recursiveDepth ??
              (current ? task?.recursiveDepth : null) ??
              null),
        format:
          path === root
            ? (rootAnalysis?.formatLabel ?? task?.archiveFormatLabel)
            : current
              ? (task?.currentArchiveFormatLabel ?? undefined)
              : undefined,
        size:
          path === root && rootAnalysis
            ? formatFileSize(rootAnalysis.fileSize)
            : undefined,
        state,
        progress:
          state === "running" && task?.dictionaryProgress?.percent != null
            ? Math.max(0, Math.min(1, task.dictionaryProgress.percent / 100))
            : undefined,
      }
    })
  }, [root, rootAnalysis, task])

  return (
    <div className="min-w-0" data-slot="archive-stage">
      <ol className="byte-layers" aria-label="已识别归档层级">
        {layers.map((layer) => (
          <li
            key={layer.id}
            data-archive-path={layer.id}
            data-state={layer.state}
            data-depth={layer.depth ?? undefined}
            className="byte-layer"
          >
            <span className="byte-layer-depth font-mono text-muted-foreground">
              {layer.depth === null ? "—" : `L${layer.depth + 1}`}
            </span>
            <span className="byte-layer-format font-mono text-primary">
              {layer.format ?? "—"}
            </span>
            <span
              className="min-w-0 truncate"
              title={root ? layer.id : undefined}
            >
              {layer.name}
              {layer.size ? (
                <span className="ml-3 font-mono text-xs text-muted-foreground">
                  {layer.size}
                </span>
              ) : null}
            </span>
            <span className="byte-layer-status font-mono text-xs">
              {layer.state === "done"
                ? "✓ 已解包"
                : layer.state === "running"
                  ? layer.progress !== undefined
                    ? `${Math.round(layer.progress * 100)}%`
                    : "处理中"
                  : layer.state === "blocked"
                    ? "待处理"
                    : "—"}
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}
