export function renderCompressionName(
  template: string,
  name: string,
  date = new Date()
): string {
  const literal = template.replace(/\{(name|date)\}/g, "")
  if (!template.trim() || template.length > 120 || /[{}\\/]/.test(literal))
    throw new Error("命名规则仅支持 {name} 和 {date}，不能包含路径分隔符。")
  const day = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-")
  return template.replace(/\{(name|date)\}/g, (_, field: string) =>
    field === "name" ? name : day
  )
}
