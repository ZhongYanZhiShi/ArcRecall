"use client"

import { HardDriveDownload } from "lucide-react"
import * as React from "react"

import { Button } from "@/components/ui/button"

import { Lead, RdStage, StatusTag } from "./parts"
import { Token, ToggleWord } from "./sentence"

const DEPTHS = [
  { value: "3", label: "3 层" },
  { value: "5", label: "5 层" },
  { value: "8", label: "8 层" },
] as const

const SKIPS = [
  { value: "10", label: "10 个" },
  { value: "50", label: "50 个" },
  { value: "none", label: "不限" },
] as const

/**
 * 设置写成一篇可以从头读到尾的说明，每个选项是句子里的一个词。
 * 不再有分类侧栏和卡片。
 */
export function SettingsView() {
  const [clean, setClean] = React.useState(true)
  const [flatten, setFlatten] = React.useState(true)
  const [depth, setDepth] =
    React.useState<(typeof DEPTHS)[number]["value"]>("5")
  const [skip, setSkip] = React.useState<(typeof SKIPS)[number]["value"]>("10")

  return (
    <RdStage label="设置" className="max-w-3xl">
      <Lead sub="改动会立即保存。">还有一件事要处理：GPU 引擎没有部署。</Lead>

      <Chapter title="用什么来打开">
        <Line>
          <b>7-Zip</b> 负责识别、校验和解包，内置在程序里。
          <StatusTag tone="success" className="ml-2 align-middle">
            就绪
          </StatusTag>
        </Line>
        <Line>
          <b>John</b> 用 CPU 逐条尝试字典，离线资源已经装好。
          <StatusTag tone="success" className="ml-2 align-middle">
            就绪
          </StatusTag>
        </Line>
        <Line>
          <b>Hashcat</b> 用 GPU
          尝试字典，快得多，但还没部署。安装包里已经带了资源，部署大约一分钟；在那之前，选了
          GPU 的任务会自动改用 CPU，不会中断。
          <StatusTag tone="warning" className="ml-2 align-middle">
            待部署
          </StatusTag>
        </Line>
        <Button size="lg" className="mt-2 self-start">
          <HardDriveDownload data-icon="inline-start" />
          离线部署 Hashcat
        </Button>
      </Chapter>

      <Chapter title="解压之后">
        <Line>
          <ToggleWord
            label="清理空文件夹"
            on={clean}
            onChange={setClean}
            onText="清理"
            offText="保留"
          />
          这次解压产生的空文件夹。只删真正空的目录，里面有任何文件（包括隐藏文件）都会留着。
        </Line>
        <Line>
          <ToggleWord
            label="去除多层同名嵌套"
            on={flatten}
            onChange={setFlatten}
            onText="合并"
            offText="保留"
          />
          一层套一层的同名文件夹，例如{" "}
          <code className="font-mono text-[14px]">资料/资料/资料/照片</code>{" "}
          变成 <code className="font-mono text-[14px]">资料/照片</code>
          。名字不完全一样就不动。
        </Line>
      </Chapter>

      <Chapter title="压缩包里的压缩包">
        <Line>
          最多往里拆
          <Token
            label="最多拆开层数"
            value={depth}
            options={DEPTHS}
            onChange={setDepth}
          />
          ，跳过直接放了超过
          <Token
            label="跳过阈值"
            value={skip}
            options={SKIPS}
            onChange={setSkip}
          />
          文件的文件夹。被跳过的，可以在任务结果里再补拆。
        </Line>
      </Chapter>

      <Chapter title="数据">
        <Line>字典和历史都只存在这台电脑上。换电脑或重装前，可以先备份。</Line>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline">备份数据</Button>
          <Button variant="ghost">从备份恢复</Button>
        </div>
      </Chapter>

      <Chapter title="关于">
        <Line>ArcRecall 0.1.2。不会尝试穷举密码，只用你给的密码和字典。</Line>
        <Button variant="ghost" className="-ml-3 self-start">
          检查更新
        </Button>
      </Chapter>
    </RdStage>
  )
}

function Chapter({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  const id = React.useId()
  return (
    <section aria-labelledby={id} className="mt-16 flex flex-col gap-4">
      <h2 id={id} className="text-sm font-medium text-muted-foreground">
        {title}
      </h2>
      {children}
    </section>
  )
}

function Line({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[17px] leading-[1.9] text-foreground/90">{children}</p>
  )
}
