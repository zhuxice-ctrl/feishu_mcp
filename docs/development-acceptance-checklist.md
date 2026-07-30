# Development Environment Acceptance Checklist

This checklist guides real-machine validation of the Android and Windows
development automation on a target Windows host. Run the read-only inspection
first; only run real-change modes after reviewing the disposable root and
credential references locally.

## Prerequisites

- Windows 10/11 or Windows Server 2022 with .NET 8 SDK, Node 20, Android SDK, CMake, Ninja, and Git in PATH.
- The MCP server running locally (`npm run build` then `npm start`) with a valid `.env`.
- `MCP_AUTH_TOKEN` exported in the environment (never pasted into chat).
- The administrator broker installed if privileged environment changes are tested.
- A disposable drive/folder for `-Root` (e.g. `F:\FeishuMcpAcceptance`).
- A test signing credential reference registered via DPAPI (no inline keys).

## Read-only inspection

```powershell
.\test-real-development-environment.bat -Mode Inspect
```

- [ ] `/health` returns 30 tools and the expected broker state.
- [ ] MCP `initialize` succeeds.
- [ ] `inspect_development_environment` returns component states without paths or identities.
- [ ] No files written outside the temporary report directory.

## Android acceptance

```powershell
.\test-real-development-environment.bat -Mode Android -Root F:\FeishuMcpAcceptance -ConfirmRealChanges
```

- [ ] Disposable root created empty; project scaffolded from reviewed template.
- [ ] APK/AAB build enqueues exactly one task; unit tests pass.
- [ ] Test AVD created or selected by exact serial; boots and waits.
- [ ] Install/start/clear/uninstall lifecycle completes; bounded Logcat and screenshot captured.
- [ ] One generated file transferred; one loopback port forward tested.
- [ ] Signing with test credential reference succeeds; verify passes.
- [ ] All task-owned processes and ports released; disposable root removed.

## Windows acceptance

```powershell
.\test-real-development-environment.bat -Mode Windows -Root F:\FeishuMcpAcceptance -ConfirmRealChanges
```

- [ ] Disposable .NET, native, and Electron projects created.
- [ ] Restore/build/test/package complete for each ecosystem.
- [ ] Run and stop task-owned artifacts; missing-credential behavior validated.
- [ ] Visual Studio/MSBuild and workload inspection reflects the local install.
- [ ] Signing a disposable artifact with a test certificate reference succeeds.
- [ ] Disposable root removed after cleanup opt-in.

## Post-run verification

- [ ] `ngrok` /health and /mcp still reachable; fixed domain unchanged.
- [ ] No child Node or broker processes left running.
- [ ] No ports left bound by task-owned artifacts.
- [ ] Secret scan (`scripts/scan-development-secrets.ps1`) reports zero findings.

## Sign-off

| Date | Commit SHA | Machine profile | Android result | Windows result | Reviewer |
|------|-----------|-----------------|----------------|----------------|----------|
|      |           |                 |                |                |          |
