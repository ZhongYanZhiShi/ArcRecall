export type Stage = "识别" | "校验" | "尝试" | "解包" | "递归扫描"

export type LayerState =
  | "done" // 已解包
  | "running" // 正在处理（stage 指出当前阶段）
  | "needsPassword" // 字典未命中，需要手动输入
  | "blocked" // 缺分卷、损坏等
  | "waiting" // 等待上一层
  | "unknown" // 外层尚未打开，内容未知

export type Layer = {
  id: string
  depth: number
  name: string
  /** 文件扩展名看起来像什么 */
  apparent?: string
  /** 按内容识别出的真实格式 */
  format?: string
  size?: string
  encryption?: string
  state: LayerState
  stage?: Stage
  /** 0–1，仅 running 时有意义 */
  progress?: number
  detail?: string
}
