import type { Metadata } from "next"

import { RedesignApp } from "@/components/redesign/redesign-app"

export const metadata: Metadata = {
  title: "ArcRecall · 新界面预览",
}

/** 新界面预览：仅示例数据，不调用桌面端命令。用 `pnpm dev:web` 打开 /redesign 查看。 */
export default function RedesignPage() {
  return <RedesignApp />
}
