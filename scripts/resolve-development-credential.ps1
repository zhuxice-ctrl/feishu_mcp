#Requires -Version 5.1
<#
.SYNOPSIS
    Resolve one fixed-path DPAPI credential to UTF-8 standard output.

.DESCRIPTION
    Accepts only an opaque canonical credential identifier. The encrypted blob
    is always APPROVAL_DATA_DIR\credentials\<id>.blob. No plaintext is written
    to a file, diagnostic stream, command argument, or metadata.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$CredentialId
)

$ErrorActionPreference = "Stop"
$plainBytes = $null
$encrypted = $null

function Get-TrustedDirectory([string]$Path) {
    $full = [System.IO.Path]::GetFullPath($Path)
    $root = [System.IO.Path]::GetPathRoot($full)
    if (-not $root) { throw "unavailable" }
    $current = $root
    $relative = $full.Substring($root.Length)
    foreach ($component in $relative.Split([char[]]@('\', '/'), [System.StringSplitOptions]::RemoveEmptyEntries)) {
        $current = [System.IO.Path]::Combine($current, $component)
        $item = Get-Item -Force -LiteralPath $current
        if (-not $item.PSIsContainer -or (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
            throw "unavailable"
        }
    }
    return Get-Item -Force -LiteralPath $full
}

try {
    $parsedId = [guid]::Empty
    if (-not [guid]::TryParse($CredentialId, [ref]$parsedId) -or $parsedId.ToString() -cne $CredentialId) {
        throw "unavailable"
    }
    if (-not $env:APPROVAL_DATA_DIR) { throw "unavailable" }

    $approvalItem = Get-TrustedDirectory $env:APPROVAL_DATA_DIR
    $credentialPath = [System.IO.Path]::Combine($approvalItem.FullName, "credentials")
    $credentialItem = Get-TrustedDirectory $credentialPath
    if ([System.IO.Path]::GetFullPath($credentialItem.FullName) -cne [System.IO.Path]::GetFullPath($credentialPath)) {
        throw "unavailable"
    }

    $blobPath = [System.IO.Path]::Combine($credentialItem.FullName, "$CredentialId.blob")
    $blobItem = Get-Item -Force -LiteralPath $blobPath
    if ($blobItem.PSIsContainer -or (($blobItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw "unavailable"
    }
    if ([System.IO.Path]::GetFullPath($blobItem.Directory.FullName) -cne [System.IO.Path]::GetFullPath($credentialItem.FullName)) {
        throw "unavailable"
    }
    if ($blobItem.Length -le 0 -or $blobItem.Length -gt 65536) { throw "unavailable" }

    $encrypted = [System.IO.File]::ReadAllBytes($blobItem.FullName)
    $plainBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
        $encrypted, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    if ($plainBytes.Length -gt 4096) { throw "unavailable" }
    $strictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
    [void]$strictUtf8.GetString($plainBytes)
    $stdout = [System.Console]::OpenStandardOutput()
    $stdout.Write($plainBytes, 0, $plainBytes.Length)
    $stdout.Flush()
    [System.Array]::Clear($encrypted, 0, $encrypted.Length)
    [System.Array]::Clear($plainBytes, 0, $plainBytes.Length)
    exit 0
} catch {
    if ($null -ne $encrypted) { [System.Array]::Clear($encrypted, 0, $encrypted.Length) }
    if ($null -ne $plainBytes) { [System.Array]::Clear($plainBytes, 0, $plainBytes.Length) }
    exit 1
}
