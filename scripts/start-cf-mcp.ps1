[CmdletBinding()]
param(
    [int]$Port = 3000,
    [string]$PublicHost = "mcp.zxc66.asia"
)

$ErrorActionPreference = "Stop"
$projectDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$launcher = Join-Path $projectDir "scripts\start-feishu-mcp.ps1"
$configPath = Join-Path $env:USERPROFILE ".cloudflared\config.yml"
$supervisor = Join-Path $projectDir "scripts\tunnel-supervisor.ps1"

function Wait-LocalHealth([int]$Seconds = 45) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 3
            if ($health.status -eq "ok" -and @($health.tools).Count -ge 41) {
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
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    throw "Cloudflare config was not found: $configPath"
}
if (-not (Test-Path -LiteralPath $supervisor -PathType Leaf)) {
    throw "Tunnel supervisor was not found: $supervisor"
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
Write-Host "Local MCP health check passed ($(@($health.tools).Count) tools)." -ForegroundColor Green

Write-Host "Starting manual Cloudflare Tunnel supervisor..." -ForegroundColor Cyan
Start-Process -FilePath "powershell.exe" -ArgumentList @(
    "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", $supervisor,
    "-Action", "Start",
    "-PublicHost", $PublicHost,
    "-Port", $Port,
    "-MetricsPort", "20241",
    "-TunnelName", "feishu-mcp"
) -WorkingDirectory $projectDir

Write-Host "" 
Write-Host "cf_mcp is ready." -ForegroundColor Green
Write-Host "Local:  http://127.0.0.1:$Port/health"
Write-Host "Public: https://$PublicHost/mcp"
Write-Host "To stop this manual session: run scripts\stop-cf-mcp.ps1." -ForegroundColor Yellow
Write-Host "Press Enter to close this launcher window."
[void](Read-Host)
