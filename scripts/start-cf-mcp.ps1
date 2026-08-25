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
            if ($health.status -eq "ok" -and @($health.tools).Count -eq 37) {
                return $health
            }
        } catch {
            # The local launcher may still be building or starting.
        }
        Start-Sleep -Seconds 1
    }
    throw "本地 MCP 未在 $Seconds 秒内通过健康检查。"
}

if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
    throw "找不到本地 MCP 启动器：$launcher"
}
if (-not $cloudflared) {
    throw "找不到 cloudflared.exe，请先安装 Cloudflare Tunnel 客户端。"
}
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    throw "找不到 Cloudflare 配置：$configPath"
}

$local = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if (-not $local) {
    Write-Host "启动本地 MCP 服务..." -ForegroundColor Cyan
    Start-Process -FilePath "powershell.exe" -ArgumentList @(
        "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", $launcher
    ) -WorkingDirectory $projectDir
} else {
    Write-Host "检测到本地端口 $Port 已监听，跳过重复启动。" -ForegroundColor Yellow
}

$health = Wait-LocalHealth
Write-Host "本地 MCP 健康检查通过（37 个工具）。" -ForegroundColor Green

$service = Get-Service -Name "cloudflared" -ErrorAction SilentlyContinue
$tunnelProcess = Get-CimInstance Win32_Process -Filter "Name = 'cloudflared.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$configPath*" }

if ($service -and $service.Status -eq "Running") {
    Write-Host "cloudflared Windows 服务已运行，跳过重复启动。" -ForegroundColor Green
} elseif ($tunnelProcess) {
    Write-Host "检测到 Cloudflare Tunnel 已运行，跳过重复启动。" -ForegroundColor Green
} else {
    Write-Host "启动 Cloudflare Tunnel..." -ForegroundColor Cyan
    Start-Process -FilePath $cloudflared -ArgumentList @(
        "tunnel", "--config", $configPath, "run", "feishu-mcp"
    ) -WorkingDirectory $projectDir
}

Write-Host "" 
Write-Host "cf_mcp 已准备完成。" -ForegroundColor Green
Write-Host "本地：  http://127.0.0.1:$Port/health"
Write-Host "公网：  https://$PublicHost/mcp"
Write-Host "停止方式：关闭本地 MCP 窗口；如 Tunnel 非 Windows 服务，请关闭 cloudflared 窗口。" -ForegroundColor Yellow
Write-Host "按 Enter 关闭此启动提示窗口。"
[void](Read-Host)
