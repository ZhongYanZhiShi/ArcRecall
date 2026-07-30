<p align="center">
  <strong>English</strong> | <a href="./README.md">简体中文</a>
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
- Keep local structured runtime logs with diagnostic export and SQLite backup

## Recovery history

Successfully processed root and nested archives are stored in the local SQLite
database using a fingerprint derived from file size and multiple content
samples, so renaming a file does not break a match. Large files use a bounded
number of samples instead of an additional full-file scan.
The History page shows fingerprint prefixes, format, size, volume count, and
verification times, with search, password reveal/copy, per-entry deletion, and
clear-all actions. Source filenames, paths, and dictionary contents are not
stored.

Saved history passwords are plain text in the local database and are tried
before the global dictionary when the same content is processed again. They
are not written to runtime logs. Use this feature only in a trusted local user
environment.

## Logging and diagnostics

The desktop app writes structured JSONL logs under
`%LocalAppData%\ArcRecall\logs` on Windows (or the corresponding local-data
directory on other platforms). Each file is capped at 5 MiB and up to five
files are retained by default, for a 25 MiB total limit. The total limit can be
set from 5 to 500 MiB under Settings → Application; the oldest shards are
removed automatically when it is reached. The Logs page supports
human-readable summaries with expandable technical details, level/text
filters, automatic refresh, export, clearing, opening the log directory, and
consistent SQLite snapshots that include committed WAL data.

The default verbosity is `info`; switch between `error`, `warn`, `info`, and
`debug` in the same settings card. Passwords, dictionary candidate contents,
and user paths are never intentionally logged, and sensitive context fields
are redacted before persistence.

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

Before submitting changes, read the [contribution guide](./CONTRIBUTING.en.md) and run the checks relevant to your changes.

## License

ArcRecall is licensed under the [Apache License 2.0](./LICENSE).

## Disclaimer

ArcRecall is intended for learning, research, and technical exchange. Only process files you own or are explicitly authorized to access, and make sure your use complies with applicable laws and regulations. You are responsible for any consequences caused by mistakes, data loss, unauthorized access, or other misuse.
