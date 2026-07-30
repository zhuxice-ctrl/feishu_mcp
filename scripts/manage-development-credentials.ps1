#Requires -Version 5.1
#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Manage DPAPI-encrypted development credentials for Feishu MCP.

.DESCRIPTION
    Prompts for a secret with Read-Host -AsSecureString, encrypts it with DPAPI
    (CurrentUser scope), and stores the blob under
    $env:APPROVAL_DATA_DIR\credentials\<id>.blob with an owner-only ACL.
    Lists only id, kind, alias, fingerprint, and timestamps — never a secret.
    It NEVER accepts a plaintext secret on the command line.

.PARAMETER Action
    create | list | remove

.PARAMETER Id
    Credential id (for list/remove).

.PARAMETER Kind
    keystore | key

.PARAMETER Alias
    Human-readable alias.

.PARAMETER Fingerprint
    Certificate fingerprint (SHA-256 colon-separated).
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("create", "list", "remove")]
    [string]$Action,

    [string]$Id,
    [ValidateSet("keystore", "key")]
    [string]$Kind,
    [string]$Alias,
    [string]$Fingerprint
)

$ErrorActionPreference = "Stop"

if (-not $env:APPROVAL_DATA_DIR) {
    throw "APPROVAL_DATA_DIR is not set."
}

$CredDir = Join-Path $env:APPROVAL_DATA_DIR "credentials"
if (-not (Test-Path -LiteralPath $CredDir)) {
    [System.IO.Directory]::CreateDirectory($CredDir) | Out-Null
}

$IndexPath = Join-Path $CredDir "index.json"

function Read-Index {
    if (Test-Path -LiteralPath $IndexPath) {
        Get-Content -LiteralPath $IndexPath -Raw | ConvertFrom-Json
    } else {
        @()
    }
}

function Write-Index($entries) {
    $json = $entries | ConvertTo-Json -Depth 5
    if ($entries.Count -eq 1) { $json = @($entries) | ConvertTo-Json -Depth 5 }
    $tmp = "$IndexPath.$PID.tmp"
    Set-Content -LiteralPath $tmp -Value $json -Encoding UTF8
    # Owner-only ACL on the temp file before rename.
    $acl = Get-Acl -LiteralPath $tmp
    $acl.SetAccessRuleProtection($true, $false)
    $owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        $owner, "FullControl", "Allow")
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $tmp -AclObject $acl
    Rename-Item -LiteralPath $tmp -NewName "index.json" -Force
}

switch ($Action) {
    "create" {
        if (-not $Kind -or -not $Alias -or -not $Fingerprint) {
            throw "Kind, Alias, and Fingerprint are required for create."
        }
        # Prompt for the secret — NEVER accept it as a command-line argument.
        $secret = Read-Host -AsSecureString -Prompt "Enter secret for $Alias"
        $plain = [System.Net.NetworkCredential]::new("", $secret).Password
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($plain)
        $encrypted = [System.Security.Cryptography.ProtectedData]::Protect(
            $bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
        $newId = [guid]::NewGuid().ToString()
        $blobPath = Join-Path $CredDir "$newId.blob"
        [System.IO.File]::WriteAllBytes($blobPath, $encrypted)
        # Owner-only ACL on the blob.
        $acl = Get-Acl -LiteralPath $blobPath
        $acl.SetAccessRuleProtection($true, $false)
        $owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
            $owner, "FullControl", "Allow")
        $acl.AddAccessRule($rule)
        Set-Acl -LiteralPath $blobPath -AclObject $acl
        # Zero the plaintext from memory.
        for ($i = 0; $i -lt $plain.Length; $i++) { $plain[$i] = [char]0 }
        $entries = @(Read-Index)
        $entries += [pscustomobject]@{
            id = $newId
            kind = $Kind
            alias = $Alias
            fingerprint = $Fingerprint
            createdAt = (Get-Date).ToString("o")
            updatedAt = (Get-Date).ToString("o")
        }
        Write-Index $entries
        Write-Output "created $newId"
    }
    "list" {
        $entries = @(Read-Index)
        $entries | ForEach-Object {
            [pscustomobject]@{
                id = $_.id
                kind = $_.kind
                alias = $_.alias
                fingerprint = $_.fingerprint
                createdAt = $_.createdAt
                updatedAt = $_.updatedAt
            }
        } | Format-Table
    }
    "remove" {
        if (-not $Id) { throw "Id is required for remove." }
        $blobPath = Join-Path $CredDir "$Id.blob"
        if (Test-Path -LiteralPath $blobPath) {
            Remove-Item -LiteralPath $blobPath -Force
        }
        $entries = @(Read-Index) | Where-Object { $_.id -ne $Id }
        Write-Index $entries
        Write-Output "removed $Id"
    }
}
