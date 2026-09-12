<p align="center">
  <a href="./README.en.md">English</a> | <strong>简体中文</strong>
</p>

<div align="center">

# ArcRecall

用于识别真实文件格式、修复异常后缀并处理嵌套压缩资源的本地优先桌面工具。

<p><a href="https://www.rust-lang.org/"><img src="https://img.shields.io/badge/Rust-2024-000000?logo=rust&amp;logoColor=white" alt="Rust 2024"></a> <a href="https://v2.tauri.app/"><img src="https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&amp;logoColor=white" alt="Tauri 2"></a> <a href="https://nextjs.org/"><img src="https://img.shields.io/badge/Next.js-16.2-black?logo=nextdotjs" alt="Next.js 16.2"></a> <a href="https://react.dev/"><img src="https://img.shields.io/badge/React-19.2-149ECA?logo=react&amp;logoColor=white" alt="React 19.2"></a> <a href="https://ui.shadcn.com/"><img src="https://img.shields.io/badge/shadcn%2Fui-Base_UI-000000" alt="shadcn/ui with Base UI"></a> <a href="./LICENSE"><img src="https://img.shields.io/badge/License-Apache--2.0-D22128" alt="Apache License 2.0"></a></p>

</div>

## 项目简介

有些网络资源会被删除文件后缀、改成与真实格式无关的后缀，或封装在多层加密压缩包中。系统无法直接识别这类文件，用户只能猜测格式并逐层尝试解包。

ArcRecall 会读取文件内容来判断真实格式，补回或修正后缀，并逐层处理嵌套压缩包。遇到加密文件时，密码验证在本机进行。Next.js 前端负责交互，Tauri 负责原生桌面生命周期和 IPC 边界，与平台无关的 Rust 核心负责文件识别与归档处理。

## 主要功能

- 根据文件签名和内部结构识别真实格式
- 逐层分析和解包嵌套压缩文件
- 在本机检测加密并验证密码
- 保存处理记录，方便后续查看
- 本机结构化运行日志、诊断导出与 SQLite 备份
- 生成正确后缀的独立副本，分卷归档一起复制并规范命名

Hashcat 的完成比例是当前引擎尝试的进度，切换模式或处理下一个嵌套归档时会重新开始。

每个恢复任务共享累计展开预算：最多 100 GiB、100,000 个文件或目录。LZ4 解码和分卷复制回退
也计入字节预算；Windows 会在解压前检查目标磁盘空间，解压期间每 500 ms 检查实际输出和
剩余空间，并保留至少 256 MiB。运行时检查可能有短暂超出；达到预算后停止递归，保留完成部分。
其他平台执行累计预算检查，目前不提供磁盘空余空间查询。

## 恢复历史

成功处理的根归档和嵌套归档会按完整归档内容生成 SHA-256 指纹并写入 SQLite；识别出的
多分卷会按确定顺序纳入同一指纹。恢复任务启动后会在后台计算该指纹并查找历史密码，
因此文件改名后仍可命中，任意位置发生变化都会生成不同指纹。
历史页展示指纹前缀、格式、大小、分卷数和验证时间，支持查询、查看或复制密码、删除单条
记录和清空全部。历史不会保存来源文件名、路径或字典内容。

历史密码在写入本机数据库前使用 Windows DPAPI CurrentUser 加密，用于再次处理相同内容时
优先复验；已有明文记录会在应用启动时自动迁移，密码不会写入运行日志。查看或复制密码后，
界面会自动隐藏，并仅在剪贴板内容未被其他内容替换时定时清除该密码。

## 日志与诊断

桌面端将结构化 JSONL 日志写入
`%LocalAppData%\ArcRecall\logs`（其他平台位于对应本地数据目录）。单个日志文件上限
5 MiB，默认总容量上限为 25 MiB；可在“设置 → 应用”将总容量调整为 5–500 MiB，
达到上限后自动删除最旧分片。日志页面支持级别/关键词筛选、自动刷新、导出、清空和打开
日志目录；默认显示中文摘要并收起重复过程记录，需要时可展开技术详情。页面也可创建包含
已提交 WAL 内容的一致性 SQLite 备份。

默认记录 `info` 及以上级别，可在“设置 → 应用”切换为
`error`、`warn`、`info` 或 `debug`。密码、候选字典内容和用户路径不会写入日志；敏感
上下文字段在落盘前统一脱敏。

## 项目结构

```text
arc-recall/
├─ src/            # Next.js 界面
├─ src-tauri/      # Tauri 2 桌面壳与 IPC 适配层
├─ crates/
│  └─ arc-recall-core/ # 与平台无关的 Rust 业务逻辑
├─ Cargo.toml       # Rust workspace
└─ Cargo.lock       # Rust 依赖锁定
```

## 环境要求

- 当前稳定版 Rust 工具链
- 当前维护中的 Node.js 版本与 [pnpm](https://pnpm.io/)
- [Tauri 环境要求](https://v2.tauri.app/start/prerequisites/)中列出的当前平台依赖

## 快速开始

克隆仓库：

```powershell
git clone https://github.com/ZhongYanZhiShi/arc-recall.git
cd arc-recall
```

安装依赖并验证基础构建：

```powershell
pnpm install
cargo build --workspace
```

启动桌面应用：

```powershell
pnpm desktop:dev
```

Tauri 会启动 Next.js 开发服务器，并在原生桌面窗口中打开它。生产构建会嵌入 Next.js 静态导出，前端通过 Tauri command 调用 Rust，而不是访问本机 HTTP API。

## 开发检查

```powershell
# Rust
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-targets --all-features

# Web
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build

# Desktop
pnpm desktop:build
```

## 发布版本

仓库中的 GitHub Actions 会在推送语义化版本标签后自动构建 Windows x64 完整安装包、
生成发布说明并创建 GitHub Release。发布前请确保 `package.json`、
`src-tauri/tauri.conf.json` 和 `src-tauri/Cargo.toml` 中的版本号一致，然后执行：

```powershell
git tag v0.1.0
git push origin v0.1.0
```

也可以在 GitHub 的 Actions 页面手动运行 `Release` 工作流并填写已经存在的版本标签。
预发布标签（例如 `v0.2.0-beta.1`）会自动创建为 Pre-release。

添加 shadcn/ui 组件：

```powershell
pnpm dlx shadcn@latest add <component>
```

## 参与贡献

欢迎通过 [Issues](https://github.com/ZhongYanZhiShi/arc-recall/issues) 提交问题或建议，也欢迎发起 [Pull Request](https://github.com/ZhongYanZhiShi/arc-recall/pulls)。

提交改动前，请先阅读[贡献指南](./CONTRIBUTING.md)，并运行与改动范围对应的检查。

## 许可证

ArcRecall 使用 [Apache License 2.0](./LICENSE) 开源。

## 免责声明

ArcRecall 主要用于学习、研究和技术交流。请仅处理你拥有或已获得明确授权的文件，并自行确认相关操作符合当地法律法规。因误操作、数据损坏、未经授权使用或其他不当使用造成的后果，由使用者自行承担。
