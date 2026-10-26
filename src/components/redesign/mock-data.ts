/**
 * 新界面预览使用的示例数据。不连接任何后端命令，仅用于评估布局与视觉。
 * 文件名和路径均为通用示例。
 */

export type { Layer, LayerState, Stage } from "./strata-model"
import type { Layer, Stage } from "./strata-model"

export type QueueState =
  | "done"
  | "running"
  | "needsPassword"
  | "missingVolume"
  | "waiting"

export type QueueItem = {
  id: string
  name: string
  location: string
  size: string
  state: QueueState
  summary: string
  layers: Layer[]
}

export const QUEUE: QueueItem[] = [
  {
    id: "q1",
    name: "项目资料.7z",
    location: "D:\\下载\\资料",
    size: "1.2 GB",
    state: "done",
    summary: "3 层全部解开 · 用时 00:00:41",
    layers: [
      {
        id: "q1-0",
        depth: 0,
        name: "项目资料.7z",
        format: "7z",
        size: "1.2 GB",
        encryption: "无密码",
        state: "done",
        detail: "解出 2 个文件夹、1 个内层归档",
      },
      {
        id: "q1-1",
        depth: 1,
        name: "项目资料/附件.zip",
        format: "ZIP",
        size: "318 MB",
        encryption: "ZipCrypto",
        state: "done",
        detail: "历史密码命中",
      },
      {
        id: "q1-2",
        depth: 2,
        name: "项目资料/附件/图纸.rar",
        format: "RAR5",
        size: "96 MB",
        encryption: "无密码",
        state: "done",
        detail: "解出 214 个文件",
      },
    ],
  },
  {
    id: "q4",
    name: "合同扫描.zip",
    location: "D:\\下载",
    size: "38 MB",
    state: "needsPassword",
    summary: "字典 29,750 条均未命中",
    layers: [
      {
        id: "q4-0",
        depth: 0,
        name: "合同扫描.zip",
        format: "ZIP",
        size: "38 MB",
        encryption: "AES-256",
        state: "needsPassword",
        stage: "尝试",
        detail: "字典与历史密码均未命中。输入已知密码后重试本项。",
      },
    ],
  },
  {
    id: "q3",
    name: "设计稿.part1.rar",
    location: "E:\\共享\\设计",
    size: "2 × 500 MB",
    state: "missingVolume",
    summary: "缺少 part3，其余分卷已找到",
    layers: [
      {
        id: "q3-0",
        depth: 0,
        name: "设计稿.part1.rar",
        format: "RAR5 分卷",
        size: "2 / 3 卷",
        encryption: "未知",
        state: "blocked",
        stage: "识别",
        detail: "缺少 设计稿.part3.rar。放到同一文件夹后重试。",
      },
    ],
  },
  {
    id: "q2",
    name: "照片备份.jpg",
    location: "D:\\下载",
    size: "412 MB",
    state: "running",
    summary: "第 2 层 · 正在用字典尝试",
    layers: [
      {
        id: "q2-0",
        depth: 0,
        name: "照片备份.jpg",
        apparent: "JPG",
        format: "ZIP",
        size: "412 MB",
        encryption: "无密码",
        state: "done",
        detail: "扩展名伪装为图片，已按内容识别并解开",
      },
      {
        id: "q2-1",
        depth: 1,
        name: "照片备份/2026 春.7z",
        format: "7z",
        size: "409 MB",
        encryption: "AES-256 · 文件名已加密",
        state: "running",
        stage: "尝试",
        progress: 0.62,
        detail: "已检查 18,402 / 29,750 条候选 · 1,240 条/秒 · 约 9 秒",
      },
      {
        id: "q2-2",
        depth: 2,
        name: "内容未知",
        state: "unknown",
        detail: "上一层解开后继续扫描，最多 5 层",
      },
    ],
  },
  {
    id: "q5",
    name: "归档_无扩展名",
    location: "D:\\下载",
    size: "6.4 MB",
    state: "waiting",
    summary: "排队中",
    layers: [
      {
        id: "q5-0",
        depth: 0,
        name: "归档_无扩展名",
        apparent: "无扩展名",
        format: "待识别",
        size: "6.4 MB",
        state: "waiting",
        detail: "轮到本项时按内容识别格式",
      },
    ],
  },
]

export const DICTIONARY_TOTAL = 29750

export const DICTIONARY_ROWS = [
  "spring2026",
  "资料备份2026",
  "P@ssw0rd!",
  "photo_backup",
  "20260315",
  "arc-recall-test",
  "设计部共享",
  "qwer1234",
  "Archive#88",
  "公司内部资料",
  "backup-2025-12",
  "letmein-2026",
  "图纸_v3",
  "2026spring!",
]

export type HistoryRow = {
  id: string
  name: string
  format: string
  size: string
  volumes: number
  archivePath: string
  outputPath: string
  lastUsed: string
  password: string
}

export const HISTORY: HistoryRow[] = [
  {
    id: "h1",
    name: "项目资料.7z",
    format: "7z",
    size: "1.2 GB",
    volumes: 1,
    archivePath: "D:\\下载\\资料\\项目资料.7z",
    outputPath: "D:\\下载\\资料\\项目资料",
    lastUsed: "今天 20:41",
    password: "spring2026",
  },
  {
    id: "h2",
    name: "附件.zip",
    format: "ZIP",
    size: "318 MB",
    volumes: 1,
    archivePath: "D:\\下载\\资料\\项目资料\\附件.zip",
    outputPath: "D:\\下载\\资料\\项目资料\\附件",
    lastUsed: "今天 20:42",
    password: "资料备份2026",
  },
  {
    id: "h3",
    name: "季度报表.rar",
    format: "RAR5",
    size: "84 MB",
    volumes: 3,
    archivePath: "E:\\共享\\财务\\季度报表.part1.rar",
    outputPath: "E:\\共享\\财务\\季度报表",
    lastUsed: "10月17日 14:05",
    password: "Archive#88",
  },
  {
    id: "h4",
    name: "旧版本备份",
    format: "7z",
    size: "2.6 GB",
    volumes: 1,
    archivePath: "",
    outputPath: "",
    lastUsed: "9月30日 09:12",
    password: "backup-2025-12",
  },
  {
    id: "h5",
    name: "素材合集.zip",
    format: "ZIP64",
    size: "5.1 GB",
    volumes: 1,
    archivePath: "F:\\素材\\素材合集.zip",
    outputPath: "F:\\素材\\素材合集",
    lastUsed: "9月21日 22:30",
    password: "qwer1234",
  },
]

export type LogLevel = "error" | "warn" | "info"

export type LogEvent = {
  id: string
  time: string
  level: LogLevel
  task?: string
  stage?: Stage | "完成" | "设置"
  message: string
}

export const LOGS: LogEvent[] = [
  {
    id: "l1",
    time: "20:58:12",
    level: "info",
    task: "照片备份.jpg",
    stage: "尝试",
    message: "第 2 层开始字典尝试，候选 29,750 条，GPU 可用",
  },
  {
    id: "l2",
    time: "20:58:09",
    level: "info",
    task: "照片备份.jpg",
    stage: "解包",
    message: "第 1 层解开，发现 1 个内层归档",
  },
  {
    id: "l3",
    time: "20:58:02",
    level: "warn",
    task: "照片备份.jpg",
    stage: "识别",
    message: "扩展名为 .jpg，内容识别为 ZIP，已按 ZIP 处理",
  },
  {
    id: "l4",
    time: "20:57:40",
    level: "error",
    task: "设计稿.part1.rar",
    stage: "识别",
    message: "分卷不完整：缺少 设计稿.part3.rar",
  },
  {
    id: "l5",
    time: "20:57:31",
    level: "warn",
    task: "合同扫描.zip",
    stage: "尝试",
    message: "字典与历史密码均未命中，已标记为需要密码",
  },
  {
    id: "l6",
    time: "20:56:12",
    level: "info",
    task: "项目资料.7z",
    stage: "完成",
    message: "3 层全部解开，清理空文件夹 2 个",
  },
  {
    id: "l7",
    time: "20:55:31",
    level: "info",
    task: "项目资料.7z",
    stage: "校验",
    message: "第 2 层历史密码命中",
  },
  {
    id: "l8",
    time: "20:40:03",
    level: "error",
    stage: "设置",
    message: "Hashcat 未部署，GPU 尝试回退到 CPU",
  },
  {
    id: "l9",
    time: "20:39:58",
    level: "info",
    stage: "设置",
    message: "应用设置已保存",
  },
]
