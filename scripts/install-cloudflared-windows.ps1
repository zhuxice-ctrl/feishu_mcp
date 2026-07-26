# PowerShell: Install cloudflared on Windows
#
# Downloads cloudflared.exe to C:\cloudflared\ and adds it to PATH.
# Run this script in an elevated PowerShell window.

$ErrorActionPreference = "Stop"

$installDir = "C:\cloudflared"
$exePath = "$installDir\cloudflared.exe"

# Create install directory
if (-not (Test-Path $installDir)) {
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
}

# Determine architecture
$arch = if ([System.Environment]::Is64BitOperatingSystem) { "amd64" } else { "386" }
$downloadUrl = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-$arch.exe"

Write-Host "Downloading cloudflared for Windows ($arch)..." -ForegroundColor Cyan
Write-Host "URL: $downloadUrl"

try {
    Invoke-WebRequest -Uri $downloadUrl -OutFile $exePath -UseBasicParsing
    Write-Host "Downloaded to $exePath" -ForegroundColor Green
} catch {
    Write-Host "Download failed: $_" -ForegroundColor Red
    Write-Host "Manual download: $downloadUrl" -ForegroundColor Yellow
    exit 1
}

# Verify installation
$version = & $exePath --version 2>&1
Write-Host "Installed: $version" -ForegroundColor Green

# Add to PATH (persistent, for current user)
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$installDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$userPath;$installDir", "User")
    Write-Host "Added $installDir to user PATH" -ForegroundColor Green
}

Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Authenticate:  cloudflared tunnel login"
Write-Host "  2. Create tunnel: cloudflared tunnel create aily-mcp"
Write-Host "  3. Copy the tunnel UUID from the output"
Write-Host "  4. Edit:          cloudflared\config.yml (replace <TUNNEL_ID>)"
Write-Host "  5. Route DNS:     cloudflared tunnel route dns aily-mcp aily-mcp.yourdomain.com"
Write-Host "  6. Run:           cloudflared tunnel run --config cloudflared\config.yml"
