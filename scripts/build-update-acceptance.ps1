param([Parameter(Mandatory)][string]$Config, [switch]$Bundle)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
. "$PSScriptRoot/prepare-release-environment.ps1"
Initialize-ReleaseEnvironment
$env:TAURI_CONFIG = Get-Content -Raw -LiteralPath $Config
cargo build -p arc-recall-desktop --features tauri/custom-protocol
if ($LASTEXITCODE -ne 0) { throw 'Acceptance binary build failed.' }
if ($Bundle) {
    & node node_modules/@tauri-apps/cli/tauri.js bundle --debug --bundles nsis --config $Config --no-sign --ci
    if ($LASTEXITCODE -ne 0) { throw 'Acceptance installer build failed.' }
}
