# PowerShell: Start MCP server + ngrok tunnel (foreground)
#
# This script starts both the MCP server and an ngrok tunnel with your
# configured fixed domain. Requires ngrok to be installed and configured.
#
# Prerequisites:
#   1. Install ngrok: https://ngrok.com/download
#   2. Configure authtoken: ngrok config add-authtoken YOUR_TOKEN
#   3. Claim a free domain: https://dashboard.ngrok.com/domains
#   4. Set NGROK_DOMAIN in .env or as environment variable
#
# Usage:
#   .\scripts\start-ngrok.ps1

$ErrorActionPreference = "Stop"
$projectDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

# Load .env if it exists
$envFile = Join-Path $projectDir ".env"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^([^#]\w+)=(.*)$') {
            [Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process")
        }
    }
}

$port = if ($env:PORT) { $env:PORT } else { "3000" }
$ngrokDomain = $env:NGROK_DOMAIN

# Verify ngrok is installed
$ngrokPath = Get-Command ngrok -ErrorAction SilentlyContinue
if (-not $ngrokPath) {
    Write-Host "Error: ngrok is not installed or not in PATH." -ForegroundColor Red
    Write-Host "Install from: https://ngrok.com/download" -ForegroundColor Yellow
    Write-Host "Or: choco install ngrok" -ForegroundColor Yellow
    exit 1
}

# Check domain configuration
if (-not $ngrokDomain) {
    Write-Host "Error: NGROK_DOMAIN not set." -ForegroundColor Red
    Write-Host "Claim a free domain at: https://dashboard.ngrok.com/domains" -ForegroundColor Yellow
    Write-Host "Then add NGROK_DOMAIN=your-domain.ngrok-free.app to .env" -ForegroundColor Yellow
    exit 1
}

Write-Host "Starting MCP server on port $port..." -ForegroundColor Cyan

# Start the MCP server in background
$serverJob = Start-Job -ScriptBlock {
    param($dir, $port)
    Set-Location $dir
    $env:PORT = $port
    npm run start
} -ArgumentList $projectDir, $port

Start-Sleep -Seconds 3

# Verify server is running
try {
    $health = Invoke-RestMethod -Uri "http://localhost:$port/health" -TimeoutSec 5
    Write-Host "MCP server is running (v$($health.version))" -ForegroundColor Green
    Write-Host "  Tools: $($health.tools.Count) registered"
    Write-Host "  Auth:  $(if ($health.authEnabled) { 'ENABLED' } else { 'DISABLED' })"
} catch {
    Write-Host "Server not ready yet, waiting..." -ForegroundColor Yellow
    Start-Sleep -Seconds 5
}

# Start ngrok tunnel
Write-Host ""
Write-Host "Starting ngrok tunnel..." -ForegroundColor Cyan
Write-Host "  Domain: $ngrokDomain" -ForegroundColor Gray
Write-Host "  Local:  http://localhost:$port" -ForegroundColor Gray
Write-Host ""
Write-Host "Public URL: https://$ngrokDomain" -ForegroundColor Green
Write-Host "Health:     https://$ngrokDomain/health" -ForegroundColor Green
Write-Host "MCP:        https://$ngrokDomain/mcp" -ForegroundColor Green
Write-Host ""

ngrok http $port --domain=$ngrokDomain

# When ngrok exits, clean up the server
Write-Host "Tunnel stopped. Stopping MCP server..." -ForegroundColor Yellow
Stop-Job $serverJob -ErrorAction SilentlyContinue
Remove-Job $serverJob -ErrorAction SilentlyContinue
