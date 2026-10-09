param(
    [ValidateSet('Remember', 'Forget', 'Help')][string]$Action = 'Help',
    [string]$KeyPath = (Join-Path $env:USERPROFILE '.tauri/arc-recall.key')
)

# A Windows PowerShell child can inherit PowerShell 7's module search path.
# Load this host's built-in security module for DPAPI and ACL commands.
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop

function Get-SigningPasswordCachePath {
    return Join-Path $env:USERPROFILE '.tauri/arc-recall.password.dpapi'
}

function Get-SigningKeyDigest {
    param([Parameter(Mandatory = $true)][string]$PrivateKey)
    $contents = if ([IO.File]::Exists($PrivateKey)) { [IO.File]::ReadAllText($PrivateKey) } else { $PrivateKey }
    $bytes = [Text.Encoding]::UTF8.GetBytes($contents.Trim())
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($hash.ComputeHash($bytes)).Replace('-', '') }
    finally { $hash.Dispose(); [Array]::Clear($bytes, 0, $bytes.Length); $contents = $null }
}

function Read-SigningPassword {
    param([string]$PrivateKey, [string]$CachePath = (Get-SigningPasswordCachePath))
    if (-not [IO.File]::Exists($CachePath)) { return $null }
    try {
        $record = [IO.File]::ReadAllText($CachePath) | ConvertFrom-Json
        if ($record.version -ne 1 -or $record.keyDigest -cne (Get-SigningKeyDigest $PrivateKey)) {
            throw 'Stale signing password record.'
        }
        # With no -Key, Windows PowerShell uses DPAPI for the current user.
        return ConvertTo-SecureString -String $record.password -ErrorAction Stop
    } catch {
        Write-Warning '本机签名密码记录已失效，将重新询问密码。可运行 pnpm signing:remember 更新记录。'
        return $null
    }
}

function Save-SigningPassword {
    param(
        [Parameter(Mandatory = $true)][string]$PrivateKeyPath,
        [Parameter(Mandatory = $true)][Security.SecureString]$Password,
        [string]$CachePath = (Get-SigningPasswordCachePath)
    )
    if (-not [IO.File]::Exists($PrivateKeyPath)) { throw '找不到签名私钥文件。' }
    if ($Password.Length -eq 0) { throw '空密码无需记住；请继续使用有密码保护的私钥。' }
    $digest = Get-SigningKeyDigest $PrivateKeyPath
    $probe = Join-Path ([IO.Path]::GetTempPath()) ('arcrecall-signing-' + [guid]::NewGuid().ToString('N') + '.txt')
    $temporary = "$CachePath.$([guid]::NewGuid().ToString('N')).tmp"
    $names = @('TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PATH', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD', 'CI')
    $previous = @{}
    foreach ($name in $names) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
    try {
        [IO.File]::WriteAllText($probe, 'ArcRecall signing password verification only.')
        [Environment]::SetEnvironmentVariable('TAURI_SIGNING_PRIVATE_KEY', $null, 'Process')
        [Environment]::SetEnvironmentVariable('TAURI_SIGNING_PRIVATE_KEY_PATH', $null, 'Process')
        $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = [Net.NetworkCredential]::new('', $Password).Password
        $env:CI = 'true'
        $cli = Join-Path $PSScriptRoot '../node_modules/@tauri-apps/cli/tauri.js'
        try {
            & node $cli signer sign --private-key-path $PrivateKeyPath $probe *> $null
            if ($LASTEXITCODE -ne 0 -or -not [IO.File]::Exists("$probe.sig")) { throw 'Signing failed.' }
        } catch { throw '签名密码验证失败，未保存记录。请核对私钥及 Bitwarden 中的密码。' }
        if ($digest -cne (Get-SigningKeyDigest $PrivateKeyPath)) { throw '验证期间私钥发生变化，未保存记录。' }
        $record = @{ version = 1; keyDigest = $digest; password = (ConvertFrom-SecureString -SecureString $Password) }
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($CachePath))
        [IO.File]::WriteAllText($temporary, ($record | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
        foreach ($destination in @($temporary, $CachePath)) {
            if (-not [IO.File]::Exists($destination)) { continue }
            $acl = New-Object Security.AccessControl.FileSecurity
            $acl.SetAccessRuleProtection($true, $false)
            foreach ($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
                $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow'))
            }
            [IO.File]::SetAccessControl($destination, $acl)
        }
        if ([IO.File]::Exists($CachePath)) {
            [IO.File]::Replace($temporary, $CachePath, [System.Management.Automation.Language.NullString]::Value)
        } else { [IO.File]::Move($temporary, $CachePath) }
    } finally {
        foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
        foreach ($file in @($probe, "$probe.sig", $temporary)) { if ([IO.File]::Exists($file)) { [IO.File]::Delete($file) } }
    }
}

function Remove-SigningPassword {
    param([string]$CachePath = (Get-SigningPasswordCachePath))
    if ([IO.File]::Exists($CachePath)) { [IO.File]::Delete($CachePath) }
}

if ($MyInvocation.InvocationName -ne '.') {
    $ErrorActionPreference = 'Stop'
    $secret = $null
    try {
        switch ($Action) {
            'Remember' {
                Write-Host '密码将用当前 Windows 账户加密，保存在仓库外；同一账户运行的程序也能使用它。'
                $secret = Read-Host '私钥密码（隐藏输入，仅需保存一次）' -AsSecureString
                Save-SigningPassword -PrivateKeyPath $KeyPath -Password $secret
                Write-Host '验证并保存成功。以后 pnpm package / pnpm release 自动读取；清除请运行 pnpm signing:forget。'
            }
            'Forget' {
                Remove-SigningPassword
                Write-Host '已清除本机密码记录，私钥及 Bitwarden 备份不受影响。'
            }
            'Help' { Write-Host 'pnpm signing:remember：验证并加密保存密码；pnpm signing:forget：清除记录。自定义私钥可加 -KeyPath 完整路径。' }
        }
    } catch {
        Write-Host $_.Exception.Message -ForegroundColor Red
        exit 1
    } finally { if ($secret) { $secret.Dispose() } }
}
