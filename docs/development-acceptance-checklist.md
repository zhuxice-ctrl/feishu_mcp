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
- The server owner defaults include the disposable root's physical parent, and
  the owner identity plus transport token are exported to the runner process.
- Android signing references are exported as
  `FEISHU_MCP_ACCEPTANCE_ANDROID_KEYSTORE`,
  `FEISHU_MCP_ACCEPTANCE_ANDROID_KEY_ALIAS`,
  `FEISHU_MCP_ACCEPTANCE_ANDROID_KEYSTORE_CREDENTIAL_ID`, and
  `FEISHU_MCP_ACCEPTANCE_ANDROID_KEY_CREDENTIAL_ID`. Windows signing uses
  `FEISHU_MCP_ACCEPTANCE_WINDOWS_CREDENTIAL_ID` and
  `FEISHU_MCP_ACCEPTANCE_WINDOWS_TIMESTAMP_ORIGIN`. Review presence locally;
  never paste values into chat, screenshots, commits, or the sign-off report.
- Allow at least 25 GiB free and 90 minutes for `-Mode All`; first-time Android
  and Electron dependency caches can take longer. The runner does not install
  missing SDKs, workloads, services, credentials, or emulator images.
- Install/review the administrator broker separately under UAC before the run.
  MCP itself must continue running without administrator privileges.

## Read-only inspection

```powershell
.\test-real-development-environment.bat -Mode Inspect
```

- [ ] `/health` returns 30 tools and the expected broker state.
- [ ] MCP `initialize` succeeds.
- [ ] MCP `tools/list` returns exactly 30 unique tools.
- [ ] `inspect_development_environment` returns component states without paths or identities.
- [ ] No files written outside the temporary report directory.

## Android acceptance

```powershell
.\test-real-development-environment.bat -Mode Android -Root F:\FeishuMcpAcceptance -ConfirmRealChanges
```

- [ ] Disposable root created empty; project scaffolded from reviewed template.
- [ ] APK/AAB build enqueues exactly one task; unit tests pass.
- [ ] Test AVD `FeishuMcpAcceptanceApi35` is created or selected; a preexisting
      AVD is never deleted, and `emulator-5556` reports both boot-complete properties.
- [ ] Install/start/clear/uninstall lifecycle completes; bounded Logcat and screenshot captured.
- [ ] One generated file transferred; one loopback port forward tested.
- [ ] Signing with test credential reference succeeds; verify passes.
- [ ] Every task reaches `succeeded` (the long-lived emulator task may end as
      `cancelled` after explicit stop); cursor-based logs contain no secret.
- [ ] All task-owned processes and ports released; disposable root removed by
      ownership-marker-verified cleanup even when a step fails.

## Windows acceptance

```powershell
.\test-real-development-environment.bat -Mode Windows -Root F:\FeishuMcpAcceptance -ConfirmRealChanges
```

- [ ] Disposable .NET, native, and Electron projects created.
- [ ] .NET restore/build/test/publish/pack, native configure/build/test/package,
      and Electron frozen install/test/package complete.
- [ ] Run and stop task-owned artifacts; missing-credential behavior validated.
- [ ] Visual Studio/MSBuild and workload inspection reflects the local install.
- [ ] Signing a disposable artifact with a test certificate reference succeeds.
- [ ] Every queued operation is approved with its exact request state and then
      polled to a terminal state; task evidence uses only hashed labels.
- [ ] Disposable root removed after the explicit real-mode confirmation.

## Post-run verification

- [ ] `ngrok` /health and /mcp still reachable; fixed domain unchanged.
- [ ] Repeat `-Mode Inspect -BaseUrl https://<reviewed-fixed-domain>` without
      changing ngrok configuration; do not record the domain in the report.
- [ ] No child Node or broker processes left running.
- [ ] No ports left bound by task-owned artifacts.
- [ ] Secret scan (`scripts/scan-development-secrets.ps1`) reports zero findings.
- [ ] Redacted JSON evidence lists durations, pass/fail states, hashed task
      labels, and log byte counts only—no username, full path, serial, owner ID,
      domain, credential ID, raw task ID, certificate data, or secret.

## Sign-off

| Date | Commit SHA | Machine profile | Android result | Windows result | Reviewer |
|------|-----------|-----------------|----------------|----------------|----------|
|      |           |                 |                |                |          |
