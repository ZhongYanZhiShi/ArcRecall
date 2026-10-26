param([switch]$InstallIfMissing)

$ErrorActionPreference = 'Stop'

# Microsoft documents these per-machine and per-user Evergreen Runtime keys:
# https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution
function Get-WebView2RuntimeVersion {
    $client = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    foreach ($registryPath in @(
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$client",
        "HKCU:\Software\Microsoft\EdgeUpdate\Clients\$client"
    )) {
        $value = Get-ItemPropertyValue -LiteralPath $registryPath -Name 'pv' -ErrorAction SilentlyContinue
        $version = $null
        if ([version]::TryParse($value, [ref]$version) -and $version -gt [version]'0.0.0.0') {
            return $version.ToString()
        }
    }
    return $null
}

$runtimeVersion = Get-WebView2RuntimeVersion
if ($runtimeVersion) {
    Write-Host "WebView2 Runtime ready: $runtimeVersion"
    exit 0
}
if (-not $InstallIfMissing) { throw 'WebView2 Runtime is not installed.' }

Write-Host 'WebView2 Runtime is missing; installing the official Evergreen Runtime.'
$installer = Join-Path ([IO.Path]::GetTempPath()) 'MicrosoftEdgeWebview2Setup.exe'
Invoke-WebRequest -UseBasicParsing -Uri 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $installer
$installation = Start-Process -FilePath $installer -ArgumentList '/silent', '/install' -Wait -PassThru -WindowStyle Hidden
if ($installation.ExitCode -ne 0) { throw "WebView2 Runtime installation failed: $($installation.ExitCode)" }
$runtimeVersion = Get-WebView2RuntimeVersion
if (-not $runtimeVersion) { throw 'WebView2 Runtime was not registered after installation.' }
Write-Host "WebView2 Runtime ready: $runtimeVersion"
