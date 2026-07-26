# ArcRecall Windows x64 完整引擎包第三方声明

本目录描述 ArcRecall 完整发行包中独立分发、以外部进程方式调用的工具。
ArcRecall 不把这些工具静态链接进自身，也不改变各工具原有许可证。

## 7-Zip 26.02

- 项目主页：https://www.7-zip.org/
- 源码：https://github.com/ip7z/7zip/releases/tag/26.02
- 许可证：LGPL 2.1 或更高版本；部分代码采用 BSD 3-Clause；RAR 解压代码带有 unRAR 限制。
- 完整发行资源同时包含官方 `7z2602-src.7z`。安装后的 7-Zip 目录包含上游 `License.txt`。

## Hashcat 7.1.2

- 项目主页：https://hashcat.net/hashcat/
- 源码：https://github.com/hashcat/hashcat/tree/v7.1.2
- 许可证：MIT；二进制包中 `docs/license.txt` 以及 `docs/license_libs/` 保留上游和依赖许可证。

## John the Ripper 1.9.0-jumbo-1

- 项目主页：https://www.openwall.com/john/
- 源码：https://www.openwall.com/john/k/john-1.9.0-jumbo-1.tar.xz
- 许可证：主要为 GPL v2，归档中部分组件采用各自许可证。
- 完整发行资源同时包含未经修改的官方对应源码包
  `john-1.9.0-jumbo-1.tar.xz`，安装后的 `doc/` 目录保留上游文档和许可证。
- ArcRecall 使用独立进程调用 `john.exe`、`7z2john.pl`、`rar2john.exe`
  与 `zip2john.exe`。

## Strawberry Perl 5.42.2.1 (64-bit portable)

- 项目主页：https://strawberryperl.com/
- 发行包：https://github.com/StrawberryPerl/Perl-Dist-Strawberry/releases/tag/SP_54221_64bit
- Perl 采用 Artistic License 或 GNU GPL；便携发行包还包含多项第三方依赖，
  其许可证和说明随原始便携 ZIP 原样分发并在展开后的目录中保留。

## 未捆绑的系统组件

GPU 驱动、CUDA、HIP 和 OpenCL 驱动/运行时不属于 ArcRecall 完整引擎包。
Hashcat 会使用用户系统中已安装且兼容的后端；缺少可用后端时，ArcRecall 可回退到
John CPU 引擎。
