<#
.SYNOPSIS
  Uninstall the FeishuMcp administrator broker Windows service.

.DESCRIPTION
  Stops and removes only the exact service named "FeishuMcpAdminBroker".
  Deletes only the verified broker directory %ProgramData%\FeishuMcp\Broker
  after path and service-name checks.  Uses -LiteralPath throughout.

  Requires elevation.  No remote script download, no reflective string
  evaluation, no embedded secret.
#>

#Requires -RunAsAdministrator

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

$ServiceName = 'FeishuMcpAdminBroker'
$BrokerDir = Join-Path $env:ProgramData 'FeishuMcp\Broker'

function Grant-BrokerDirectoryCleanupAccess {
  $owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $systemSid = [System.Security.Principal.SecurityIdentifier]::new(
    [System.Security.Principal.WellKnownSidType]::LocalSystemSid, $null)
  $acl = [System.Security.AccessControl.DirectorySecurity]::new()
  $acl.SetOwner($owner)
  $acl.SetAccessRuleProtection($true, $false)
  $inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
    [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  $propagation = [System.Security.AccessControl.PropagationFlags]::None
  $allow = [System.Security.AccessControl.AccessControlType]::Allow
  foreach ($identity in @($owner, $systemSid)) {
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
      $identity, [System.Security.AccessControl.FileSystemRights]::FullControl,
      $inherit, $propagation, $allow))
  }
  Set-Acl -LiteralPath $BrokerDir -AclObject $acl
}

# ---------------------------------------------------------------------------
# 1. Verify service exists, then stop and remove
# ---------------------------------------------------------------------------

$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($service) {
  if ($service.Status -eq 'Running') {
    Stop-Service -Name $ServiceName -Force
  }
  sc.exe delete $ServiceName | Out-Null
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline -and
         (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)) {
    Start-Sleep -Milliseconds 250
  }
  if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
    throw "Service '$ServiceName' did not finish deleting."
  }
  Write-Output "Service '$ServiceName' stopped and removed."
} else {
  Write-Output "Service '$ServiceName' not found. Skipping service removal."
}

# ---------------------------------------------------------------------------
# 2. Verify and delete broker directory
# ---------------------------------------------------------------------------

if (Test-Path -LiteralPath $BrokerDir) {
  # Verify the path ends with the expected broker directory before deleting
  $resolved = (Resolve-Path -LiteralPath $BrokerDir).Path
  if (-not $resolved.EndsWith('FeishuMcp\Broker')) {
    throw "Refusing to delete unexpected path: $resolved"
  }
  $item = Get-Item -LiteralPath $BrokerDir
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Refusing to delete a broker directory reparse point.'
  }
  Grant-BrokerDirectoryCleanupAccess
  Remove-Item -LiteralPath $BrokerDir -Recurse -Force
  Write-Output "Broker directory deleted: $BrokerDir"
} else {
  Write-Output "Broker directory not found. Skipping directory cleanup."
}

[Environment]::SetEnvironmentVariable('DEV_ENV_OWNER_SID', $null, 'User')
[Environment]::SetEnvironmentVariable('DEV_ENV_BROKER_KEY_PATH', $null, 'User')

Write-Output "FeishuMcpAdminBroker uninstalled successfully."
