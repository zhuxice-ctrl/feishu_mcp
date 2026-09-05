[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$projectDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$supervisor = Join-Path $projectDir "scripts\tunnel-supervisor.ps1"
if (-not (Test-Path -LiteralPath $supervisor -PathType Leaf)) {
    throw "Tunnel supervisor was not found."
}

& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $supervisor -Action Stop
