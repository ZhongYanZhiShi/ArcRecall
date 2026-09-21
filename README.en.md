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

## Features

- Detect actual formats from file signatures and internal structure
- Inspect and unpack nested archives one layer at a time
- Detect encryption and verify passwords locally
- Keep processing records for later review
- Keep local structured runtime logs with diagnostic export and SQLite backup
- Queue multiple selected or dropped files, or pasted paths, and extract them in order with per-item results
- Create separate copies with correct extensions, copying and consistently naming every archive volume
- Show dictionary import progress with cancellation, and live Hashcat progress and speed

A batch accepts up to 200 items. Stopping a batch preserves waiting items, and
failed or cancelled items can be queued again. The queue is cleared when the app
exits. Each archive uses a separate output directory; the batch's preferred
password is used only for that batch and is not saved in browser storage.
Hashcat progress describes the current engine attempt and starts over when the
mode changes or the next nested archive begins.

By default, nested-archive scanning skips directories containing more than 10
direct files, along with their subdirectories. Other sibling directories are
still scanned, and extracted content is preserved. Adjust the limit under
Settings → Recovery engines → Directory scan file limit; set it to 0 to remove
the file-count limit. Changes apply to new tasks. The detailed process view and
completion summary explain skipped directories.

Each recovery task shares a cumulative extraction budget of 100 GiB and 100,000
files or directories. LZ4 decoding and split-volume copy fallbacks also count
toward the byte budget. Windows checks available disk space before extraction,
then checks actual output and remaining space every 500 ms while reserving at
least 256 MiB. The budget can be briefly exceeded between checks; reaching it
stops recursion and preserves completed output. Other platforms enforce the
cumulative budget but currently do not query available disk space.

## Recovery history

Successfully processed root and nested archives are stored in the local SQLite
database using a full-content SHA-256 fingerprint. Recognized volumes are
fingerprinted together in their resolved order. Recovery tasks calculate this
fingerprint and look up saved passwords in the background, so renaming an
archive does not break a match while changing any byte produces a new one.
The History page shows fingerprint prefixes, format, size, volume count, and
verification times, with search, password reveal/copy, per-entry deletion, and
clear-all actions. Source filenames, paths, and dictionary contents are not
stored.

Saved history passwords are protected with Windows DPAPI CurrentUser before
they reach the local database and are tried before the global dictionary when
the same content is processed again. Legacy plaintext records are migrated at
application startup, and passwords are not written to runtime logs. Revealed
or copied passwords are hidden automatically; clipboard contents are cleared
after a delay only if another value has not replaced them.

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

Settings → Data can create backups or restore the dictionary and history from a
backup in the current format. Before confirmation, the app shows record counts,
checks integrity, and verifies that the current Windows account can decrypt
saved passwords. It then backs up the current database and replaces the data
in a transaction, rolling back on failure. Backups do not include application
settings, AI API keys, or the permanent compression password. Restore backups
containing DPAPI-protected passwords using the Windows account that created
them; backups with unreadable passwords are blocked.

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
- Node.js 22.x (22.12 or later) or version 24 and above, plus [pnpm](https://pnpm.io/) 10 or later
- The platform dependencies listed in the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

The test command requires `--experimental-strip-types` and does not support Node.js 20. See `mise.toml` for pinned development tool versions.

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

Development builds also process multi-GB archives, so the workspace enables
optimization for `sha2`. All formats still use full-content SHA-256 fingerprints,
complete password verification, and the same extraction process; this setting
does not change fingerprint or password-matching rules. Release builds already
enable optimization by default.

To investigate processing time for large archives, explicitly run the performance
probes in PowerShell. They are excluded from the default test run:

```powershell
$env:ARC_RECALL_PROFILE_ARCHIVE = 'E:/archives/example.7z'
# Read-only archive analysis and full fingerprint timing, including split archives.
cargo test -p arc-recall-core profile_archive_fingerprint -- --ignored --nocapture
# Windows native recovery timing using local history, dictionary, and engine settings.
cargo test -p arc-recall-desktop profile_local_archive_recovery -- --ignored --nocapture
```

The native probe requires a matching local-history password for the root archive.
It creates temporary output alongside the archive and removes it afterward. It
does not update history or the dictionary, or print passwords. Nested archives
use the normal recovery process; the probe fails if any archive is skipped.

## Development checks

Debug builds accept an absolute `ARC_RECALL_TEST_DATA_ROOT` to isolate the database, settings, and logs for native tests. It points directly to the ArcRecall data directory and is ignored by release builds. System credentials and the clipboard still belong to the current OS user; tests of those interfaces should use separate synthetic records and clean up afterward.

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

## Releasing

The repository's GitHub Actions workflow builds the full Windows x64 installer,
generates release notes, and creates a GitHub Release whenever a semantic version
tag is pushed. Before releasing, make sure the versions in `package.json`,
`src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` match, then run:

```powershell
git tag v0.1.0
git push origin v0.1.0
```

You can also run the `Release` workflow manually from GitHub Actions with an
existing version tag. Pre-release tags such as `v0.2.0-beta.1` are published as
GitHub pre-releases automatically.

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
