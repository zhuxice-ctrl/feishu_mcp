@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\manage-approvals.ps1" %*
exit /b %ERRORLEVEL%
