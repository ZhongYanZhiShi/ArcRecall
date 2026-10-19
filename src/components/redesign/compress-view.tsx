"use client"

import { Eye, EyeOff, Plus, X } from "lucide-react"
import * as React from "react"

import { Button } from "@/components/ui/button"

import type { Layer } from "./mock-data"
import { Lead, PathText, RdStage } from "./parts"
import { Token, ToggleWord } from "./sentence"
import { Strata } from "./strata"

const SOURCES = [
  {
    id: "s1",
    name: "季度报告",
    path: "D:\\工作\\季度报告",
    size: "214 MB",
    note: "文件夹 · 86 个文件",
  },
  {
    id: "s2",
    name: "原始数据",
    path: "D:\\工作\\原始数据",
    size: "1.1 GB",
    note: "文件夹 · 1,204 个文件",
  },
  {
    id: "s3",
    name: "说明.docx",
    path: "D:\\工作\\说明.docx",
    size: "48 KB",
    note: "文件",
  },
]

const FORMATS = [
  { value: "7z", label: "7z" },
  { value: "zip", label: "ZIP" },
] as const

const LEVELS = [
  { value: "fast", label: "最快" },
  { value: "normal", label: "标准" },
  { value: "max", label: "最小体积" },
] as const

/**
 * 压缩是解压的反方向：几样东西落进同一块板。
 * 左边一句话写清楚会生成什么，右边是要放进去的东西。
 */
export function CompressView() {
  const [format, setFormat] =
    React.useState<(typeof FORMATS)[number]["value"]>("7z")
  const [level, setLevel] =
    React.useState<(typeof LEVELS)[number]["value"]>("normal")
  const [encryptNames, setEncryptNames] = React.useState(true)
  const [showPassword, setShowPassword] = React.useState(false)
  const [password, setPassword] = React.useState("")
  const [name, setName] = React.useState("季度报告")
  const ext = format === "7z" ? "7z" : "zip"

  const layers: Layer[] = [
    ...SOURCES.map((source) => ({
      id: source.id,
      depth: 0,
      name: source.name,
      size: source.size,
      state: "done" as const,
    })),
    {
      id: "target",
      depth: 2,
      name: `${name}.${ext}`,
      state: "running" as const,
      progress: 0,
    },
  ]

  return (
    <RdStage label="压缩">
      <div className="grid gap-x-16 gap-y-12 xl:grid-cols-[minmax(0,27rem)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col">
          <Lead sub="合计 1.3 GB，1,291 个文件。先写到临时文件，完成后再改成目标文件名，不会留下半成品。">
            把这 3 样打包成一个压缩包。
          </Lead>

          <p className="mt-10 max-w-2xl text-base leading-[2.05] text-foreground/90">
            文件名叫
            <label htmlFor="archive-name" className="sr-only">
              压缩包文件名
            </label>
            <input
              id="archive-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mx-1 w-28 border-0 border-b-2 border-dashed border-primary/45 bg-transparent px-0.5 align-baseline font-semibold outline-none focus-visible:border-primary"
            />
            ，格式用
            <Token
              label="格式"
              value={format}
              options={FORMATS}
              onChange={setFormat}
            />
            ，压缩到
            <Token
              label="压缩级别"
              value={level}
              options={LEVELS}
              onChange={setLevel}
            />
            。密码设为
            <label htmlFor="compress-password" className="sr-only">
              密码
            </label>
            <span className="relative mx-1 inline-block">
              <input
                id="compress-password"
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="不设密码"
                className="w-36 border-0 border-b-2 border-dashed border-primary/45 bg-transparent pr-7 pl-0.5 align-baseline font-semibold outline-none placeholder:font-normal placeholder:text-muted-foreground/80 focus-visible:border-primary"
              />
              <button
                type="button"
                aria-label={showPassword ? "隐藏密码" : "显示密码"}
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-0 bottom-1 text-muted-foreground hover:text-foreground"
              >
                {showPassword ? (
                  <EyeOff className="size-4" />
                ) : (
                  <Eye className="size-4" />
                )}
              </button>
            </span>
            {format === "7z" ? (
              <>
                ，
                <ToggleWord
                  label="同时加密文件名"
                  on={encryptNames}
                  onChange={setEncryptNames}
                  onText="同时加密"
                  offText="不加密"
                />
                文件名
              </>
            ) : null}
            。
          </p>
          <PathText className="mt-2 text-[13px]">{`保存为 D:\\工作\\${name}.${ext}，同名时自动改名`}</PathText>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button size="lg">开始打包</Button>
            <Button size="lg" variant="ghost">
              <Plus data-icon="inline-start" />
              再加一些
            </Button>
            {password ? (
              <span className="text-[13px] text-muted-foreground">
                开始前会请你再输入一次密码确认。
              </span>
            ) : null}
          </div>
        </div>

        <div className="min-w-0 xl:pt-2">
          <Strata
            layers={layers}
            renderLabel={(layer) => {
              if (layer.id === "target") {
                return (
                  <div>
                    <span className="text-xs text-muted-foreground">
                      将生成
                    </span>
                    <p className="mt-1 truncate text-[17px] font-semibold">
                      {name}.{ext}
                    </p>
                  </div>
                )
              }
              const source = SOURCES.find((s) => s.id === layer.id)!
              return (
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <span className="text-xs text-muted-foreground">
                      {source.note}
                    </span>
                    <p className="mt-0.5 truncate text-[15px] font-semibold">
                      {source.name}
                      <span className="rd-tabular ml-2 text-[13px] font-normal text-muted-foreground">
                        {source.size}
                      </span>
                    </p>
                    <PathText>{source.path}</PathText>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`不打包 ${source.name}`}
                  >
                    <X />
                  </Button>
                </div>
              )
            }}
          />
        </div>
      </div>
    </RdStage>
  )
}
