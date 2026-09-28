$ErrorActionPreference = 'Stop'

# Run in a child PowerShell so signing credentials do not persist in the caller.
Push-Location (Join-Path $PSScriptRoot '..')
try {
    $packageOnly = $args -contains '--package-only'
    $entry = if ($packageOnly) { 'release-local.mjs' } else { 'release-wizard.mjs' }
    $entryArgs = @($args)
    if ($args -contains '--help') {
        & node (Join-Path $PSScriptRoot $entry) @entryArgs
        exit $LASTEXITCODE
    }
    if ($packageOnly) {
        if ($args -contains '--publish' -or $args -contains '--tag') {
            throw 'pnpm package 只打包当前版本；新版本发布请使用 pnpm release。'
        }
        $version = (Get-Content -Raw -LiteralPath 'package.json' | ConvertFrom-Json).version
        $entryArgs += @('--tag', "v$version")
    }

    $changes = & git status --porcelain --untracked-files=normal
    if ($LASTEXITCODE -ne 0) { throw '无法读取 Git 状态。' }
    if ($changes) { throw '请先提交业务代码和打包发布脚本，再运行命令；不会自动提交无关改动。' }

    . (Join-Path $PSScriptRoot 'prepare-release-environment.ps1')
    Initialize-ReleaseEnvironment

    if ([string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY)) {
        $keyPath = Join-Path $env:USERPROFILE '.tauri/arc-recall.key'
        if (-not (Test-Path -LiteralPath $keyPath -PathType Leaf)) {
            $keyPath = (Read-Host '请输入已有更新签名私钥的完整路径（不要重新生成）').Trim().Trim('"')
        }
        if (-not (Test-Path -LiteralPath $keyPath -PathType Leaf)) { throw '找不到私钥文件。' }
        $env:TAURI_SIGNING_PRIVATE_KEY = (Resolve-Path -LiteralPath $keyPath).Path
    }

    if ([string]::IsNullOrWhiteSpace($env:TAURI_UPDATER_PUBLIC_KEY)) {
        $publicKeyPath = "$env:TAURI_SIGNING_PRIVATE_KEY.pub"
        if (-not [System.IO.File]::Exists($publicKeyPath)) {
            $publicKeyPath = (Read-Host '请输入对应 .pub 公钥文件的完整路径').Trim().Trim('"')
        }
        $env:TAURI_UPDATER_PUBLIC_KEY = Get-Content -Raw -LiteralPath $publicKeyPath
    }

    if ($null -eq $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
        . (Join-Path $PSScriptRoot 'signing-password.ps1')
        $secret = Read-SigningPassword -PrivateKey $env:TAURI_SIGNING_PRIVATE_KEY
        if ($null -eq $secret) {
            Write-Host '经常打包可先运行 pnpm signing:remember，在本机加密记住密码。'
            $secret = Read-Host '私钥密码（无密码直接回车）' -AsSecureString
        } else { Write-Host '已读取当前 Windows 账户保存的签名密码。' }
        try { $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = [System.Net.NetworkCredential]::new('', $secret).Password }
        finally { $secret.Dispose() }
    }

    & node (Join-Path $PSScriptRoot $entry) @entryArgs
    exit $LASTEXITCODE
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
} finally {
    Pop-Location
}
