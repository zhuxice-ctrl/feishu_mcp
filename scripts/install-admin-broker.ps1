<#
.SYNOPSIS
  Install or repair the FeishuMcp administrator broker Windows service.

.DESCRIPTION
  Verifies a locally built broker artifact against its adjacent manifest,
  repairs an interrupted installation in the fixed ProgramData directory,
  configures the service owner/key environment, applies owner/SYSTEM ACLs,
  starts the exact fixed service, and verifies the owner-scoped named pipe.

  Requires elevation. No remote download, reflective evaluation, plaintext
  secret, arbitrary service name, executable, argument, or destination is used.
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

$ServiceName = 'FeishuMcpAdminBroker'
$BrokerDir = Join-Path $env:ProgramData 'FeishuMcp\Broker'
$KeyPath = Join-Path $BrokerDir 'broker.key'
$ExeName = 'FeishuMcp.AdminBroker.Host.exe'
$DestExe = Join-Path $BrokerDir $ExeName
$ServiceRegistrySubKey = "SYSTEM\CurrentControlSet\Services\$ServiceName"
$CreatedService = $false

function Get-PipeSuffix([string]$Sid) {
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $digest = $sha256.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Sid))
  } finally {
    $sha256.Dispose()
  }
  return ([System.BitConverter]::ToString($digest, 0, 8) -replace '-', '').ToLowerInvariant()
}

function Set-TemporaryDirectoryAcl(
  [System.Security.Principal.SecurityIdentifier]$Owner,
  [System.Security.Principal.SecurityIdentifier]$SystemSid
) {
  $acl = [System.Security.AccessControl.DirectorySecurity]::new()
  $acl.SetOwner($Owner)
  $acl.SetAccessRuleProtection($true, $false)
  $inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
    [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  $propagation = [System.Security.AccessControl.PropagationFlags]::None
  $allow = [System.Security.AccessControl.AccessControlType]::Allow
  $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
    $SystemSid, [System.Security.AccessControl.FileSystemRights]::FullControl,
    $inherit, $propagation, $allow))
  $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
    $Owner, [System.Security.AccessControl.FileSystemRights]::FullControl,
    $inherit, $propagation, $allow))
  Set-Acl -LiteralPath $BrokerDir -AclObject $acl
}

function Set-FileAcl(
  [string]$Path,
  [System.Security.Principal.SecurityIdentifier]$Owner,
  [System.Security.Principal.SecurityIdentifier]$SystemSid,
  [System.Security.AccessControl.FileSystemRights]$OwnerRights
) {
  $acl = [System.Security.AccessControl.FileSecurity]::new()
  $acl.SetOwner($Owner)
  $acl.SetAccessRuleProtection($true, $false)
  $allow = [System.Security.AccessControl.AccessControlType]::Allow
  $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
    $SystemSid, [System.Security.AccessControl.FileSystemRights]::FullControl, $allow))
  $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
    $Owner, $OwnerRights, $allow))
  Set-Acl -LiteralPath $Path -AclObject $acl
}

function Set-FinalDirectoryAcl(
  [System.Security.Principal.SecurityIdentifier]$Owner,
  [System.Security.Principal.SecurityIdentifier]$SystemSid
) {
  $acl = [System.Security.AccessControl.DirectorySecurity]::new()
  $acl.SetOwner($Owner)
  $acl.SetAccessRuleProtection($true, $false)
  $inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
    [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  $propagation = [System.Security.AccessControl.PropagationFlags]::None
  $allow = [System.Security.AccessControl.AccessControlType]::Allow
  $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
    $SystemSid, [System.Security.AccessControl.FileSystemRights]::FullControl,
    $inherit, $propagation, $allow))
  $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
    $Owner, [System.Security.AccessControl.FileSystemRights]::ReadAndExecute,
    $inherit, $propagation, $allow))
  Set-Acl -LiteralPath $BrokerDir -AclObject $acl
}

function Get-ServiceExecutable([string]$PathName) {
  $trimmed = $PathName.Trim()
  if ($trimmed.StartsWith('"')) {
    $closing = $trimmed.IndexOf('"', 1)
    if ($closing -le 1) { return '' }
    return $trimmed.Substring(1, $closing - 1)
  }
  return ($trimmed -split '\s+', 2)[0]
}

# Validate manifest and artifact before mutating ProgramData or the service.
if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
  throw 'Broker manifest was not found.'
}
if (-not (Test-Path -LiteralPath $ArtifactPath -PathType Leaf)) {
  throw 'Broker artifact was not found.'
}
$manifestItem = Get-Item -LiteralPath $ManifestPath
$artifactItem = Get-Item -LiteralPath $ArtifactPath
if (($manifestItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
    ($artifactItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw 'Broker inputs cannot be reparse points.'
}
$manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
if ($manifest.protocolVersion -ne 1 -or $manifest.runtime -ne 'win-x64' -or
    $manifest.filename -ne $ExeName -or $manifest.byteSize -ne $artifactItem.Length -or
    [string]$manifest.sha256 -notmatch '^[0-9a-fA-F]{64}$' -or
    [string]$manifest.catalogDigest -notmatch '^[0-9a-fA-F]{64}$') {
  throw 'Broker manifest metadata is invalid.'
}
$actualBytes = [System.IO.File]::ReadAllBytes($artifactItem.FullName)
$sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
  $actualHash = $sha256.ComputeHash($actualBytes)
} finally {
  $sha256.Dispose()
}
$actualHex = [System.BitConverter]::ToString($actualHash).Replace('-', '').ToLowerInvariant()
if ($actualHex -ne ([string]$manifest.sha256).ToLowerInvariant()) {
  throw 'Broker artifact SHA-256 does not match the manifest.'
}

$ownerIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [System.Security.Principal.SecurityIdentifier]::new(
  [System.Security.Principal.WellKnownSidType]::LocalSystemSid, $null)
$ownerSid = $ownerIdentity.Value

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
  $serviceInfo = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
  $installedExecutable = Get-ServiceExecutable ([string]$serviceInfo.PathName)
  if ([System.IO.Path]::GetFullPath($installedExecutable) -ne [System.IO.Path]::GetFullPath($DestExe)) {
    throw 'The existing broker service points to an unexpected executable.'
  }
  if ($existing.Status -ne 'Stopped') {
    Stop-Service -Name $ServiceName -Force
    $existing.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(20))
  }
}

if (Test-Path -LiteralPath $BrokerDir) {
  $brokerItem = Get-Item -LiteralPath $BrokerDir
  if (-not $brokerItem.PSIsContainer -or
      ($brokerItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'The fixed broker directory is not a real directory.'
  }
} else {
  [System.IO.Directory]::CreateDirectory($BrokerDir) | Out-Null
}

# Repair ACLs left by an interrupted installation before replacing files.
Set-TemporaryDirectoryAcl $ownerIdentity $systemSid
foreach ($path in @($DestExe, $KeyPath)) {
  if (Test-Path -LiteralPath $path -PathType Leaf) {
    Set-FileAcl $path $ownerIdentity $systemSid `
      ([System.Security.AccessControl.FileSystemRights]::FullControl)
  }
}

Copy-Item -LiteralPath $artifactItem.FullName -Destination $DestExe -Force
if (-not (Test-Path -LiteralPath $KeyPath -PathType Leaf) -or
    (Get-Item -LiteralPath $KeyPath).Length -ne 32) {
  $keyBytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($keyBytes)
    [System.IO.File]::WriteAllBytes($KeyPath, $keyBytes)
  } finally {
    $rng.Dispose()
    [System.Array]::Clear($keyBytes, 0, $keyBytes.Length)
  }
}

Set-FileAcl $KeyPath $ownerIdentity $systemSid `
  ([System.Security.AccessControl.FileSystemRights]::Read)
Set-FileAcl $DestExe $ownerIdentity $systemSid `
  ([System.Security.AccessControl.FileSystemRights]::ReadAndExecute)
Set-FinalDirectoryAcl $ownerIdentity $systemSid

try {
  if (-not $existing) {
    $binaryPath = "`"$DestExe`""
    New-Service -Name $ServiceName -BinaryPathName $binaryPath -StartupType Automatic | Out-Null
    $CreatedService = $true
  } else {
    Set-Service -Name $ServiceName -StartupType Automatic
  }

  $serviceKey = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($ServiceRegistrySubKey, $true)
  if ($null -eq $serviceKey) { throw 'The broker service registry key is unavailable.' }
  try {
    $serviceKey.SetValue('Environment', [string[]]@(
      "FEISHU_BROKER_OWNER_SID=$ownerSid",
      "FEISHU_BROKER_KEY_PATH=$KeyPath"
    ), [Microsoft.Win32.RegistryValueKind]::MultiString)
  } finally {
    $serviceKey.Dispose()
  }

  [Environment]::SetEnvironmentVariable('DEV_ENV_OWNER_SID', $ownerSid, 'User')
  [Environment]::SetEnvironmentVariable('DEV_ENV_BROKER_KEY_PATH', $KeyPath, 'User')

  Start-Service -Name $ServiceName
  $service = Get-Service -Name $ServiceName
  $service.WaitForStatus('Running', [TimeSpan]::FromSeconds(20))

  $pipePath = "\\.\pipe\feishu-mcp-admin-$(Get-PipeSuffix $ownerSid)"
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $pipePath)) {
    Start-Sleep -Milliseconds 250
  }
  if (-not (Test-Path -LiteralPath $pipePath)) {
    throw 'The broker service started without opening its owner-scoped pipe.'
  }
} catch {
  if ($CreatedService) {
    $created = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($created -and $created.Status -ne 'Stopped') {
      Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    }
    sc.exe delete $ServiceName | Out-Null
  }
  throw
}

Write-Output 'FeishuMcpAdminBroker installed, running, and pipe-ready.'
