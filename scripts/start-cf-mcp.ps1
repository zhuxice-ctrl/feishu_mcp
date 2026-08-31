[CmdletBinding()]
param(
    [int]$Port = 3000,
    [string]$PublicHost = "mcp.zxc66.asia"
)

$ErrorActionPreference = "Stop"
$projectDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$launcher = Join-Path $projectDir "scripts\start-feishu-mcp.ps1"
$cloudflared = (Get-Command cloudflared.exe -ErrorAction SilentlyContinue).Source
$configPath = Join-Path $env:USERPROFILE ".cloudflared\config.yml"

function Wait-LocalHealth([int]$Seconds = 45) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 3
            if ($health.status -eq "ok" -and @($health.tools).Count -eq 40) {
                return $health
            }
        } catch {
            # The local launcher may still be building or starting.
        }
        Start-Sleep -Seconds 1
    }
    throw "Local MCP did not pass health check within $Seconds seconds."
}

if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
    throw "Local MCP launcher was not found: $launcher"
}
if (-not $cloudflared) {
    throw "cloudflared.exe was not found. Install the Cloudflare Tunnel client first."
}
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    throw "Cloudflare config was not found: $configPath"
}

$local = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if (-not $local) {
    Write-Host "Starting local MCP service..." -ForegroundColor Cyan
    Start-Process -FilePath "powershell.exe" -ArgumentList @(
        "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", $launcher
    ) -WorkingDirectory $projectDir
} else {
    Write-Host "Local port $Port is already listening; skipping duplicate start." -ForegroundColor Yellow
}

$health = Wait-LocalHealth
Write-Host "Local MCP health check passed (40 tools)." -ForegroundColor Green

$service = Get-Service -Name "cloudflared" -ErrorAction SilentlyContinue
$tunnelProcess = Get-CimInstance Win32_Process -Filter "Name = 'cloudflared.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$configPath*" }

if ($service -and $service.Status -eq "Running") {
    Write-Host "cloudflared Windows service is already running; skipping duplicate start." -ForegroundColor Green
} elseif ($tunnelProcess) {
    Write-Host "Cloudflare Tunnel is already running; skipping duplicate start." -ForegroundColor Green
} else {
    Write-Host "Starting Cloudflare Tunnel..." -ForegroundColor Cyan
    Start-Process -FilePath $cloudflared -ArgumentList @(
        "tunnel", "--config", $configPath, "run", "feishu-mcp"
    ) -WorkingDirectory $projectDir
}

Write-Host "" 
Write-Host "cf_mcp is ready." -ForegroundColor Green
Write-Host "Local:  http://127.0.0.1:$Port/health"
Write-Host "Public: https://$PublicHost/mcp"
Write-Host "To stop: close the local MCP window; if Tunnel is not a Windows service, close the cloudflared window." -ForegroundColor Yellow
Write-Host "Press Enter to close this launcher window."
[void](Read-Host)
