import type { TaskRecord } from "./workflows"

export function buildRecordRetryPlan(
  record: TaskRecord,
  paths: string[],
  root: boolean,
  options: { password: string; output: string | null; group: string | null }
) {
  if (record.operation === "compression")
    throw new Error("请先将压缩记录加载到压缩页，再确认并开始。")
  if (record.operation === "batchIntegrityCheck")
    return { kind: "batch" as const, paths, password: options.password }
  if (
    record.operation === "selectiveExtraction" ||
    record.operation === "integrityCheck"
  )
    return {
      kind: "action" as const,
      path: record.archivePath,
      password: options.password,
      selectedPaths:
        record.operation === "selectiveExtraction"
          ? (record.selectedPaths ?? [])
          : null,
      output: options.output,
    }
  return {
    kind: "recovery" as const,
    paths,
    options: {
      recursive: record.recursive,
      computeMode: record.computeMode,
      dictionaryGroup: options.group,
      knownPassword: options.password || null,
      ...(root && !options.output && record.outputDirectory
        ? { exactOutputDirectory: record.outputDirectory }
        : { outputDirectory: options.output }),
    },
  }
}
