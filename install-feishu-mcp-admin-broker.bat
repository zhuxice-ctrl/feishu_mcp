@echo off
REM Install the locally built, manifest-verified win-x64 broker artifact.
REM Run this wrapper from an Administrator command prompt.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-admin-broker.ps1" ^
  -ArtifactPath "%~dp0artifacts\admin-broker\win-x64\FeishuMcp.AdminBroker.Host.exe" ^
  -ManifestPath "%~dp0artifacts\admin-broker\win-x64\manifest.json"
