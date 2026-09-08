type RefreshJob = {
  run: () => Promise<void>
  resolve: () => void
  reject: (reason: unknown) => void
}

/** One active request and at most one pending refresh, using the latest query. */
export function createRefreshQueue() {
  let running = false
  let pending: RefreshJob | null = null

  const clearPending = () => {
    pending?.resolve()
    pending = null
  }

  const drain = async () => {
    running = true
    while (pending) {
      const job: RefreshJob = pending
      pending = null
      try {
        await job.run()
        job.resolve()
      } catch (reason) {
        job.reject(reason)
      }
    }
    running = false
  }

  return {
    isRunning: () => running,
    clearPending,
    run: (run: RefreshJob["run"]) =>
      new Promise<void>((resolve, reject) => {
        clearPending()
        pending = { run, resolve, reject }
        if (!running) void drain()
      }),
  }
}
