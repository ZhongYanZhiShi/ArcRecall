[English](./README.en.md) | 简体中文

# ArcRecall

ArcRecall 是一款本地归档处理工具，支持识别真实文件格式、生成正确后缀副本和递归解压嵌套压缩包。解密依赖已知密码和字典中的候选密码，当前以字典验证为核心，未来也不会添加暴力破解等穷举功能。

## 下载与使用

在 [GitHub Releases](https://github.com/ZhongYanZhiShi/ArcRecall/releases) 选择 Windows x64 安装包。macOS / Linux 暂无经过验证的发行包。

| 版本   | 文件名                                 | 适用情况                                                       |
| ------ | -------------------------------------- | -------------------------------------------------------------- |
| 基础版 | `ArcRecall_版本号_x64-basic-setup.exe` | 不附带离线引擎资源，适合已安装完整版或已自行配置引擎的用户升级 |
| 完整版 | `ArcRecall_版本号_x64-full-setup.exe`  | 附带完整离线引擎资源，适合首次安装、离线使用或补充资源         |

两版的应用功能相同。安装器会沿用已有安装目录并覆盖更新程序，保留已部署的引擎、离线资源、设置、字典和历史数据，无需先卸载。应用内更新使用基础版，减少重复下载；需要补充或更新引擎资源时，可安装同版本完整版，再进行离线部署。首次安装建议选择完整版。

1. 完整引擎版已内置离线资源。打开「设置 → 解密引擎」，若显示「待部署」，点击「离线部署」；确认引擎就绪，无 GPU 时可选「仅 CPU」。
2. 如需通过字典恢复密码，先在「字典」页面导入候选密码文件或手动添加候选密码。
3. 拖入压缩包，填写已知密码（如有），点击「开始恢复并解压」。
4. 完成后打开输出目录；未完成的归档可加入重试队列。

## 功能

- 按文件内容识别格式，创建正确后缀的副本，不修改原文件。
- 递归解压嵌套归档，在本机验证已知密码或通过字典恢复密码。
- 批量处理文件，支持取消、重试和可选的任务队列记忆。
- 保存恢复历史，导出 JSON / CSV 报告，备份字典与历史数据。
- 创建 7z / ZIP 压缩包，可设置密码。

支持 7z、ZIP / ZIP64、RAR3 / RAR5 的识别、密码验证与递归解压，具体限制如下：

| 格式        | 分卷支持与限制                             |
| ----------- | ------------------------------------------ |
| 7z          | 支持连续数字分卷                           |
| ZIP / ZIP64 | 支持 `.z01 … .zip`、`.zip.001 …` 分卷      |
| RAR3 / RAR5 | 加密形式受引擎支持限制，多分卷支持尚不完整 |
| LZ4 Frame   | 仅展开内部受支持的归档                     |

分卷归档需提供完整卷组；暂不支持创建分卷压缩包。密码恢复不保证成功，GPU 恢复需要可用的 Hashcat 设备。

嵌套扫描默认跳过直属文件超过 10 个的目录及其子目录，可在「设置 → 解密引擎」调整，或在当前会话的最近任务结果中补扫。

## 本地开发

需要稳定版 Rust、Node.js 22.12+（22.x）或 24+、pnpm 10+、mise，以及 [Tauri 平台依赖](https://v2.tauri.app/start/prerequisites/)。固定工具版本见 [mise.toml](./mise.toml)。

```powershell
git clone https://github.com/ZhongYanZhiShi/ArcRecall.git
cd ArcRecall
mise install
pnpm install
pnpm desktop:dev
```

构建完整引擎版：

```powershell
pnpm desktop:build
```

构建基础版使用 `pnpm desktop:build:basic`。本机签名打包使用 `pnpm package`，同时生成两版 EXE、各自的 `.sig` 和指向基础版的 `latest.json`，输出到 `artifacts/package-v版本号-*`。

浏览器预览仅用于界面开发，文件处理需使用桌面版。项目结构与开发检查见[贡献指南](./CONTRIBUTING.md)。

## 贡献与许可

欢迎提交 [Issue](https://github.com/ZhongYanZhiShi/ArcRecall/issues) 或 Pull Request，详见[贡献指南](./CONTRIBUTING.md)。

使用 [Apache License 2.0](./LICENSE) 开源。请仅处理你拥有或已获得授权的文件。
