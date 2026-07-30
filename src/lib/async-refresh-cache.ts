export type AsyncRefreshCache<T> = {
  get: () => Promise<T>
  refresh: () => Promise<T>
}

export function createAsyncRefreshCache<T>(
  loader: () => Promise<T>
): AsyncRefreshCache<T> {
  let hasCachedValue = false
  let cachedValue: T
  let activeLoad: Promise<T> | null = null
  let queuedRefresh: Promise<T> | null = null

  const runLoad = () => {
    if (activeLoad) {
      return activeLoad
    }

    let loaded: Promise<T>
    try {
      loaded = loader()
    } catch (error) {
      loaded = Promise.reject(error)
    }

    const request = loaded.then((value) => {
      cachedValue = value
      hasCachedValue = true
      return value
    })
    activeLoad = request
    void request.then(
      () => {
        if (activeLoad === request) {
          activeLoad = null
        }
      },
      () => {
        if (activeLoad === request) {
          activeLoad = null
        }
      }
    )
    return request
  }

  const get = () => {
    if (queuedRefresh) {
      return queuedRefresh
    }
    if (hasCachedValue) {
      return Promise.resolve(cachedValue)
    }
    return activeLoad ?? runLoad()
  }

  const refresh = () => {
    if (queuedRefresh) {
      return queuedRefresh
    }

    const currentLoad = activeLoad
    const request = currentLoad
      ? currentLoad.catch(() => undefined).then(runLoad)
      : runLoad()
    queuedRefresh = request
    void request.then(
      () => {
        if (queuedRefresh === request) {
          queuedRefresh = null
        }
      },
      () => {
        if (queuedRefresh === request) {
          queuedRefresh = null
        }
      }
    )
    return request
  }

  return {
    get,
    refresh,
  }
}
