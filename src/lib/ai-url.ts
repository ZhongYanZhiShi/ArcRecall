export function isLoopbackAiHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "[::1]" ||
    normalized === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  )
}

export function validateAiServiceUrl(value: string): string | null {
  try {
    const url = new URL(value.trim())
    if (
      !(["http:", "https:"] as const).includes(
        url.protocol as "http:" | "https:"
      ) ||
      !url.hostname
    ) {
      return "请输入有效的 http:// 或 https:// 服务地址。"
    }
    if (url.username || url.password) {
      return "服务地址不能包含用户名或密码。"
    }
    if (url.protocol === "http:" && !isLoopbackAiHostname(url.hostname)) {
      return "远程 AI 服务必须使用 https://；http:// 仅允许本机回环地址。"
    }
    return null
  } catch {
    return "请输入有效的 http:// 或 https:// 服务地址。"
  }
}
