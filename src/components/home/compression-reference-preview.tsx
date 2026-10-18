import { ChevronDown, FileText, RefreshCw } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Spinner } from "@/components/ui/spinner"
import type { AiReferencePreviewController } from "@/hooks/use-ai-reference-preview"

export function CompressionReferencePreview({
  preview,
  hasSources,
  hasExtensions,
  disabled,
}: {
  preview: AiReferencePreviewController
  hasSources: boolean
  hasExtensions: boolean
  disabled: boolean
}) {
  return (
    <section
      aria-label="AI 参考文件内容预览"
      className="grid min-w-0 gap-2 rounded-xl border border-border/80 p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium">
          准备读取的参考文件
          {!preview.loading && preview.files.length > 0 ? (
            <span className="ml-1.5 text-muted-foreground">
              已选 {preview.selectedPaths.length} / {preview.files.length} 个
            </span>
          ) : null}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={
            disabled ||
            preview.loading ||
            !preview.supported ||
            !hasSources ||
            !hasExtensions
          }
          onClick={preview.refresh}
          aria-label="刷新参考文件预览"
        >
          <RefreshCw aria-hidden />
          刷新
        </Button>
      </div>
      {preview.loading ? (
        <p
          role="status"
          className="flex items-center gap-1.5 text-xs text-muted-foreground"
        >
          <Spinner />
          正在读取参考文件…
        </p>
      ) : preview.error ? (
        <p role="alert" className="text-xs text-destructive">
          {preview.error}
        </p>
      ) : !preview.supported ? (
        <p className="text-xs text-muted-foreground">
          文件内容预览需要在桌面版中使用。
        </p>
      ) : !hasSources ? (
        <p className="text-xs text-muted-foreground">
          添加压缩来源后，将在此列出参与命名的文本。
        </p>
      ) : !hasExtensions ? (
        <p className="text-xs text-muted-foreground">
          请选择至少一种参考文件后缀。
        </p>
      ) : preview.files.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          未找到可读的匹配文本，将仅参考归档基础名称。
        </p>
      ) : (
        <div className="grid min-w-0 gap-1.5">
          {preview.files.map((file, index) => (
            <Collapsible
              key={file.sourcePath}
              defaultOpen={index === 0}
              className="min-w-0 rounded-lg border border-border/70"
            >
              <div className="flex min-w-0 items-center gap-1 pl-3">
                <Checkbox
                  aria-label={`将 ${file.fileName} 用于 AI 命名`}
                  title={file.sourcePath}
                  checked={preview.selectedPaths.includes(file.sourcePath)}
                  onCheckedChange={(checked) =>
                    preview.setSelected(file.sourcePath, checked)
                  }
                  disabled={disabled || preview.loading}
                />
                <CollapsibleTrigger
                  className="group flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                  aria-label={`查看 ${file.fileName} 内容`}
                >
                  <FileText
                    aria-hidden
                    className="size-3.5 shrink-0 text-muted-foreground"
                  />
                  <span
                    className="min-w-0 flex-1 truncate"
                    title={file.sourcePath}
                  >
                    {file.fileName}
                  </span>
                  {file.truncated ? (
                    <Badge variant="secondary">已截取</Badge>
                  ) : null}
                  <ChevronDown
                    aria-hidden
                    className="size-3.5 shrink-0 transition-transform group-aria-expanded:rotate-180"
                  />
                </CollapsibleTrigger>
              </div>
              <CollapsibleContent>
                <div className="grid min-w-0 gap-2 border-t border-border/70 p-2.5">
                  <p className="text-xs break-all text-muted-foreground">
                    {file.sourcePath}
                  </p>
                  <pre
                    aria-label={`${file.fileName} 内容摘录`}
                    className="max-h-44 overflow-y-auto rounded-md bg-muted/50 p-2 text-xs leading-relaxed [overflow-wrap:anywhere] break-words whitespace-pre-wrap"
                  >
                    {file.content}
                  </pre>
                </div>
              </CollapsibleContent>
            </Collapsible>
          ))}
        </div>
      )}
      {preview.files.length > 0 ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          仅勾选文件的内容用于 AI 命名；全部取消后仅参考归档基础名称。
          展开可查看本地文本摘录，文件修改后可点击刷新。
        </p>
      ) : null}
    </section>
  )
}
