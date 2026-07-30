@echo off
REM Wrapper to launch the FeishuMcp administrator broker uninstaller.
REM Requires elevation (UAC prompt will appear).

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\uninstall-admin-broker.ps1" %*
