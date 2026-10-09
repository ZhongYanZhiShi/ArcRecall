# Contributing to ArcRecall

English | [中文](./CONTRIBUTING.md)

Thanks for helping improve ArcRecall. Issues and pull requests may be written in English or Chinese.

## Before you start

- Search existing issues and pull requests before opening a new one.
- Use an issue to discuss larger features or changes that affect the project structure.
- Do not include passwords, private file names, archive contents, or other sensitive data in examples and logs.

## Reporting a bug

Use the bug report template and include:

- Clear reproduction steps
- The expected and actual behavior
- The affected application and environment
- A minimal sample or sanitized logs when they are safe to share

## Suggesting a feature

Describe the use case before the proposed implementation. Explain what is difficult today, what result you want, and any alternatives you considered.

## Pull requests

- Keep each pull request focused on one concern.
- Link the related issue when one exists.
- Explain both the reason for the change and the resulting behavior.
- Add screenshots for visible desktop interface changes.
- Update documentation when setup, commands, or behavior changes.
- Avoid unrelated formatting changes, generated output, and dependency updates.

## Project structure

- `src/`: Next.js UI.
- `src-tauri/`: Tauri desktop adapters.
- `crates/arc-recall-core/`: Rust core logic.

See the [README](./README.en.md#local-development) for setup, launch, and build instructions.

## Validation

Run the checks relevant to the part of the project you changed. Record the commands and results in the pull request instead of checking boxes for components you did not touch.

```powershell
pnpm lint
pnpm typecheck
pnpm test
cargo test --workspace --all-targets --all-features
```

Running `pnpm install` enables the pre-commit hook. Before each commit, it
checks Oxfmt and `cargo fmt`; if the check fails, run:

```powershell
pnpm format
cargo fmt --all
```

The repository does not currently enforce a commit message format.

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](./LICENSE).
