@echo off
REM Wrapper for the development task management script.
REM Never prints .env values, credentials, or task launch arguments.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\manage-development-tasks.ps1" %*
