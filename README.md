<p align="center">
  <strong>English</strong> | <a href="./README.zh-CN.md">简体中文</a>
</p>

<div align="center">

# ArcRecall

A local-first desktop tool for identifying disguised files, repairing extensions, and handling nested archives.

<p><a href="https://www.rust-lang.org/"><img src="https://img.shields.io/badge/Rust-2024-000000?logo=rust&amp;logoColor=white" alt="Rust 2024"></a> <a href="https://v2.tauri.app/"><img src="https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&amp;logoColor=white" alt="Tauri 2"></a> <a href="https://nextjs.org/"><img src="https://img.shields.io/badge/Next.js-16.2-black?logo=nextdotjs" alt="Next.js 16.2"></a> <a href="https://react.dev/"><img src="https://img.shields.io/badge/React-19.2-149ECA?logo=react&amp;logoColor=white" alt="React 19.2"></a> <a href="https://ui.shadcn.com/"><img src="https://img.shields.io/badge/shadcn%2Fui-Base_UI-000000" alt="shadcn/ui with Base UI"></a> <a href="./LICENSE"><img src="https://img.shields.io/badge/License-Apache--2.0-D22128" alt="Apache License 2.0"></a></p>

</div>

## Overview

Some files shared online have their extensions removed, replaced with misleading ones, or are wrapped in multiple encrypted archives. The operating system cannot identify these files directly, leaving users to guess the format and unpack each layer by hand.

ArcRecall reads file contents to determine the actual format, restores or corrects extensions, and works through nested archives one layer at a time. Password checks for encrypted files run locally. The Next.js frontend provides the interface, Tauri owns the native desktop lifecycle and IPC boundary, and the platform-independent Rust core handles file inspection and archive processing.

## Planned features

- Detect actual formats from file signatures and internal structure
- Inspect and unpack nested archives one layer at a time
- Detect encryption and verify passwords locally
- Keep processing records for later review

## Repository structure

```text
arc-recall/
├─ src/            # Next.js UI
├─ src-tauri/      # Tauri 2 desktop shell and IPC adapters
├─ crates/
│  └─ arc-recall-core/ # Platform-independent Rust business logic
├─ Cargo.toml       # Rust workspace
└─ Cargo.lock       # Locked Rust dependencies
```

## Requirements

- Current stable Rust toolchain
- A currently maintained Node.js release and [pnpm](https://pnpm.io/)
- The platform dependencies listed in the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

## Quick start

Clone the repository:

```powershell
git clone https://github.com/ZhongYanZhiShi/arc-recall.git
cd arc-recall
```

Install dependencies and verify the base build:

```powershell
pnpm install
cargo build --workspace
```

Start the desktop application:

```powershell
pnpm desktop:dev
```

Tauri starts the Next.js development server and opens it in a native desktop window. Production builds embed the static Next.js export. The frontend calls Rust through Tauri commands instead of a localhost HTTP API.

## Development checks

```powershell
# Rust
cargo fmt --all -- --check
cargo test --workspace

# Web
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build

# Desktop
pnpm desktop:build
```

Add a shadcn/ui component:

```powershell
pnpm dlx shadcn@latest add <component>
```

## Contributing

Issues and suggestions are welcome through [GitHub Issues](https://github.com/ZhongYanZhiShi/arc-recall/issues). Contributions can be submitted as [Pull Requests](https://github.com/ZhongYanZhiShi/arc-recall/pulls).

Before submitting changes, read the [contribution guide](./CONTRIBUTING.md) and run the checks relevant to your changes.

## License

ArcRecall is licensed under the [Apache License 2.0](./LICENSE).

## Disclaimer

ArcRecall is intended for learning, research, and technical exchange. Only process files you own or are explicitly authorized to access, and make sure your use complies with applicable laws and regulations. You are responsible for any consequences caused by mistakes, data loss, unauthorized access, or other misuse.
