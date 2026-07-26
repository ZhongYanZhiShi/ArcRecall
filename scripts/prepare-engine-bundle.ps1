[CmdletBinding()]
param(
    [string]$OutputRoot
)

$ErrorActionPreference = 'Stop'

function Get-Sha256 {
    param([Parameter(Mandatory = $true)][string]$Path)

    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $sha256 = [System.Security.Cryptography.SHA256]::Create()
        try {
            $bytes = $sha256.ComputeHash($stream)
            return ([System.BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
        }
        finally {
            $sha256.Dispose()
        }
    }
    finally {
        $stream.Dispose()
    }
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$metadataRoot = Join-Path $repoRoot 'third-party\engine-bundle\windows-x86_64'
if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $OutputRoot = Join-Path $repoRoot 'src-tauri\resources\engine-bundle\windows-x86_64'
}

$resolvedRepo = [System.IO.Path]::GetFullPath($repoRoot)
$resolvedOutput = [System.IO.Path]::GetFullPath($OutputRoot)
if (-not $resolvedOutput.StartsWith($resolvedRepo, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Output directory must stay inside the repository: $resolvedOutput"
}

$manifestPath = Join-Path $metadataRoot 'manifest.json'
$noticePath = Join-Path $metadataRoot 'THIRD_PARTY_NOTICES.md'
$manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestPath | ConvertFrom-Json

New-Item -ItemType Directory -Force -Path $resolvedOutput | Out-Null

foreach ($resource in $manifest.resources) {
    $destination = [System.IO.Path]::GetFullPath(
        (Join-Path $resolvedOutput ([string]$resource.relativePath))
    )
    if (-not $destination.StartsWith($resolvedOutput, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Resource target escapes the output directory: $destination"
    }

    $destinationDirectory = Split-Path -Parent $destination
    New-Item -ItemType Directory -Force -Path $destinationDirectory | Out-Null

    $valid = $false
    if (Test-Path -LiteralPath $destination -PathType Leaf) {
        $existing = Get-Item -LiteralPath $destination
        if ($existing.Length -eq [int64]$resource.size) {
            $hash = Get-Sha256 -Path $destination
            $valid = $hash -eq ([string]$resource.sha256).ToLowerInvariant()
        }
    }
    if ($valid) {
        Write-Host "Verified cached resource: $($resource.id)"
        continue
    }

    $partial = "$destination.download"
    if (Test-Path -LiteralPath $partial -PathType Leaf) {
        Remove-Item -Force -LiteralPath $partial
    }
    Write-Host "Downloading $($resource.id): $($resource.url)"
    Invoke-WebRequest -UseBasicParsing -Uri $resource.url -OutFile $partial

    $download = Get-Item -LiteralPath $partial
    if ($download.Length -ne [int64]$resource.size) {
        Remove-Item -Force -LiteralPath $partial
        throw "$($resource.id) size mismatch: $($download.Length)"
    }
    $actualHash = Get-Sha256 -Path $partial
    if ($actualHash -ne ([string]$resource.sha256).ToLowerInvariant()) {
        Remove-Item -Force -LiteralPath $partial
        throw "$($resource.id) SHA-256 mismatch: $actualHash"
    }

    if (Test-Path -LiteralPath $destination -PathType Leaf) {
        Remove-Item -Force -LiteralPath $destination
    }
    Move-Item -LiteralPath $partial -Destination $destination
}

Copy-Item -Force -LiteralPath $manifestPath -Destination (Join-Path $resolvedOutput 'manifest.json')
Copy-Item -Force -LiteralPath $noticePath -Destination (Join-Path $resolvedOutput 'THIRD_PARTY_NOTICES.md')

$totalBytes = ($manifest.resources | Measure-Object -Property size -Sum).Sum
$totalMiB = [Math]::Round($totalBytes / 1MB, 1)
Write-Host "Full engine resources are ready: $resolvedOutput ($totalMiB MiB)"
