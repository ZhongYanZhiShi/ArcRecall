"use client"

import { useAppUpdate } from "@/components/update-provider"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Alert, AlertDescription } from "@/components/ui/alert"

export function AppUpdateDetails({ onClose }: { onClose?: () => void }) {
  const {
    status,
    error,
    loaded,
    busy,
    check,
    download,
    install,
    taskBlocked,
    reminder,
    setReminder,
    installGuard,
    setOpen,
  } = useAppUpdate()
  const failure = error ?? status.error
  const ready = status.phase === "ready"
  const downloading = status.phase === "downloading"
  let notes = status.notes
  let notesVersion = status.version
  if (!notes && loaded) {
    try {
      const previous = JSON.parse(
        localStorage.getItem("app-update-last-release") ?? "null"
      )
      if (
        previous?.version === status.currentVersion &&
        typeof previous.notes === "string"
      ) {
        notes = previous.notes
        notesVersion = previous.version
      }
    } catch {
      /* Release notes are optional. */
    }
  }
  const progress = status.totalBytes
    ? Math.min(100, (status.downloadedBytes / status.totalBytes) * 100)
    : null
  const messages = {
    idle: "检查是否有新版本。",
    checking: "正在检查更新…",
    current: "当前已是最新版本。",
    available: `新版本 v${status.version} 可供下载。`,
    downloading: "正在后台下载，你可以继续使用。",
    ready: `版本 v${status.version} 已下载并通过签名校验。`,
    installing: "正在打开独立更新窗口，准备完成后本窗口将关闭…",
    error: "暂时无法检查更新，可以稍后重试。",
  }
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p className="text-sm text-muted-foreground" role="status">
        {loaded ? messages[status.phase] : "正在读取更新状态…"}
      </p>
      {downloading && (
        <div className="flex flex-col gap-2">
          <Progress aria-label="更新下载进度" value={progress} />
          <p className="text-xs text-muted-foreground tabular-nums">
            已下载 {(status.downloadedBytes / 1024 / 1024).toFixed(1)} MiB
            {progress !== null && ` · ${Math.floor(progress)}%`}
          </p>
        </div>
      )}
      {notes && (
        <section className="flex flex-col gap-2 text-sm" aria-label="更新说明">
          <h3 className="font-medium">本次更新</h3>
          <p className="line-clamp-3 break-words whitespace-pre-wrap text-muted-foreground">
            {notes}
          </p>
          <details>
            <summary className="cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-ring">
              查看 v{notesVersion} 完整更新说明
            </summary>
            <p className="mt-2 max-h-48 overflow-y-auto break-words whitespace-pre-wrap text-muted-foreground">
              {notes}
            </p>
          </details>
        </section>
      )}
      {failure && (
        <Alert variant="warning">
          <AlertDescription className="break-words">
            更新未完成，当前版本仍可使用。
            <details>
              <summary className="cursor-pointer">查看原因</summary>
              <p>{failure}</p>
            </details>
          </AlertDescription>
        </Alert>
      )}
      {ready && (
        <>
          <p className="text-sm">
            安装时将打开独立更新窗口，显示安装与启动状态。完成后自动打开新版，保留本机设置、字典和历史记录。
          </p>
          {status.cached && (
            <p className="text-xs text-muted-foreground">
              更新包已保存在本机，下次打开仍可安装。
            </p>
          )}
          {status.cacheWarning && (
            <p className="text-sm text-muted-foreground">
              {status.cacheWarning}
            </p>
          )}
          {taskBlocked && (
            <p className="text-sm" role="status">
              存在运行中的任务、数据维护或待处理队列。请完成任务或移除待处理项后安装。
            </p>
          )}
          {installGuard && (
            <Alert variant="warning">
              <AlertDescription>
                {installGuard.reason}
                <Button
                  variant="link"
                  onClick={() => {
                    setOpen(false)
                    installGuard.resolve()
                  }}
                >
                  返回处理
                </Button>
              </AlertDescription>
            </Alert>
          )}
        </>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {onClose && (
          <Button variant="ghost" onClick={onClose}>
            稍后
          </Button>
        )}
        {ready ? (
          taskBlocked ? (
            <Button variant="outline" onClick={() => setReminder(!reminder)}>
              {reminder ? "取消完成提醒" : "完成后提醒我"}
            </Button>
          ) : (
            <Button
              disabled={busy || !!installGuard}
              onClick={() => void install()}
            >
              {busy ? "正在处理…" : failure ? "重试安装并重启" : "安装并重启"}
            </Button>
          )
        ) : status.phase === "available" ? (
          <Button disabled={busy} onClick={() => void download()}>
            {failure ? "重新下载" : "下载更新"}
          </Button>
        ) : (
          !downloading &&
          status.phase !== "installing" && (
            <Button
              variant="outline"
              disabled={!loaded || !status.configured || busy}
              onClick={() => void check()}
            >
              {status.phase === "checking"
                ? "正在检查…"
                : failure
                  ? "重新检查"
                  : "检查更新"}
            </Button>
          )
        )}
      </div>
      {status.lastChecked && (
        <p className="text-xs text-muted-foreground">
          上次成功检查：{new Date(status.lastChecked).toLocaleString("zh-CN")}
        </p>
      )}
    </div>
  )
}
