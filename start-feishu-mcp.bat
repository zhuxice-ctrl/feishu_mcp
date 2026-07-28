@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-feishu-mcp.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo.
  echo feishu_mcp launcher failed with exit code %EXIT_CODE%.
  pause
)
exit /b %EXIT_CODE%
