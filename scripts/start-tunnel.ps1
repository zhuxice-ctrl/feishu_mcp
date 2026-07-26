# PowerShell: Start MCP server + Cloudflare Tunnel (foreground, for testing)
#
# This script starts both the MCP server and a Cloudflare Quick Tunnel
# for quick testing. For production, use install-service-windows.ps1 instead.

$ErrorActionPreference = "Stop"
$projectDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

Write-Host "Starting MCP server..." -ForegroundColor Cyan

# Start the MCP server
$serverJob = Start-Job -ScriptBlock {
    param($dir)
    Set-Location $dir
    # Load .env if it exists
    if (Test-Path "$dir\.env") {
        Get-Content "$dir\.env" | ForEach-Object {
            if ($_ -match '^([^#]\w+)=(.*)$') {
                [Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process")
            }
        }
    }
    npm run start
} -ArgumentList $projectDir

Start-Sleep -Seconds 3

# Verify server is running
try {
    $health = Invoke-RestMethod -Uri "http://localhost:3000/health" -TimeoutSec 5
    Write-Host "MCP server is running (v$($health.version))" -ForegroundColor Green
    Write-Host "  Tools: $($health.tools.Count) registered"
    Write-Host "  Auth:  $(if ($health.authEnabled) { 'ENABLED' } else { 'DISABLED' })"
} catch {
    Write-Host "Server not ready yet, waiting..." -ForegroundColor Yellow
    Start-Sleep -Seconds 5
}

# Start Cloudflare Quick Tunnel
Write-Host ""
Write-Host "Starting Cloudflare Quick Tunnel..." -ForegroundColor Cyan
Write-Host "This creates a temporary public URL. For production, use a named tunnel." -ForegroundColor Yellow
Write-Host ""

cloudflared tunnel --url http://localhost:3000

# When tunnel exits, clean up the server
Write-Host "Tunnel stopped. Stopping MCP server..." -ForegroundColor Yellow
Stop-Job $serverJob -ErrorAction SilentlyContinue
Remove-Job $serverJob -ErrorAction SilentlyContinue
