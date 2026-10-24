English | [简体中文](./README.md)

# ArcRecall

**Batch integrity checks** are available for selected scan results and queue items (up to 200 per batch). Checks run sequentially and continue after failures. Cancel while retaining completed results, retry only failed entries with a corrected password, or select only passing entries before confirming import. Retries retain other entries and their original check times. Split volumes are grouped. Passwords are session-only and cleared from the input after completion; no dictionary search is performed. Results describe files at the time of checking, without separately checking nested archives. Export JSON/CSV reports with optional file paths (off by default). Starting another batch replaces the backend's current results; export before replacing them or exiting.

**Queue management** adds up/down ordering for waiting items, bulk removal, and applying a validated preset to selected waiting items. Presets preserve session passwords and recalculate output locations. **Pause after current item** allows the active archive to finish before stopping scheduling; resume when ready or cancel the pause request. **Stop batch** still cancels the active task. Editing is available while idle or paused. Optional queue memory preserves ordering and processing options, but never passwords or engine progress; restarting still requires manual execution.

**Processing presets** save output location, dictionary group, recursive extraction, compute mode and whether to open the output when done, without passwords. Save up to 100 presets; replacing an existing name requires confirmation. Applying a preset checks that its output directory and dictionary group still exist. Presets affect current options and subsequent imports, preserving dedicated options on queued tasks. They are stored in `processing-presets.db` and included in unified backups.

**Scan folder** detects archives by content, optionally searches subfolders, and groups split volumes into one entry. It skips links and junctions, reports inaccessible or invalid candidates, and neither extracts nor tests archive integrity. Filter and select results before confirming import; new items capture current processing options and never start automatically or reset existing queued items. Scanning stops at 20,000 filesystem entries, 1,000 archives or 32 subfolder levels, with at most 100 warnings. Cancellation retains partial results for confirmation. The queue limit remains 200 archives per batch.

New workflow tools: read-only archive previews (searchable paths, declared sizes and encryption flags; up to 5,000 displayed entries), dictionary groups with per-task selection, and recovery task records under History. Encrypted directory listings use the known password entered on the extraction page. Previews never extract files or expand nested archives.

From the preview, select files or directory subtrees and choose **Extract selected**. Output goes into a fresh `ArcRecall-selected-*` folder under your chosen parent, preserving internal paths. Failed or cancelled extraction cleans up its partial output. Selection is unavailable for listings over 5,000 entries, links, unsafe or duplicate paths. It uses the supplied password without dictionary recovery, nested extraction or layout cleanup, and does not add recovery history records. **Check integrity** tests the entire archive with 7-Zip without extracting to an output folder; encrypted entries require the correct password. Failures may indicate a wrong password, missing volumes or corruption. Both operations can be cancelled. Split archives and LZ4 wrappers may need temporary working copies; nested archive contents are not separately checked.

Candidates may belong to multiple groups. Adding or importing while a group is selected assigns candidates to that group; removing membership or deleting a group preserves the candidates. Groups are included in dictionary backups; restoring an older backup clears existing groups. Known and locally remembered passwords still take precedence over the selected dictionary. A missing group must be reselected and never silently falls back to the full dictionary.

Task records cover recovery, compression, selective extraction, and individual/batch integrity checks. Search by literal filename/path, operation, status, and local calendar dates before pagination. Apply the search form before exporting; JSON/CSV exports include all matching records (up to 10,000 records / 64 MiB), with paths excluded by default and no passwords. Confirm bulk deletion of selected records without deleting source/output files; running records are retained. Failed items from a historical batch check can be checked again as a new task.

Unified `.arcrecall` backups include dictionaries, groups, protected password history, processing presets, task records, and general update/logging/recovery settings. They exclude queues, engine paths, AI configuration and credentials, and default compression passwords. Restores preview the frozen snapshot, create a full safety backup, and roll back on failure or an interrupted restore at the next startup. Legacy database backups still restore only dictionary/history data. Protected history passwords require the original Windows account.

Automatic backup management under Settings → Data is off by default. Choose a local directory, daily/weekly frequency, and 1–100 retained copies. The native application checks once per minute while running, waits for idle time, and catches up at the next startup; it does not wake a closed application. Failures retain old files and retry no sooner than five minutes later. Only after a successful backup does retention remove unchanged, registered automatic backups in the currently configured directory. Manual backups, restore safety backups, other files, and previous directories are preserved. The list supports refresh, locating files, and restore preview. Run now uses the saved policy, including retention. Scheduling configuration and the ownership catalog remain local in `backup-management.db` and are excluded from portable backups.

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

During dictionary recovery, 7-Zip shows the current candidate index and checked count; John shows its reported percentage and candidate range; Hashcat shows computation progress, speed, and estimated remaining time. Candidate previews are hidden by default and can be revealed with the eye button. They stay in live task state and are excluded from events, logs, and exported reports. Parallel engine progress does not identify a single candidate.

- Identify formats from file contents and create copies with correct extensions, leaving originals unchanged.
- Extract nested archives recursively, verify known passwords, and recover passwords using local dictionaries.
- Process batches with cancellation, retry, and optional task queue persistence.
- Save recovery history, export JSON / CSV reports, and back up dictionaries and history.
- Create 7z / ZIP archives with optional passwords.
- Save compression presets and naming templates, and prepare a new compression draft from task records.

Compression presets store format, level, filename encryption, output directory, the open-on-completion option, and a naming template (up to 100 presets). Templates support `{name}` and the local `{date}`. Sources, passwords, credential references, and AI settings are excluded. Applying a preset checks that its output directory still exists; overwriting or deleting a preset requires confirmation.

Compression records can replace the current draft after confirmation, without starting a task. Missing sources must be removed or reselected, and missing output directories must be reselected. Encrypted retries require a freshly entered and confirmed password; saved credentials are not used automatically. Existing output files are preserved with collision-safe naming. Older records without compression parameters cannot restore a draft. Retried drafts default to no AI naming and no automatic output-folder opening.

New unified backups use version 3 and include compression presets, automatic-verification options, and separate compression and verification outcomes. Versions 1 and 2 remain readable; older presets default to no automatic verification. Version 1 and legacy database restores preserve local compression presets. Automatic and pre-restore safety backups include these fields too. Presets are stored in `compression-presets.db`.

Compression supports one archive containing all sources or a separate archive per source. Separate compression uses the preset's `{name}` / `{date}` template, without AI naming. Start immediately or enqueue first to reorder waiting items. The session-only queue holds up to 200 items, continues after failures, supports pause after the current item, cancellation with waiting items retained, removal, and requeuing failed items. Switching pages does not stop it; exiting discards the queue while retaining execution records. Encrypted items use the password selected for the current run; passwords are excluded from queue snapshots. Automatic folder opening occurs once at batch completion.

Optional post-compression verification tests the output using the current password. Compression and verification outcomes are recorded separately; failed or cancelled checks preserve the generated archive. Task records offer independent output verification with a fresh password and a separate check record. Requeuing a failed compression item creates a new archive; use independent verification to avoid recompression. Nested archives are not recursively tested.

Supports detection, password verification, and recursive extraction for 7z, ZIP / ZIP64, and RAR3 / RAR5, with these limits:

| Format      | Volume support and limits                                                     |
| ----------- | ----------------------------------------------------------------------------- |
| 7z          | Supports contiguous numbered volumes                                          |
| ZIP / ZIP64 | Supports `.z01 … .zip` and `.zip.001 …` volumes                               |
| RAR3 / RAR5 | Encryption variants depend on engine support; multipart support is incomplete |
| LZ4 Frame   | Only unwraps supported inner archives                                         |

Split archives require a complete volume set. Creating split archives is not supported. Password recovery is not guaranteed; GPU recovery requires a usable Hashcat device.

Nested scanning skips directories with more than 10 direct files and their subdirectories by default. Adjust this under Settings → Recovery engines, or rescan from the most recent task's results in the current session.

After successful extraction, newly created empty directory chains are removed from the deepest level outward by default. Disable this under Settings → Recovery engines → Smart empty-folder cleanup. Removal is nonrecursive. Each archive's output root, pre-existing directories, directory links, directories with NTFS named data streams, and directories containing any files (including hidden and zero-byte files) are preserved. Files are not moved and directory levels are not merged. Task results show the cleanup count; directories that cannot be reliably checked or removed, or remain unprocessed after cancellation, are retained.

**Remove redundant nested folders** is enabled by default alongside empty-folder cleanup. It only folds a leading chain of at least two single-child directories whose names exactly match the archive name without its final extension, retaining one original named directory. For example, `project.zip` containing `output/project/project/src/main` becomes `output/project/src/main`. A single named directory, ordinary date or chapter hierarchies, different names, siblings and payload branches are preserved; approximate names are never guessed. Entirely empty chains are left to the independent cleanup setting. Pre-existing output directories and trees containing links or NTFS directory data streams are preserved. Folding happens before nested archive discovery, never overwrites an occupied destination, and revalidates the structure after moving. Failed moves are rolled back when possible; otherwise, all contents are retained and their location is shown in task details. Both settings are independent and persisted. Repeated names can still carry meaning that the application cannot infer; disable folding if every original path must remain intact.

## Local development

Requires stable Rust, Node.js 22.12+ (22.x) or 24+, pnpm 10+, mise, and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/). See [mise.toml](./mise.toml) for pinned tool versions.

```powershell
git clone https://github.com/ZhongYanZhiShi/ArcRecall.git
cd ArcRecall
mise install
pnpm install
pnpm dev
```

Build the full engine edition:

```powershell
pnpm desktop:build
```

Use `pnpm desktop:build:basic` to build the basic edition. For signed local packaging, `pnpm package` creates both EXE installers, their `.sig` files, and a `latest.json` pointing to the basic edition in `artifacts/package-vVERSION-*`.

`pnpm dev` starts the desktop app. Use `pnpm dev:web` for browser preview, which is for UI development; file processing requires the desktop app. See the [contribution guide](./CONTRIBUTING.en.md) for project structure and development checks.

## Contributing and license

[Issues](https://github.com/ZhongYanZhiShi/ArcRecall/issues) and pull requests are welcome. See the [contribution guide](./CONTRIBUTING.en.md).

Licensed under [Apache License 2.0](./LICENSE). Only process files you own or are authorized to access.
