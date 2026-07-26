# PowerShell: Install cloudflared as a Windows service (auto-start on boot)
#
# This registers cloudflared as a Windows service that:
#   - Starts automatically on system boot
#   - Runs the named tunnel with your config
#   - Auto-reconnects on network interruption
#
# Run this in an elevated (Administrator) PowerShell window.

$ErrorActionPreference = "Stop"

$projectDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$configPath = Join-Path $projectDir "cloudflared\config.yml"

if (-not (Test-Path $configPath)) {
    Write-Host "Error: cloudflared\config.yml not found at $configPath" -ForegroundColor Red
    Write-Host "Please configure the tunnel first (edit the config file)." -ForegroundColor Yellow
    exit 1
}

# Check if the config still has placeholder
$configContent = Get-Content $configPath -Raw
if ($configContent -match '<TUNNEL_ID>') {
    Write-Host "Error: config.yml still has <TUNNEL_ID> placeholder." -ForegroundColor Red
    Write-Host "Please replace <TUNNEL_ID> with your actual tunnel UUID." -ForegroundColor Yellow
    exit 1
}

Write-Host "Installing cloudflared as a Windows service..." -ForegroundColor Cyan
Write-Host "Config: $configPath" -ForegroundColor Gray

# Register the service
cloudflared service install -config $configPath

# Verify
$service = Get-Service -Name "cloudflared" -ErrorAction SilentlyContinue
if ($service) {
    Write-Host ""
    Write-Host "Service installed successfully!" -ForegroundColor Green
    Write-Host "  Name:    $($service.Name)"
    Write-Host "  Status:  $($service.Status)"
    Write-Host "  Startup: $($service.StartType)"
    Write-Host ""
    Write-Host "Management commands:" -ForegroundColor Cyan
    Write-Host "  Start:   Start-Service cloudflared"
    Write-Host "  Stop:    Stop-Service cloudflared"
    Write-Host "  Restart: Restart-Service cloudflared"
    Write-Host "  Status:  Get-Service cloudflared"
    Write-Host "  Remove:  cloudflared service uninstall"
} else {
    Write-Host "Service installation may have failed. Check cloudflared logs." -ForegroundColor Red
    Write-Host "Logs: C:\Windows\System32\config\systemprofile\.cloudflared\" -ForegroundColor Yellow
}
