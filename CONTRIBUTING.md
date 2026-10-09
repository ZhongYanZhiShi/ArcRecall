# 参与 ArcRecall

[English](./CONTRIBUTING.en.md) | 中文

感谢你帮助改进 ArcRecall。Issue 和 Pull Request 均可使用中文或英文。

## 开始之前

- 新建 Issue 或 Pull Request 前，请先搜索是否已有相同内容。
- 较大的功能或涉及项目结构的改动，建议先通过 Issue 讨论。
- 示例和日志中不要包含密码、私人文件名、压缩包内容或其他敏感信息。

## 报告问题

请使用 Bug 模板，并尽量提供：

- 清晰的复现步骤
- 预期行为与实际结果
- 受影响的应用和运行环境
- 可以安全公开的最小示例或脱敏日志

## 提议功能

请先说明使用场景，再描述期望的实现方式。内容应包括当前遇到的困难、期望结果，以及考虑过的其他方案。

## 提交 Pull Request

- 每个 Pull Request 只处理一个明确问题。
- 如果已有相关 Issue，请在说明中关联。
- 同时说明改动原因和改动后的行为。
- 桌面端的可见界面改动需要附截图。
- 安装方式、命令或行为发生变化时，请同步更新文档。
- 避免夹带无关的格式化、生成文件或依赖更新。

## 项目结构

- `src/`：Next.js 界面。
- `src-tauri/`：Tauri 桌面适配层。
- `crates/arc-recall-core/`：Rust 核心逻辑。

环境配置、启动与打包方式见 [README](./README.md#本地开发)。

## 验证

请运行与本次改动相关的检查，并在 Pull Request 中记录命令和结果。未修改的应用不需要勾选对应检查项。

```powershell
pnpm lint
pnpm typecheck
pnpm test
cargo test --workspace --all-targets --all-features
```

测试应保护可观察的行为和真实回归风险：

- 保留数据持久化、凭据保护、并发与取消、失败回退和发布完整性测试。
- 同一执行路径已有更完整的测试时，合并独有断言，删除重复用例。
- 简单赋值、固定展示文案和路径拼接不必逐一测试；兼容性、输入边界和安全约束仍需覆盖。
- 使用可重复的夹具和临时目录，不把依赖本机私人归档或历史数据库的诊断探针作为回归测试。
- `pnpm test:ui` 验证渲染与交互；模拟 IPC 的浏览器测试不能替代 `pnpm test:desktop` 的原生集成验证。

执行 `pnpm install` 会启用提交前钩子。每次提交前，
钩子都会执行 Oxfmt 和 `cargo fmt` 格式检查；如果检查失败，请先运行：

```powershell
pnpm format
cargo fmt --all
```

项目目前不强制提交信息格式。

## 许可证

提交贡献即表示你同意相关内容按照 [Apache License 2.0](./LICENSE) 授权。
