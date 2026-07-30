# [codex] Add Android and Windows development automation

## Summary

Adds 9 owner-only development environment tools (tools/list 21 → 30) that let the configured owner drive local Android and Windows project automation through the MCP server: inspect environments, provision trusted components via an administrator broker, scaffold/build/test/sign projects, and manage devices/emulators — all behind exact-approval, single-use plans, and strict input schemas that reject arbitrary shell, URLs, executables, and arguments.

Phases delivered on this branch:

1. **Development task core** (Phase 1, 6 tasks) — persistent task store, redaction, scheduler, worker/coordinator with crash recovery, three owner-only MCP tools, health + retention gate. tools/list 21 → 24.
2. **Environment broker** (Phase 2, 6 tasks) — versioned trusted-component catalog, project/environment inspectors, HMAC-signed single-use plans, C# AdminBroker (named pipe, HMAC, DPAPI key), broker client, install/uninstall scripts, three environment MCP tools. tools/list 24 → 27.
3. **Android development adapter** (Phase 3, 7 tasks) — Android types/toolchain/commands, project provider + templates, Gradle wrapper verification, ADB device operations, emulator/AVD management, DPAPI credential store + Android signing, `android_development` tool (24 actions). tools/list 27 → 28.
4. **Windows development adapter** (Phase 4, 8 tasks) — project detection + toolchain, .NET/native/Electron providers, .NET/MSBuild/CMake/Ninja/CTest/Electron actions, Windows signing + process run, `windows_development` tool. tools/list 28 → 29.
5. **Integration & release** (Phase 5, 7 tasks) — `manage_development_project` tool, health/launcher/task management, HTTP E2E, security regression + CI, real acceptance runner, README + docs, final gate + this PR. tools/list 29 → 30.

## Security boundaries

- **Owner-only.** All 9 development tools require `authorizeOwnerToolCall`; non-owner callers receive `OWNER_REQUIRED` and no fallback.
- **No arbitrary execution.** Inputs are strict Zod `discriminatedUnion` schemas with `.strict()`; `url`, `executable`, `args`, and dangerous serial keywords (`bootloader`, `recovery`, `sideload`, `fastboot`) are rejected at the schema layer.
- **Exact + single-use approval.** Build/test/clean use standard exact approval bound to a project script digest (reusable). Install/uninstall/device/sign/create use single-use HMAC-signed plans that cannot be replayed and are invalidated on environment drift.
- **Administrator broker.** Privileged operations go through the C# AdminBroker over a named pipe with HMAC authentication and a DPAPI-protected key; the broker runs as a Windows service and is installed/uninstalled by signed, ACL-scoped PowerShell scripts. Non-privileged operations run locally.
- **Path confinement.** Host paths require directory authorization; device paths forbid `/data`, `/system`, `/proc`, etc.; build directories are confined (no `..` escape); symlinks are rejected.
- **Credential safety.** Signing credentials are referenced by DPAPI credential IDs (`secretEnvRefs`), never as plaintext; PINs, Bearer tokens, owner IDs, SIDs, HMAC keys, broker keys, certificate private data, and real paths are never logged or returned.
- **Redacted summaries.** `inspect_development_environment` returns only public status (componentId/displayName/state/version/remediation); plan summaries omit digests, keys, and identities.

## Android capabilities

`android_development` (24 actions): `inspect_project`, `list_templates`, `list_devices`, `list_avds`, `build`, `bundle`, `test_unit`, `test_instrumented`, `clean`, `install`, `uninstall`, `clear`, `start_app`, `force_stop`, `screenshot`, `logcat`, `diagnostic`, `push`, `pull`, `forward`, `emulator_start`, `emulator_stop`, `avd_create`, `sign`, `verify`.

Toolchain is resolved only from `ready` environment components. Gradle wrapper distribution host and SHA-256 are verified before any build. Device operations validate paths and reject dangerous operations.

## Windows capabilities

`windows_development`: .NET / MSBuild build/test/pack/clean, CMake configure/build/test/install/package (Ninja + CTest), Electron dependency install (frozen lockfile), script execution, packaging, and Windows signing (SignTool + certificate + DPAPI) with `run` executing only previously authorized artifacts as managed tasks.

`manage_development_project`: `list_templates`, `inspect`, `create` (single-use approval, atomic staging with rollback on failure).

## Automated validation

Sandbox-validatable (1-core, no .NET / no Android SDK / no real devices):

| Check | Result |
|-------|--------|
| TypeScript `tsc --noEmit` | PASS |
| Pure unit tests (development-docs + adjacent) | 10/10 PASS (docs), full suite 675 pass / 21 fail / 12 skip |
| Failed tests | All 21 are HTTP-e2e / server-spawn class (express server cannot start in 1-core sandbox) — no pure-unit regression |
| `git diff --check` | PASS |
| Tool inventory | 30 (verified by structural tests) |
| `npm audit --omit=dev` | Could not run (sandbox registry proxy does not implement the audit endpoint) — to run on real machine |

Real-machine gate (pending — requires Windows with .NET SDK, Android SDK, and a disposable device/emulator):

- [ ] `npm ci && npm run typecheck && npm test` (exit 0, all HTTP e2e green)
- [ ] `dotnet test broker/FeishuMcp.AdminBroker.Tests/FeishuMcp.AdminBroker.Tests.csproj`
- [ ] `python test/e2e_test.py`
- [ ] `npm audit --omit=dev` (0 vulnerabilities)
- [ ] `powershell -File scripts/scan-development-secrets.ps1` (0 findings)
- [ ] `git diff --check origin/main...HEAD`
- [ ] Real acceptance: `test-real-development-environment.bat -Mode Inspect` then `-Mode All`

## Real-machine acceptance

Pending. A redacted `docs/development-acceptance-report.md` will be committed after the real-machine gate passes, recording commit SHA, Windows version, component versions, aggregate durations, pass/fail checklist, and reviewer — excluding usernames, full paths, device serials, owner IDs, domain credentials, task IDs, certificate private data, and secrets.

## Configuration and migration

New environment variables (documented in `.env.example`): `DEV_ENV_CATALOG_PATH`, `DEV_ENV_PLAN_DIR`, `DEV_ENV_OWNER_SID`, `DEV_ENV_BROKER_KEY_PATH`, `DEV_ENV_ALLOWED_ROOTS`. Existing `HOST` / `MCP_ENDPOINT` now use bracket access for discoverability. No changes to the fixed ngrok domain or existing auth flow.

## Known exclusions

This PR explicitly **does not** add:

- GUI automation (no mouse/keyboard/window interaction, no screen scraping of graphical apps)
- Godot, Photoshop, or other graphical-editor automation
- Arbitrary shell execution (`shell`, `exec`, `run_command`-style tools)
- Root / bootloader / recovery / sideload / fastboot operations
- Always-admin MCP execution (privileged operations go through the broker only when a plan requires it; the MCP server itself never runs elevated)

The PR must remain **unmerged** until CI and a human security review pass.
