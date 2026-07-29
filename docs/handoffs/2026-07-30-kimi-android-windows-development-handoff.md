# Kimi Execution Handoff: Android and Windows Development Environment

**Prepared:** 2026-07-30

**Repository:** `https://github.com/zhuxice-ctrl/feishu_mcp`

**Implementation branch:** `codex/android-windows-development-environment`

**Status:** Design and implementation plans are approved. No implementation code has started.

## 1. Copy-paste instruction for Kimi

Use the following as the first instruction in the Kimi task:

> You are the implementation coordinator for `zhuxice-ctrl/feishu_mcp`. Work only on branch `codex/android-windows-development-environment`; never implement directly on `main`. First read the approved design, roadmap, all five phase plans, and this handoff report in full. Execute the plans in the documented order, beginning with `2026-07-30-development-task-core.md`. Use test-driven development, explicit file staging, small commits, and the phase gates exactly as written. You may use multiple agents only for file-disjoint tasks; you must serialize shared-file edits and all Git commits. Do not change the fixed ngrok domain, expose secrets, install real SDKs during automated tests, add GUI automation, add arbitrary shell/admin execution, or expand scope to Godot or Photoshop. After every task, report the files changed, exact tests and results, commit SHA, deviations, risks, and next task. Stop and request review before changing a security boundary or approved architecture.

## 2. Repository state at handoff

### Canonical main worktree

- Local path: `F:\feishu_mcp\aily-local-file-mcp`
- Branch: `main`
- Commit: `a27dbb49ff11607fd4cb6797cd4d211b951ca696`
- Remote: `origin/main` at the same commit
- Purpose: stable stage release and currently configured local service

Do not develop in this worktree. Do not copy its `.env` into Git, tests, logs, reports, or the feature worktree.

### Dedicated implementation worktree

- Local path: `F:\feishu_mcp\feishu-mcp-android-windows-dev`
- Branch: `codex/android-windows-development-environment`
- Planning commit: `877eecf7ae91c45b32d4f2a54007760ebff67f79`
- Remote tracking branch: `origin/codex/android-windows-development-environment`
- Purpose: all Android/Windows implementation, tests, documentation, and acceptance work

The handoff-report commit will be newer than the planning commit. Treat the current remote branch HEAD as authoritative after `git pull --ff-only`.

### Start commands

If the worktree already exists:

```powershell
Set-Location -LiteralPath 'F:\feishu_mcp\feishu-mcp-android-windows-dev'
git fetch origin
git switch codex/android-windows-development-environment
git pull --ff-only
git status --short --branch
```

If working from a different clone:

```powershell
git fetch origin
git switch --track origin/codex/android-windows-development-environment
git status --short --branch
```

Expected: clean worktree on `codex/android-windows-development-environment`, tracking the same remote branch.

## 3. Required reading order

Kimi and every implementation agent must read these documents before editing code:

1. `docs/handoffs/2026-07-30-kimi-android-windows-development-handoff.md`
2. `docs/superpowers/specs/2026-07-30-android-windows-local-development-environment-design.md`
3. `docs/superpowers/plans/2026-07-30-android-windows-development-roadmap.md`
4. `docs/superpowers/plans/2026-07-30-development-task-core.md`
5. `docs/superpowers/plans/2026-07-30-development-environment-broker.md`
6. `docs/superpowers/plans/2026-07-30-android-development-adapter.md`
7. `docs/superpowers/plans/2026-07-30-windows-development-adapter.md`
8. `docs/superpowers/plans/2026-07-30-development-integration-release.md`
9. Current `README.md`, `SECURITY.md`, `.env.example`, `src/config.ts`, `src/index.ts`, `src/security/approval.ts`, `src/security/toolAccess.ts`, `src/tools/processRunner.ts`, `src/tools/concurrency.ts`, and the existing HTTP test fixture.

Do not implement from this handoff summary alone. The phase plans contain the exact files, tests, commands, expected failures, implementation boundaries, and commit names.

## 4. Product outcome

The finished project remains a Feishu MCP service exposed through the existing authenticated Streamable HTTP/ngrok path. It expands from 21 tools to exactly 30 tools while preserving existing behavior.

The model will be able to:

- inspect Android and Windows development environments;
- generate an immutable installation/update/repair plan;
- apply an explicitly approved plan through trusted installers;
- create and inspect Android, `.NET`, native CMake, and Electron projects;
- run long builds as persistent tasks and later read status/logs, cancel, or inspect artifacts;
- build, test, package, sign, run, and diagnose Android and Windows projects;
- manage Android devices and emulators through structured, explicit operations;
- provision administrator-required components through a local allowlisted broker rather than an always-admin MCP server.

## 5. Final tool contract

### Existing tools retained unchanged: 21

1. `ping`
2. `read_file`
3. `write_file`
4. `edit_file`
5. `create_directory`
6. `list_directory`
7. `move_file`
8. `search_files`
9. `get_file_info`
10. `list_allowed_directories`
11. `auth`
12. `execute_command`
13. `search_content`
14. `git_status`
15. `git_diff`
16. `compare_files`
17. `apply_patch`
18. `web_fetch`
19. `todo_write`
20. `todo_read`
21. `ask_user`

### New tools: 9

1. `get_development_task`
2. `read_development_task_logs`
3. `cancel_development_task`
4. `inspect_development_environment`
5. `plan_environment_changes`
6. `apply_environment_plan`
7. `android_development`
8. `windows_development`
9. `manage_development_project`

Inventory progression is intentional:

- after task core: 24;
- after environment/broker: 27;
- after Android: 28;
- after Windows: 29;
- after project integration: exactly 30.

Every inventory change must update `TOOL_NAMES`, registration, startup output, `/health`, Node inventory tests, HTTP E2E, Python E2E, README, and Aily integration documentation at the phase specified by the plans.

## 6. Locked scope

### Included

- Android JDK/SDK/Gradle/ADB/emulator management.
- Android APK/AAB builds, unit/device tests, install/uninstall/start/stop/clear, Logcat, screenshots, controlled transfer, port forwarding, restricted diagnostics, and signing.
- Windows `.NET`, Visual Studio/MSBuild, WPF, WinUI, MSIX, native MSVC/CMake/Ninja/CTest/CPack, Node/Electron, packaging, signing, run, stop, and tests.
- Trusted environment detection and approved installation/update/repair.
- Persistent task engine with restart recovery, bounded concurrency, log pagination, redaction, cancellation, artifacts, and retention.
- Owner-only development controls.
- One-time local installation of a restricted administrator broker.

### Excluded

- Photoshop and Godot.
- Mouse, keyboard, window, IDE, debugger, or general GUI automation.
- Arbitrary executable paths, arbitrary download URLs, arbitrary command strings, arbitrary ADB shell, or generic administrator execution.
- Android root, bootloader unlock, recovery flashing, security-disable actions, or device-protection bypass.
- Remote desktop or screen streaming.
- Automatically retrying installation, signing, device writes, or interrupted builds.
- Running the MCP Node process permanently as administrator.

Do not add excluded features even if they appear convenient while implementing another task.

## 7. Non-negotiable security rules

### Identity and access

- All nine new tools are restricted to the configured `OWNER_USER_ID`.
- Existing tools keep their current authentication and multi-user behavior.
- Development tasks persist an HMAC-derived owner key, never a raw user ID.
- Task, broker, credential, and plan data stay beneath the protected approval data directory.
- `/health` exposes only aggregate counts and states, never identities, paths, task IDs, device serials, plan IDs, broker details, or secrets.

### Directory boundary

- Project sources, templates, inputs, outputs, keystores, and certificates remain under existing directory authorization.
- Trusted toolchain directories may be read/executed only through the new adapters.
- Trusted status never grants a directory or reusable approval to generic file or command tools.
- Canonical paths, real paths, junctions, symlinks, and existing-ancestor resolution must be checked before access.

### Execution boundary

- MCP schemas accept structured action enums and typed fields, not commands.
- Adapters construct executable/argument arrays and always use `shell: false`.
- Callers cannot choose executable paths, environment variables, URLs, installer switches, Gradle tasks, MSBuild properties, CMake variables, or Electron command suffixes.
- Short read-only actions may run synchronously. Builds, installs, packages, emulator operations, Logcat sessions, signing, and application runs use the persistent task engine.

### Approval boundary

- Existing four-choice approval remains for safe repeatable exact operations: once, session, permanent, deny.
- The task-core phase adds `decisionMode: "single_use"` to restrict destructive/sensitive actions to once or deny.
- Environment-plan application, signing, dependency-lock generation, ADB diagnostics, device install/uninstall/clear, transfer/forwarding, and other designated destructive actions use single-use approval.
- Approval subjects bind owner, tool, action, canonical project, trusted toolchain identity, relevant manifest/script digest, target, and arguments.
- A manifest, script, wrapper, lockfile, toolchain, target, or plan change invalidates approval.

### Secret boundary

- Never print, return, stage, commit, or persist the real Bearer token, PIN, approval key, ngrok credential, broker key, certificate private key, keystore password, PFX password, stored grant, or credential plaintext.
- `DevelopmentLaunchSpec.env` contains only non-secret values.
- `secretEnvRefs` contains opaque local credential IDs; worker memory resolves them immediately before spawn.
- Secrets must be registered with output redaction before the child process starts.
- Signing tools use environment/credential-store mechanisms where supported, never plaintext MCP parameters.
- Users must never be instructed to paste signing passwords into Feishu chat.

### Administrator boundary

- The broker is a separate C# Windows service and listens only on a local named pipe.
- The pipe ACL permits only LocalSystem and the configured Windows owner SID.
- Requests are length-bounded, versioned, timestamped, nonce-bearing, HMAC-authenticated, catalog-bound, plan-bound, and replay-protected.
- The broker independently reconstructs operations from an embedded reviewed catalog.
- The broker has no generic shell, URL download, registry write, file delete, process launch, or self-update operation.
- MCP remains an ordinary-user process.

## 8. Stability rules

- Prefer safety over forced cleanup. After restart, never force-kill an unverifiable PID.
- A disconnected Feishu/ngrok request must not cancel a background worker.
- Running workers with fresh valid heartbeats may be reattached after MCP restart.
- Stale or unverifiable work becomes `interrupted`; it is not retried automatically.
- Installation, signing, and device writes are never automatically retried.
- Same-project writes serialize. Same-device writes serialize. Different projects/devices may run concurrently within limits.
- Default task limits: 4 total, 2 builds, 1 privileged operation; configured caps must be enforced.
- Task logs are redacted before persistence and read with independent stdout/stderr byte cursors.
- Retention deletes only terminal task metadata/logs, never project artifacts.

## 9. Phase execution order

### Phase 1: Persistent task core

Plan: `docs/superpowers/plans/2026-07-30-development-task-core.md`

Deliverables:

- bounded configuration;
- owner-only authorization helper;
- single-use approval mode and new approval subject kinds;
- task types, owner keys, atomic store, corrupt-record quarantine;
- streaming secret redaction, including split chunks;
- resource scheduler and locks;
- detached worker, heartbeat, recovery, safe cancellation;
- three task-control tools;
- aggregate health and retention.

Critical reviews:

- no plaintext secret in `launch.json`;
- no raw owner identity in task files;
- no forced cancellation by recovered parent PID;
- resource locks release after success, failure, timeout, and cancellation;
- internal task path remains protected by existing path guards.

Expected inventory: 24.

### Phase 2: Environment and administrator broker

Plan: `docs/superpowers/plans/2026-07-30-development-environment-broker.md`

Deliverables:

- strict reviewed component catalog;
- trusted executable discovery and environment snapshots;
- signed immutable environment plans;
- C# allowlisted administrator service;
- deterministic broker build artifact and SHA-256 manifest;
- Node named-pipe client;
- install/uninstall scripts;
- environment inspection, plan, and apply tools.

Critical reviews:

- catalog URLs exist only in reviewed repository data;
- callers cannot provide URL, executable, arguments, package source, or registry path;
- signatures/checksums and publisher rules fail closed;
- plan is owner/catalog/environment/version/expiry-bound and single-use;
- named-pipe ACL, HMAC, nonce, timestamp, and applied-plan persistence work;
- install script cannot delete or replace paths outside its verified fixed directory.

Expected inventory: 27.

### Phase 3: Android adapter

Plan: `docs/superpowers/plans/2026-07-30-android-development-adapter.md`

Deliverables:

- safe Android action schemas and argument builders;
- versioned Kotlin and Compose project providers;
- verified Gradle Wrapper generation and checksum policy;
- Gradle build/test/artifact adapter;
- ADB device/application/diagnostic/transfer/forwarding adapter;
- emulator/AVD lifecycle with real readiness checks;
- DPAPI credential-reference management;
- APK/AAB signing and verification;
- `android_development`.

Critical reviews:

- no arbitrary Gradle task or flag;
- explicit device serial on every device-affecting call;
- no arbitrary ADB shell tokens;
- no root, bootloader, security-setting, host-shell, pipe, redirect, or substitution path;
- host and device transfer paths are independently constrained;
- emulator start is not successful until boot readiness is verified;
- signing secrets never enter task metadata or arguments.

Expected inventory: 28.

### Phase 4: Windows adapter

Plan: `docs/superpowers/plans/2026-07-30-windows-development-adapter.md`

Deliverables:

- project and Visual Studio/toolchain detection;
- `.NET` and native project providers;
- locked Electron provider;
- `.NET`, MSBuild, native CMake/Ninja/CTest, and Electron action adapters;
- Windows signing and task-owned application execution;
- `windows_development`.

Critical reviews:

- ambiguous solution/toolchain selection requires explicit input;
- no caller MSBuild property, CMake variable/target, package-manager switch, or Electron suffix;
- no-lock `.NET` projects use a separately approved lock-generation action;
- Electron package scripts bind exact current script and lockfile digests;
- SignTool uses an approved certificate reference and verifies the result;
- stop accepts a task identity, never a caller PID.

Expected inventory: 29.

### Phase 5: Integration and release

Plan: `docs/superpowers/plans/2026-07-30-development-integration-release.md`

Deliverables:

- `manage_development_project` and exact 30-tool inventory;
- final health, launcher, and local task-management behavior;
- full HTTP approval/retry/restart/cancel E2E;
- consolidated security regression suite;
- Windows CI;
- opt-in real Android/Windows acceptance runner;
- README, detailed usage guide, Aily integration guide, acceptance checklist/report;
- feature branch push and pull request.

Critical reviews:

- fixed ngrok domain configuration remains unchanged;
- default real-acceptance mode is inspection only;
- real changes require explicit mode, disposable root, and confirmation switch;
- CI never installs heavy real SDK/workloads/services or changes a device;
- real report contains no username, paths, serial, owner ID, credential, or private certificate data;
- exact final inventory is 30.

## 10. Multi-agent coordination rules

Kimi is the only integration coordinator and Git owner.

### Agents may do

- work on a bounded task with an explicit file list;
- add tests and implementation only in their assigned files;
- run focused read-only or disposable tests;
- report a patch and evidence to the coordinator.

### Agents must not do

- commit concurrently;
- stage with `git add -A`;
- modify another agent's files;
- edit `.env` or use secrets from the canonical main worktree;
- install real SDKs, broker services, workloads, drivers, or device images during implementation tests;
- change `src/index.ts`, `src/config.ts`, `.env.example`, README, shared fixtures, catalogs, or plan checkboxes unless assigned to the coordinator;
- rebase, merge, push, delete a branch/worktree, or open a PR independently.

### Safe parallel opportunities

- Phase 2: after the catalog commit, C# broker internals may be developed separately from Node discovery/planning, provided the catalog is read-only and commits are serialized.
- Phase 3: after Android contracts, project provider, Gradle, ADB, emulator, and credential/signing tasks use mostly disjoint files; registration remains last and coordinator-owned.
- Phase 4: after detection/contracts, `.NET/MSBuild`, native, Electron, and signing/run tasks may be file-disjoint; registration remains last and coordinator-owned.
- Phase 5 shared integration and documentation should be serialized.

After accepting an agent's work, Kimi runs the focused tests itself, reviews scope/security, stages explicit paths, commits, and only then marks corresponding plan checkboxes complete.

## 11. Git procedure

- Branch: `codex/android-windows-development-environment` only.
- Never force-push.
- Never develop on `main`.
- Before every task:

```powershell
git status --short --branch
git diff --check
```

- Stage only the task's named paths.
- Use the commit message written in the phase plan.
- After every commit:

```powershell
git show --stat --oneline HEAD
git status --short --branch
```

- Push checkpoints only after a phase gate passes:

```powershell
git push origin codex/android-windows-development-environment
```

- Before the final PR:

```powershell
git fetch origin
git rebase origin/main
```

If rebase conflicts touch security, approval, task persistence, tool registration, configuration, or launcher behavior, stop and request review rather than choosing behavior silently.

## 12. Test procedure

### Before implementation

Run the current baseline from the feature worktree:

```powershell
npm ci
npm run typecheck
npm test
python test/e2e_test.py
npm audit --omit=dev
git diff --check
```

The stage release previously passed 177 Node tests, 43 Python tests, typecheck, and a zero-vulnerability production audit. Kimi must record the actual fresh baseline instead of assuming those counts remain unchanged.

### During each task

1. Write the named failing test.
2. Run it and record the expected failure reason.
3. Implement only enough for the test and approved design.
4. Run the focused tests.
5. Run adjacent regression tests named by the plan.
6. Inspect the diff and secret exposure.
7. Commit explicit paths.

### Every phase gate

```powershell
npm run typecheck
npm test
python test/e2e_test.py
npm audit --omit=dev
git diff --check
```

After broker source exists, also run:

```powershell
dotnet test broker/FeishuMcp.AdminBroker.Tests/FeishuMcp.AdminBroker.Tests.csproj
```

After the security scanner exists, also run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/scan-development-secrets.ps1
```

All commands must exit 0 before advancing. New security tests must not be skipped.

## 13. Test isolation

- Use `mkdtemp` or equivalent for every Node test root.
- Fake Gradle, ADB, emulator, SDK Manager, dotnet, MSBuild, CMake, package-manager, SignTool, and broker behavior.
- Inject executable verifiers and fake candidates; do not depend on the developer's real installations in automated tests.
- Use random local HTTP ports.
- Stop only spawned fixture processes.
- Delete only verified temporary roots.
- Never write to the owner's default F-drive projects, real Android SDK, real Visual Studio installation, real device, real AVD, real certificate store, or real task/approval data.
- Broker unit tests use in-memory/temp state and do not install a Windows service.
- Real-machine mutations are deferred to the Phase 5 acceptance runner with explicit confirmation.

## 14. Fixed deployment constraints

- Preserve the user's configured fixed ngrok domain. Do not change, regenerate, replace, hard-code, or publish its credentials.
- Keep `/mcp` and `/health` endpoint behavior compatible.
- Keep the current Bearer/PIN/owner/directory approval flow.
- Keep the running stable service on the canonical main worktree until Phase 5 real acceptance.
- Tests must use random local ports rather than port 3000 where possible.
- Do not stop or repoint the user's stable service during ordinary implementation.

## 15. Permitted deviations

Kimi may make a narrow implementation correction without redesign only when all of these are true:

- it preserves the approved tool name and external behavior;
- it does not weaken owner, path, approval, process, broker, supply-chain, credential, or log boundaries;
- it does not add a dependency with native Windows installation risk unless the plan already requires it;
- it is covered by a failing test first;
- it is documented in the task report and final acceptance report.

Kimi must stop for review before:

- renaming, merging, or deleting any of the nine tools;
- changing the 30-tool final count;
- allowing non-owner development access;
- accepting arbitrary commands, arguments, paths, URLs, package sources, or environment variables;
- changing single-use approval to remembered approval;
- making MCP run as administrator;
- replacing the named-pipe broker architecture;
- persisting secrets or raw owner/device identity;
- changing the fixed tunnel/domain workflow;
- adding Godot, Photoshop, GUI automation, root, or bootloader operations;
- merging to `main` before all gates and real acceptance pass.

## 16. Task completion report format

After every plan task, Kimi reports:

```markdown
### Task N complete: <task name>

- Branch: codex/android-windows-development-environment
- Commit: <full SHA>
- Files changed:
  - <path>: <purpose>
- Tests written:
  - <test name and security/property covered>
- Commands run:
  - `<exact command>` → PASS/FAIL with counts
- Security checks:
  - owner isolation: PASS/NOT APPLICABLE
  - path/junction confinement: PASS/NOT APPLICABLE
  - command/argument injection: PASS/NOT APPLICABLE
  - secret persistence/logging: PASS/NOT APPLICABLE
- Plan deviations: none, or an exact explanation
- Remaining risks: none, or an exact explanation
- Worktree: clean/dirty with listed files
- Next task: <plan task>
```

Do not report only “tests passed.” Include exact commands and evidence.

## 17. Phase completion report format

At each phase gate, Kimi reports:

```markdown
## Phase N gate

- Commit range: <first SHA>..<last SHA>
- Tool inventory: <expected count> unique tools
- Typecheck: PASS
- Node suite: <passed>/<total>, zero new skips
- Python suite: <passed>/<total>
- Broker suite: <passed>/<total> or not yet present
- Production audit: 0 vulnerabilities
- Secret scan: 0 findings or not yet present
- git diff --check: PASS
- Real machine changed: no
- Stable main service changed: no
- Open risks/deviations: <list or none>
- Remote branch pushed: yes/no
```

Wait for review if the phase contains a security deviation or unresolved risk.

## 18. Blocking conditions

Stop the affected task and report evidence if:

- baseline tests fail before the first implementation change;
- the working tree contains unrelated user changes;
- a required plan path or current API differs materially from the plan;
- a security test requires weakening an approved boundary;
- a tool requires arbitrary shell or administrator execution to function;
- a package/tool source cannot be verified from the fixed catalog;
- a broker ACL/HMAC/replay test cannot be made reliable;
- a secret appears in metadata, logs, process arguments, test output, tracked files, or Git history;
- a test would modify a real SDK/device/project/service;
- fixed-domain configuration would have to change;
- a phase gate cannot return to all-green after one scoped correction.

Do not hide a blocker by skipping a test, broadening an allowlist, disabling verification, increasing permissions, or marking a failing action unsupported without review.

## 19. Definition of done

Implementation is complete only when:

- the nine new tools exist and all existing tools remain backward compatible;
- `tools/list` returns exactly 30 unique tools;
- every new tool is owner-only;
- project and internal-data boundaries pass traversal/junction tests;
- task persistence, redaction, restart recovery, cancellation, concurrency, and retention pass;
- trusted toolchain discovery and immutable plans pass spoofing/tampering tests;
- administrator broker has no generic execution primitive and passes ACL/HMAC/replay/version/catalog tests;
- Android fake-toolchain tests and the real Android acceptance path pass;
- `.NET`, MSBuild, native, Electron fake-toolchain tests and real Windows acceptance paths pass;
- signing uses local credential references and exposes no secrets;
- README and detailed guide match actual schemas and behavior;
- Node, Python, broker, typecheck, audit, security scan, and diff checks pass;
- a redacted real-machine acceptance report is committed;
- the feature branch is rebased on current `origin/main` without force push;
- CI and human security review pass before merge;
- the fixed ngrok domain and canonical main `.env` remain unchanged.

## 20. First action for Kimi

Kimi should not start with Android or Windows adapters. The first action is:

1. synchronize the feature branch;
2. read all required documents;
3. run and record the clean baseline;
4. open `2026-07-30-development-task-core.md`;
5. execute Phase 1 Task 1, beginning with the failing configuration and owner-access tests;
6. stop after the first commit and provide the task completion report for review.

This first checkpoint verifies that Kimi is following the branch, TDD, security, and reporting rules before the larger task engine work begins.
