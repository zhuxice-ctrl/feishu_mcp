[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9.-]+$')][string]$PublicHost,
    [ValidateRange(1, 65535)][int]$Port = 3000
)

$ErrorActionPreference = "Stop"

# Read-only connector health validation. This script never prints
# Authorization, MCP_AUTH_TOKEN, .env contents, Cloudflare credentials,
# process environments, or any tunnel secret.

function Test-HealthJson([hashtable]$Health, [string]$Source) {
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

# 3. Connector service state
$service = Get-Service -Name cloudflared -ErrorAction SilentlyContinue
if ($null -eq $service) {
    Write-Host "CLOUDFLARED_SERVICE_MISSING: the cloudflared Windows service is not installed"
    exit 6
}
if ($service.Status -ne "Running") {
    Write-Host "CLOUDFLARED_SERVICE_STOPPED: service status is $($service.Status)"
    exit 7
}
Write-Host "cloudflared service running (start type $($service.StartType))"

Write-Host "OK_CONNECTOR_CHECK"
exit 0