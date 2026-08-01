<#
.SYNOPSIS
  Install the FeishuMcp administrator broker as a Windows service.

.DESCRIPTION
  Verifies the broker artifact SHA-256 against the adjacent release manifest,
  creates %ProgramData%\FeishuMcp\Broker, generates a random 32-byte key,
  applies ACLs for SYSTEM and the current owner SID, installs the fixed
  Windows service "FeishuMcpAdminBroker", and starts it.

  Requires elevation.  Uses -LiteralPath throughout.  No remote script
  download, no reflective string evaluation, no embedded secret.
#>

#Requires -RunAsAdministrator

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$ArtifactPath,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$ManifestPath
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

$ServiceName = 'FeishuMcpAdminBroker'
$BrokerDir = Join-Path $env:ProgramData 'FeishuMcp\Broker'
$KeyName = 'broker.key'
$ExeName = 'FeishuMcp.AdminBroker.Host.exe'

# ---------------------------------------------------------------------------
# 1. Verify artifact SHA-256 against manifest
# ---------------------------------------------------------------------------

if (-not (Test-Path -LiteralPath $ManifestPath)) {
  throw "Manifest not found: $ManifestPath"
}
$manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
$expectedSha = $manifest.sha256
if (-not $expectedSha) {
  throw "Manifest does not contain sha256"
}

if (-not (Test-Path -LiteralPath $ArtifactPath)) {
  throw "Artifact not found: $ArtifactPath"
}
$actualBytes = [System.IO.File]::ReadAllBytes($ArtifactPath)
$actualSha = [System.Security.Cryptography.SHA256]::Create().ComputeHash($actualBytes)
$actualHex = [System.BitConverter]::ToString($actualSha).Replace('-', '').ToLowerInvariant()
if ($actualHex -ne $expectedSha.ToLowerInvariant()) {
  throw "SHA-256 mismatch: expected $expectedSha, got $actualHex"
}

# ---------------------------------------------------------------------------
# 2. Create broker directory
# ---------------------------------------------------------------------------

if (-not (Test-Path -LiteralPath $BrokerDir)) {
  # New-Item has no -LiteralPath parameter in Windows PowerShell 5.1. The
  # broker directory is derived solely from ProgramData and fixed literals,
  # so create it through the .NET API without wildcard expansion.
  [System.IO.Directory]::CreateDirectory($BrokerDir) | Out-Null
}

# ---------------------------------------------------------------------------
# 3. Copy verified artifact
# ---------------------------------------------------------------------------

$destExe = Join-Path $BrokerDir $ExeName
Copy-Item -LiteralPath $ArtifactPath -Destination $destExe -Force

# ---------------------------------------------------------------------------
# 4. Generate random key (32 bytes)
# ---------------------------------------------------------------------------

$KeyPath = Join-Path $BrokerDir $KeyName
$keyBytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($keyBytes)
[System.IO.File]::WriteAllBytes($KeyPath, $keyBytes)

# ---------------------------------------------------------------------------
# 5. Apply ACLs: SYSTEM and current owner SID only
# ---------------------------------------------------------------------------

$ownerSid = ([System.Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
$acl = Get-Acl -LiteralPath $KeyPath
$acl.SetAccessRuleProtection($true, $false)  # disable inheritance
$systemSid = [System.Security.Principal.SecurityIdentifier]::new(
  [System.Security.Principal.WellKnownSidType]::LocalSystemSid, $null)
$ownerIdentity = [System.Security.Principal.SecurityIdentifier]::new($ownerSid)
$systemRule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $systemSid, [System.Security.AccessControl.FileSystemRights]::FullControl,
  [System.Security.AccessControl.AccessControlType]::Allow)
$ownerRule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $ownerIdentity, [System.Security.AccessControl.FileSystemRights]::Read,
  [System.Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($systemRule)
$acl.AddAccessRule($ownerRule)
Set-Acl -LiteralPath $KeyPath -AclObject $acl

# Apply ACLs to the broker directory itself
$dirAcl = Get-Acl -LiteralPath $BrokerDir
$dirAcl.SetAccessRuleProtection($true, $false)
$dirAcl.AddAccessRule($systemRule)
$dirAcl.AddAccessRule($ownerRule)
Set-Acl -LiteralPath $BrokerDir -AclObject $dirAcl

# ---------------------------------------------------------------------------
# 6. Install Windows service
# ---------------------------------------------------------------------------

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
  throw "Service '$ServiceName' already exists. Uninstall first."
}

$binaryPath = "`"$destExe`""
New-Service -Name $ServiceName -BinaryPathName $binaryPath -StartupType Automatic | Out-Null

# ---------------------------------------------------------------------------
# 7. Start service
# ---------------------------------------------------------------------------

Start-Service -Name $ServiceName

Write-Output "FeishuMcpAdminBroker installed and started successfully."
Write-Output "Broker directory: $BrokerDir"
Write-Output "Service name: $ServiceName"
