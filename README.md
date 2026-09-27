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
- 会话内批次队列：多选、拖入多个文件或粘贴多行路径，按顺序解压并保留每项结果
- 生成正确后缀的独立副本，分卷归档一起复制并规范命名
- 字典导入进度与取消、Hashcat 实时进度和速度

批次最多接收 200 项，停止批次后保留等待项，可将失败或取消项重新排队；队列随应用退出清除。
每项归档都使用独立输出目录，批次的优先密码仅用于本次处理，不保存到浏览器存储。
Hashcat 的完成比例是当前引擎尝试的进度，切换模式或处理下一个嵌套归档时会重新开始。

嵌套压缩包扫描默认跳过直属文件超过 10 个的目录及其子目录，其他同级目录继续扫描，
已解压内容保留。可在「设置 → 解密引擎 → 目录扫描文件数上限」调整，设为 0 则不限文件数；
保存后对新任务生效。跳过原因会显示在详细过程与完成摘要中。

每个恢复任务共享累计展开预算：最多 100 GiB、100,000 个文件或目录。LZ4 解码和分卷复制回退
也计入字节预算；Windows 会在解压前检查目标磁盘空间，解压期间定期检查实际输出和
剩余空间，并保留至少 256 MiB。每次检查完成后至少间隔 500 ms，扫描过程中可取消。
运行时检查可能有短暂超出；达到预算后停止递归，保留完成部分。
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

“设置 → 数据”可创建备份或从当前格式的备份恢复字典与历史。恢复前先显示记录数量、检查
完整性和当前账户的密码解密能力，确认后自动备份当前数据库，再以事务替换数据；失败时回滚。
备份不包含应用设置、AI 密钥和压缩默认密码。含 DPAPI 密码的备份应在创建它的 Windows
账户下恢复；无法解密的备份会阻止恢复。

默认记录 `info` 及以上级别，可在“设置 → 应用”切换为
`error`、`warn`、`info` 或 `debug`。密码、候选字典内容和用户路径不会写入日志；敏感
上下文字段在落盘前统一脱敏。

## 项目结构

```text
ArcRecall/
├─ src/            # Next.js 界面
├─ src-tauri/      # Tauri 2 桌面壳与 IPC 适配层
├─ crates/
│  └─ arc-recall-core/ # 与平台无关的 Rust 业务逻辑
├─ Cargo.toml       # Rust workspace
└─ Cargo.lock       # Rust 依赖锁定
```

## 环境要求

- 当前稳定版 Rust 工具链
- Node.js 22.x（至少 22.12）或 24 及以上版本，以及 [pnpm](https://pnpm.io/) 10 及以上版本
- [Tauri 环境要求](https://v2.tauri.app/start/prerequisites/)中列出的当前平台依赖

测试命令依赖 `--experimental-strip-types`，不支持 Node.js 20。开发工具的固定版本见 `mise.toml`。

## 快速开始

克隆仓库：

```powershell
git clone https://github.com/ZhongYanZhiShi/ArcRecall.git
cd ArcRecall
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

开发构建也会处理 GB 级归档，因此工作区为 `sha2` 单独启用编译优化。所有格式仍使用完整内容 SHA-256、完整密码校验和原有解压流程；该设置不改变指纹或密码判断规则。生产构建已默认启用优化。

需要定位大归档耗时时，可在 PowerShell 中显式运行性能探针（默认测试不会运行它们）：

```powershell
$env:ARC_RECALL_PROFILE_ARCHIVE = 'E:/archives/example.7z'
# 只读测量归档识别和完整指纹计算，支持分卷。
cargo test -p arc-recall-core profile_archive_fingerprint -- --ignored --nocapture
# Windows 原生恢复计时：复用本机历史密码、字典和应用引擎配置。
cargo test -p arc-recall-desktop profile_local_archive_recovery -- --ignored --nocapture
```

原生探针要求根归档已有匹配的本机历史密码，在归档所在目录下创建临时输出并在结束后清理，不更新历史或字典，也不打印密码。嵌套归档继续使用正常的密码恢复流程；有跳过的归档时探针失败。

## 开发检查

调试构建可通过 `ARC_RECALL_TEST_DATA_ROOT` 指定绝对路径，使用独立的数据库、配置和日志进行原生测试。该变量指向 ArcRecall 数据目录本身；发布构建会忽略它。系统凭据和剪贴板仍属于当前系统用户，测试这些接口时应使用独立的合成记录并清理。

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

## 应用更新

Windows x64 正式版可在“设置 → 应用”检查更新、查看版本说明、下载并安装更新。
每次启动都会检查 GitHub Releases 的最新正式版，发现新版本时显示提示。
“自动更新”默认开启，发现新版本后会自动下载并校验签名，同时每 6 小时再次检查；可在设置中关闭自动下载。
下载完成后显示提示，由用户点击“安装更新并重启”；恢复、压缩、
引擎安装或数据恢复等任务运行期间无法安装更新。本机设置、字典和历史保留。
下载暂存在当前进程内存中，退出后需要重新下载；关闭自动更新不会取消已经开始的下载。
预发布版本不会进入此正式版更新通道。

添加 shadcn/ui 组件：

```powershell
pnpm dlx shadcn@latest add <component>
```

## 参与贡献

欢迎通过 [Issues](https://github.com/ZhongYanZhiShi/ArcRecall/issues) 提交问题或建议，也欢迎发起 [Pull Request](https://github.com/ZhongYanZhiShi/ArcRecall/pulls)。

提交改动前，请先阅读[贡献指南](./CONTRIBUTING.md)，并运行与改动范围对应的检查。

## 许可证

ArcRecall 使用 [Apache License 2.0](./LICENSE) 开源。

## 免责声明

ArcRecall 主要用于学习、研究和技术交流。请仅处理你拥有或已获得明确授权的文件，并自行确认相关操作符合当地法律法规。因误操作、数据损坏、未经授权使用或其他不当使用造成的后果，由使用者自行承担。
