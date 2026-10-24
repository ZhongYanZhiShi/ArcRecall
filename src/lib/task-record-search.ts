export function buildRecordDateRange(from: string, to: string) {
  const parse = (value: string) => {
    const date = new Date(`${value}T00:00:00`)
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(date.getTime()) ||
      date.getTime() < 0 ||
      date.getFullYear() !== Number(value.slice(0, 4)) ||
      date.getMonth() + 1 !== Number(value.slice(5, 7)) ||
      date.getDate() !== Number(value.slice(8, 10))
    )
      throw new Error("日期无效。")
    return date
  }
  const fromMs = from ? parse(from).getTime() : null
  const end = to ? parse(to) : null
  if (end) end.setDate(end.getDate() + 1)
  const beforeMs = end?.getTime() ?? null
  if (fromMs !== null && beforeMs !== null && fromMs >= beforeMs)
    throw new Error("开始日期不能晚于结束日期。")
  return { fromMs, beforeMs }
}
