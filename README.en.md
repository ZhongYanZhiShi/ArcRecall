English | [简体中文](./README.md)

# ArcRecall

ArcRecall is a local archive tool for identifying file formats, creating copies with correct extensions, and recursively extracting nested archives. Decryption relies on known passwords and dictionary candidates, with dictionary verification at the core of the current workflow. Brute-force modes and other exhaustive password-search features will not be added.

## Download and use

Choose a Windows x64 installer from [GitHub Releases](https://github.com/ZhongYanZhiShi/ArcRecall/releases). macOS / Linux distribution packages are not yet verified.

| Edition | Filename                                | When to use                                                                                                     |
| ------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Basic   | `ArcRecall_VERSION_x64-basic-setup.exe` | Excludes offline engine resources; upgrade an existing full installation or use engines you configured yourself |
| Full    | `ArcRecall_VERSION_x64-full-setup.exe`  | Includes offline engine resources; recommended for first installation, offline use, or restoring resources      |

Both editions provide the same application features. Installers reuse the existing installation directory and overwrite the application while retaining deployed engines, offline resources, settings, dictionaries, and history. There is no need to uninstall first. In-app updates download the smaller basic edition. To add or update offline resources, install the full edition of the same version and deploy its engines.

1. The full engine edition includes offline resources. Open Settings → Recovery engines and deploy them if their status is pending. Confirm the engines are ready; choose CPU only if no GPU is available.
2. For dictionary-based recovery, import a candidate password file or add candidates manually on the Dictionary page first.
3. Drop an archive, enter a known password if available, and start recovery and extraction.
4. Open the output directory when finished. Add unfinished archives to the retry queue as needed.

## Features

- Identify formats from file contents and create copies with correct extensions, leaving originals unchanged.
- Extract nested archives recursively, verify known passwords, and recover passwords using local dictionaries.
- Process batches with cancellation, retry, and optional task queue persistence.
- Save recovery history, export JSON / CSV reports, and back up dictionaries and history.
- Create 7z / ZIP archives with optional passwords.

Supports detection, password verification, and recursive extraction for 7z, ZIP / ZIP64, and RAR3 / RAR5, with these limits:

| Format      | Volume support and limits                                                     |
| ----------- | ----------------------------------------------------------------------------- |
| 7z          | Supports contiguous numbered volumes                                          |
| ZIP / ZIP64 | Supports `.z01 … .zip` and `.zip.001 …` volumes                               |
| RAR3 / RAR5 | Encryption variants depend on engine support; multipart support is incomplete |
| LZ4 Frame   | Only unwraps supported inner archives                                         |

Split archives require a complete volume set. Creating split archives is not supported. Password recovery is not guaranteed; GPU recovery requires a usable Hashcat device.

Nested scanning skips directories with more than 10 direct files and their subdirectories by default. Adjust this under Settings → Recovery engines, or rescan from the most recent task's results in the current session.

## Local development

Requires stable Rust, Node.js 22.12+ (22.x) or 24+, pnpm 10+, mise, and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/). See [mise.toml](./mise.toml) for pinned tool versions.

```powershell
git clone https://github.com/ZhongYanZhiShi/ArcRecall.git
cd ArcRecall
mise install
pnpm install
pnpm desktop:dev
```

Build the full engine edition:

```powershell
pnpm desktop:build
```

Use `pnpm desktop:build:basic` to build the basic edition. For signed local packaging, `pnpm package` creates both EXE installers, their `.sig` files, and a `latest.json` pointing to the basic edition in `artifacts/package-vVERSION-*`.

Browser preview is for UI development; file processing requires the desktop app. See the [contribution guide](./CONTRIBUTING.en.md) for project structure and development checks.

## Contributing and license

[Issues](https://github.com/ZhongYanZhiShi/ArcRecall/issues) and pull requests are welcome. See the [contribution guide](./CONTRIBUTING.en.md).

Licensed under [Apache License 2.0](./LICENSE). Only process files you own or are authorized to access.
