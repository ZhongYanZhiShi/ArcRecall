import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

test(
  "Windows 签名密码经真实签名验证后加密保存，错误密码和失效记录不会复用",
  {
    skip: process.platform !== "win32",
  },
  (t) => {
    const repository = fileURLToPath(new URL("../", import.meta.url))
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "arcrecall-password-test-")
    )
    t.after(() => {
      assert.equal(path.dirname(directory), path.resolve(os.tmpdir()))
      assert.ok(path.basename(directory).startsWith("arcrecall-password-test-"))
      rmSync(directory, { recursive: true, force: true })
    })
    const key = path.join(directory, "fixture.key")
    const password = randomBytes(24).toString("base64url")
    const env = { ...process.env, CI: "true" }
    for (const name of [
      "TAURI_SIGNING_PRIVATE_KEY",
      "TAURI_SIGNING_PRIVATE_KEY_PATH",
      "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
      "PSModulePath",
    ])
      delete env[name]
    const generated = spawnSync(
      process.execPath,
      [
        path.join(repository, "node_modules/@tauri-apps/cli/tauri.js"),
        "signer",
        "generate",
        "--ci",
        "--password",
        password,
        "--write-keys",
        key,
      ],
      { env, encoding: "utf8", windowsHide: true, timeout: 60000 }
    )
    // Generation prints key material; never include its output in diagnostics.
    assert.equal(
      generated.status,
      0,
      "Disposable signing key generation failed"
    )
    const script = path.join(directory, "check.ps1")
    writeFileSync(
      script,
      "\uFEFF" +
        String.raw`
$ErrorActionPreference = 'Stop'
. (Join-Path $env:ARCRECALL_TEST_REPOSITORY 'scripts/signing-password.ps1')
function Assert-Check($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
$key = Join-Path $PSScriptRoot 'fixture.key'
$cache = Join-Path $PSScriptRoot 'password.dpapi'
$password = ConvertTo-SecureString -String $env:ARCRECALL_TEST_PASSWORD -AsPlainText -Force
$wrong = ConvertTo-SecureString -String 'wrong-fixture-password' -AsPlainText -Force
$originalKey = [IO.File]::ReadAllText($key)
$originalPublic = [IO.File]::ReadAllText("$key.pub")
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = 'fixture-inherited-value'
$env:TAURI_SIGNING_PRIVATE_KEY = 'fixture-inherited-key'
try {
    Assert-Check ($null -eq (Read-SigningPassword -PrivateKey $key -CachePath $cache)) 'Missing cache did not fall back'
    Save-SigningPassword -PrivateKeyPath $key -Password $password -CachePath $cache
    $encrypted = [IO.File]::ReadAllText($cache)
    Assert-Check (-not $encrypted.Contains($env:ARCRECALL_TEST_PASSWORD)) 'Password was saved as plaintext'
    Assert-Check ($env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ceq 'fixture-inherited-value') 'Password environment was not restored'
    Assert-Check ($env:TAURI_SIGNING_PRIVATE_KEY -ceq 'fixture-inherited-key') 'Key environment was not restored'
    foreach ($inputKey in @($key, $originalKey)) {
        $restored = Read-SigningPassword -PrivateKey $inputKey -CachePath $cache
        Assert-Check ($null -ne $restored) 'Saved password could not be read'
        try { Assert-Check ([Net.NetworkCredential]::new('', $restored).Password -ceq $env:ARCRECALL_TEST_PASSWORD) 'DPAPI round trip failed' }
        finally { $restored.Dispose() }
    }
    $acl = Get-Acl -LiteralPath $cache
    Assert-Check $acl.AreAccessRulesProtected 'Cache permissions inherited unexpectedly'
    $allowed = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18')
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        Assert-Check ($allowed -contains $rule.IdentityReference.Value) 'Unexpected cache reader'
    }
    $rejected = $false
    try { Save-SigningPassword -PrivateKeyPath $key -Password $wrong -CachePath $cache }
    catch { $rejected = $true }
    Assert-Check $rejected 'Wrong signing password was accepted'
    Assert-Check ([IO.File]::ReadAllText($cache) -ceq $encrypted) 'Wrong password replaced the saved cache'
    Save-SigningPassword -PrivateKeyPath $key -Password $password -CachePath $cache
    [IO.File]::WriteAllText($key, $originalKey + 'changed')
    Assert-Check ($null -eq (Read-SigningPassword -PrivateKey $key -CachePath $cache)) 'Changed key reused a stale password'
    [IO.File]::WriteAllText($key, $originalKey)
    $record = [IO.File]::ReadAllText($cache) | ConvertFrom-Json
    $record.password = 'invalid-dpapi-record'
    [IO.File]::WriteAllText($cache, ($record | ConvertTo-Json))
    Assert-Check ($null -eq (Read-SigningPassword -PrivateKey $key -CachePath $cache)) 'Damaged DPAPI record did not fall back'
    Remove-SigningPassword -CachePath $cache
    Remove-SigningPassword -CachePath $cache
    Assert-Check (-not [IO.File]::Exists($cache)) 'Forget left a password record'
    Assert-Check ([IO.File]::ReadAllText($key) -ceq $originalKey) 'Original private key was modified'
    Assert-Check ([IO.File]::ReadAllText("$key.pub") -ceq $originalPublic) 'Original public key was modified'
    Write-Output 'Signing validation, DPAPI, ACL, stale-cache fallback and forget passed.'
} finally { $password.Dispose(); $wrong.Dispose() }
`,
      "utf8"
    )
    const incompatibleModules = path.join(directory, "incompatible-modules")
    const securityModule = path.join(
      incompatibleModules,
      "Microsoft.PowerShell.Security"
    )
    mkdirSync(securityModule, { recursive: true })
    writeFileSync(
      path.join(securityModule, "Microsoft.PowerShell.Security.psd1"),
      "@{ RootModule = 'incompatible.psm1'; ModuleVersion = '99.0.0'; FunctionsToExport = @('ConvertTo-SecureString', 'ConvertFrom-SecureString', 'Get-Acl') }"
    )
    writeFileSync(
      path.join(securityModule, "incompatible.psm1"),
      "throw 'Inherited security module is incompatible with this PowerShell host.'"
    )
    for (const extraEnv of [
      {},
      {
        PSModulePath: `${incompatibleModules};${process.env.PSModulePath ?? ""}`,
      },
    ]) {
      const checked = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          script,
        ],
        {
          cwd: repository,
          env: {
            ...env,
            ...extraEnv,
            ARCRECALL_TEST_REPOSITORY: repository,
            ARCRECALL_TEST_PASSWORD: password,
          },
          encoding: "utf8",
          windowsHide: true,
          timeout: 120000,
        }
      )
      assert.ok(
        !`${checked.stdout}${checked.stderr}`.includes(password),
        "Password leaked into output"
      )
      assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}`)
    }
  }
)
