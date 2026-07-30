@echo off
REM Wrapper to launch the FeishuMcp administrator broker installer.
REM Requires elevation (UAC prompt will appear).

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-admin-broker.ps1" %*
