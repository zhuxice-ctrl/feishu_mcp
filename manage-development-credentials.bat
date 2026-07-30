@echo off
REM Wrapper for manage-development-credentials.ps1. Requires elevation.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\manage-development-credentials.ps1" %*
