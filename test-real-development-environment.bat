@echo off
REM Wrapper for the real development environment acceptance runner.
REM Credentials are read from the environment; never echo them.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\test-real-development-environment.ps1" %*
