[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9.-]+$')][string]$PublicHost,
    [ValidateRange(1, 65535)][int]$Port = 3000
)

$ErrorActionPreference = "Stop"

# Read-only connector health validation. This script never prints
# Authorization, MCP_AUTH_TOKEN, .env contents, Cloudflare credentials,
# process environments, or any tunnel secret.

function Test-HealthJson([object]$Health, [string]$Source) {
    if (-not $Health -or $Health.status -ne "ok") {
        throw "$Source health status is not ok"
    }
    if ($Health.version -ne "1.0.0") {
        throw "$Source health version mismatch"
    }
    if (@($Health.tools).Count -ne $Health.toolCount) {
        throw "$Source toolCount does not match the tools array"
    }
    if ($Health.mcpEndpoint -ne "/mcp") {
        throw "$Source mcpEndpoint is not /mcp"
    }
}

# 1. Local transport health
$local = $null
try {
    $local = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 20
} catch {
    Write-Host "LOCAL_HEALTH_FAILURE: $($_.Exception.Message)"
    exit 2
}
try {
    Test-HealthJson $local "local"
} catch {
    Write-Host "LOCAL_HEALTH_INVALID: $($_.Exception.Message)"
    exit 3
}
Write-Host "local health ok (version $($local.version), $($local.toolCount) tools)"

# 2. Public transport health
$public = $null
try {
    $public = Invoke-RestMethod -Uri "https://$PublicHost/health" -TimeoutSec 20
} catch {
    Write-Host "PUBLIC_HEALTH_FAILURE: $($_.Exception.Message)"
    Write-Host "Local health passed; keep Aily on the previous transport until public health recovers."
    exit 4
}
try {
    Test-HealthJson $public "public"
} catch {
    Write-Host "PUBLIC_HEALTH_INVALID: $($_.Exception.Message)"
    exit 5
}
Write-Host "public health ok (version $($public.version), $($public.toolCount) tools)"


# 3. Manual production connector state. The launcher deliberately does not
# install a Windows service, so identify only the running production process.
$configPath = [System.IO.Path]::GetFullPath((Join-Path $env:USERPROFILE ".cloudflared\config.yml"))
$connector = Get-CimInstance Win32_Process -Filter "Name = 'cloudflared.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
        $_.CommandLine -and
        $_.CommandLine -like "*$configPath*" -and
        $_.CommandLine -match ("\brun\s+" + [regex]::Escape("feishu-mcp") + "\b")
    } |
    Select-Object -First 1
if ($null -eq $connector) {
    Write-Host "PRODUCTION_CONNECTOR_MISSING: start cf_mcp.bat and keep its window open"
    exit 6
}
Write-Host "production cloudflared connector running (PID $($connector.ProcessId))"

Write-Host "OK_CONNECTOR_CHECK"
exit 0
