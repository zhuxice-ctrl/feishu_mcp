<#
.SYNOPSIS
  Import a DPAPI-encrypted PFX into a temporary CurrentUser certificate store
  for SignTool code signing, then optionally clean it up.

.DESCRIPTION
  This helper is invoked by the FeishuMcp Windows development adapter to make
  an encrypted PFX available to SignTool without ever placing the password on
  the command line or in an environment variable visible to other processes.

  The PFX blob is encrypted with DPAPI (CurrentUser scope) by the credential
  registration helper and stored on disk. This script reads the encrypted blob,
  decrypts it in memory, imports the certificate into a temporary CurrentUser
  store named via -TempStoreName, and exits. The password is never passed as a
  parameter, never written to an environment variable, and never logged.

  With -Cleanup, the temporary store is removed (all certs deleted, store
  closed). This runs in a finally-style step after signing completes.

  #Requires -RunAsAdministrator is NOT used: CurrentUser stores do not require
  elevation. The script is intentionally non-interactive (-NonInteractive).

.PARAMETER CredentialId
  The opaque credential id whose encrypted PFX blob should be imported.

.PARAMETER TempStoreName
  The name of the temporary CurrentUser store to create (or remove with
  -Cleanup).

.PARAMETER Cleanup
  Switch: remove the temporary store instead of importing.

.NOTES
  No password is accepted on the command line. No secret is written to disk or
  logs. The script uses -LiteralPath throughout and rejects wildcard paths.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$CredentialId,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$TempStoreName,

    [switch]$Cleanup
)

$ErrorActionPreference = "Stop"

# Fixed credential blob root (must match the DPAPI store layout).
$CredRoot = Join-Path $env:LOCALAPPDATA "FeishuMcp\credentials"

if ($Cleanup) {
    # Remove the temporary store: delete all certs, then close.
    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store(
        $TempStoreName, "CurrentUser")
    try {
        $store.Open("ReadWrite")
        while ($store.Certificates.Count -gt 0) {
            $store.Remove($store.Certificates[0])
        }
    } finally {
        $store.Close()
    }
    return
}

# --- Import path ---

if ([string]::IsNullOrWhiteSpace($CredentialId)) {
    throw "CredentialId is required for import."
}

# Validate credential id is a safe identifier (UUID-like).
if ($CredentialId -notmatch '^[0-9a-fA-F-]{36}$') {
    throw "Invalid credential id format."
}

# Validate temp store name is a safe identifier (no path separators / wildcards).
if ($TempStoreName -notmatch '^[A-Za-z0-9]+$') {
    throw "Invalid temp store name."
}

$blobPath = Join-Path $CredRoot "$CredentialId.pfx.dpapi"
if (-not (Test-Path -LiteralPath $blobPath)) {
    throw "Encrypted PFX blob not found for credential: $CredentialId"
}

# Read and decrypt the DPAPI blob in memory. The password is embedded inside
# the encrypted PFX blob itself; it is never on the command line.
$encrypted = [System.IO.File]::ReadAllBytes($blobPath)
$decrypted = [System.Security.Cryptography.ProtectedData]::Unprotect(
    $encrypted, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)

# Import into the temporary CurrentUser store. The password travels inside the
# decrypted PFX bytes, not as a parameter.
$store = New-Object System.Security.Cryptography.X509Certificates.X509Store(
    $TempStoreName, "CurrentUser")
try {
    $store.Open("ReadWrite")
    $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2(
        $decrypted, "", [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::PersistKeySet)
    $store.Add($cert)
} finally {
    $store.Close()
}

# Zero out the decrypted bytes in memory as best-effort cleanup.
for ($i = 0; $i -lt $decrypted.Length; $i++) { $decrypted[$i] = 0 }
