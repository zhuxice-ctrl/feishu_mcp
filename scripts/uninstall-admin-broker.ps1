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

# ---------------------------------------------------------------------------
# 1. Verify service exists, then stop and remove
# ---------------------------------------------------------------------------

$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($service) {
  if ($service.Status -eq 'Running') {
    Stop-Service -Name $ServiceName -Force
  }
  sc.exe delete $ServiceName | Out-Null
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
  Remove-Item -LiteralPath $BrokerDir -Recurse -Force
  Write-Output "Broker directory deleted: $BrokerDir"
} else {
  Write-Output "Broker directory not found. Skipping directory cleanup."
}

Write-Output "FeishuMcpAdminBroker uninstalled successfully."
