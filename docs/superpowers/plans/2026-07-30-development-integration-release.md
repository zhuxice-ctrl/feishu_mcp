# Development Environment Integration and Release Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aggregate Android and Windows project providers, reach the exact 30-tool contract, complete security and HTTP integration, document real usage, validate the target Windows machine, and prepare the feature branch for review into `main`.

**Architecture:** The final project tool delegates to the closed internal provider registry; all other adapters remain independently registered. Integration tests exercise the real MCP request/approval/retry path with fake toolchains, while an explicit local acceptance script performs opt-in real Android and Windows operations without exposing credentials.

**Tech Stack:** TypeScript, MCP HTTP fixture, Node test runner, Python HTTP E2E, PowerShell acceptance and management scripts, GitHub Actions Windows runner, Markdown documentation.

---

**Prerequisite:** Complete `2026-07-30-windows-development-adapter.md` and verify `tools/list` contains exactly 29 tools.

## Task 1: `manage_development_project` and exact 30-tool inventory

**Files:**
- Create: `src/tools/developmentProjects.ts`
- Create: `test/development-project-tool.test.mjs`
- Create: `test/development-project-e2e.test.mjs`
- Modify: `src/index.ts`
- Modify: `test/tools-list.test.mjs`

- [ ] **Step 1: Write failing project-tool tests**

Assert owner-only access, provider/template listing, project inspection, strict provider-specific create schemas, directory approval, exact create approval, nonempty destination rejection, staging rollback, project summary without secrets, and no caller template path, executable, command, URL, or free-form package-manager switch.

```js
const result = await manageDevelopmentProject({ action: "list_templates", ecosystem: "android" }, ownerContext());
const body = JSON.parse(result.content[0].text);
assert.equal(body.ok, true);
assert(body.templates.every((item) => !Object.values(item).some((value) => String(value).includes("templates\\"))));
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npm run build; node --test test/development-project-tool.test.mjs test/development-project-e2e.test.mjs`

Expected: FAIL because project tool is not registered.

- [ ] **Step 3: Implement provider dispatch**

Register `manage_development_project` with actions `list_templates`, `inspect`, and `create`. List and inspect return synchronously after owner and directory checks. Create resolves the provider from the closed registry, validates its strict schema, requests exact approval showing ecosystem/template/destination/public identifiers, stages in the authorized parent, and commits atomically.

- [ ] **Step 4: Register the 30th tool**

Append `manage_development_project` after `windows_development` in `TOOL_NAMES`, register it after both provider modules have registered, and update the startup banner to derive the number from `TOOL_NAMES.length`.

- [ ] **Step 5: Run inventory tests**

Run: `npm run build; node --test test/development-project-tool.test.mjs test/development-project-e2e.test.mjs test/tools-list.test.mjs`

Expected: all tests pass; `tools/list` contains exactly 30 unique tools in the documented order.

- [ ] **Step 6: Commit**

```powershell
git add src/tools/developmentProjects.ts src/index.ts test/development-project-tool.test.mjs test/development-project-e2e.test.mjs test/tools-list.test.mjs
git commit -m "feat: expose development project management"
```

## Task 2: Health, launcher, and local task management

**Files:**
- Create: `scripts/manage-development-tasks.ps1`
- Create: `manage-development-tasks.bat`
- Create: `test/development-task-management-script.test.mjs`
- Modify: `scripts/start-feishu-mcp.ps1`
- Modify: `test/launcher.test.mjs`
- Modify: `src/index.ts`
- Modify: `test/health-concurrency.test.mjs`
- Modify: `.env.example`

- [ ] **Step 1: Write failing launcher, health, and management tests**

Assert the launcher checks broker status without installing or starting it silently, preserves configured ngrok domain, hides secrets, and reports 30 tools. Assert health contains only aggregate task/environment/broker data. Assert the management script lists redacted terminal task summaries and removes only selected terminal task directories by verified UUID.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm run build; node --test test/launcher.test.mjs test/health-concurrency.test.mjs test/development-task-management-script.test.mjs`

Expected: FAIL until the final summaries and scripts are implemented.

- [ ] **Step 3: Implement local task management**

Support `-List`, `-Remove <uuid-or-prefix>`, and `-ClearTerminal`. Resolve `APPROVAL_DATA_DIR`, require the task root to remain inside it, parse validated metadata, print only short ID, tool, action, state, timestamps, and byte size, and reject queued/running/cancel-requested deletion.

- [ ] **Step 4: Update launcher and health**

The launcher performs a read-only broker service/protocol check, displays `ready`, `missing`, or `incompatible`, and points to `install-feishu-mcp-admin-broker.bat` when missing. It does not change the fixed ngrok domain, print `.env`, install components, request UAC, or expose the broker pipe/key. Health exposes exact tool count 30, catalog version, broker state, environment-target readiness counts, and aggregate task counts only.

- [ ] **Step 5: Document final configuration keys**

Group development settings in `.env.example` with safe defaults and comments. Do not add live paths, owner IDs, domain credentials, signing IDs, or task identifiers.

- [ ] **Step 6: Run tests and commit**

```powershell
npm run build
node --test test/launcher.test.mjs test/health-concurrency.test.mjs test/development-task-management-script.test.mjs
git add scripts/manage-development-tasks.ps1 manage-development-tasks.bat scripts/start-feishu-mcp.ps1 src/index.ts .env.example test/launcher.test.mjs test/health-concurrency.test.mjs test/development-task-management-script.test.mjs
git commit -m "feat: operate development services safely"
```

## Task 3: Full HTTP approval and background-task E2E

**Files:**
- Modify: `test/helpers/mcp-http-fixture.mjs`
- Create: `test/development-tools-e2e.test.mjs`
- Modify: `test/complete-tools-e2e.test.mjs`
- Modify: `test/e2e_test.py`

- [ ] **Step 1: Extend the HTTP fixture safely**

Add optional temporary task/catalog/broker fixture roots and a fake-toolchain environment builder. The fixture must generate secrets internally, suppress them in thrown errors, stop only its own child, and delete only its disposable root.

- [ ] **Step 2: Write exact 30-tool and owner-isolation tests**

Through `/mcp`, initialize, list exactly 30 tools, call all nine new tools as a non-owner and assert `OWNER_REQUIRED`, then repeat read-only inspection as owner. Assert `/health` contains none of the generated owner ID, paths, task IDs, serials, secrets, or fake tool arguments.

- [ ] **Step 3: Write approval/retry chains**

For project creation, environment apply, Android build/device write, Windows build/script/sign/run: assert initial `input_required`, signed request state, exact accepted response, immediate identical retry, one task ID, task completion, cursor logs, and expected artifacts. Assert denial, expired state, replayed state, changed arguments, changed project digest, and legacy-client behavior.

- [ ] **Step 4: Write disconnect, restart, and cancellation E2E**

Start a long fake build, disconnect the HTTP client, verify it completes. Start another, restart the MCP server with the same data directory, query the same task, request cancellation, and verify terminal state. Start tasks for same and different project/device resources and assert configured serialization/parallelism.

- [ ] **Step 5: Extend Python smoke coverage**

Update the Python expected tool list to 30. Add read-only calls for environment inspection and health summaries; do not make real installation, device, or build changes in Python smoke tests.

- [ ] **Step 6: Run E2E tests and commit**

```powershell
npm run build
node --test test/development-tools-e2e.test.mjs test/complete-tools-e2e.test.mjs
python test/e2e_test.py
git add test/helpers/mcp-http-fixture.mjs test/development-tools-e2e.test.mjs test/complete-tools-e2e.test.mjs test/e2e_test.py
git commit -m "test: verify development tools through MCP"
```

Expected: all tests exit 0 and leave no child process or temporary root.

## Task 4: Security regression suite and Windows CI

**Files:**
- Create: `test/development-security-regression.test.mjs`
- Create: `scripts/scan-development-secrets.ps1`
- Create: `.github/workflows/windows-development.yml`
- Modify: `SECURITY.md`

- [ ] **Step 1: Write the consolidated security regression test**

Generate a table of malicious inputs covering path traversal, junctions, shell metacharacters, URLs, executable paths, package IDs, Gradle tasks, ADB serials and diagnostics, MSBuild properties, CMake variables/targets, Electron scripts, task IDs, plan IDs, owner identities, and broker protocol fields. Assert every input fails before a fake spawn recorder is called.

- [ ] **Step 2: Add repository and history secret scanning**

The PowerShell script scans tracked files and reachable Git objects for the current configured Bearer token, PIN, approval key, broker key, generated fixture secrets, credential blobs, private-key markers, PFX/keystore files, authorization headers with values, and task metadata. It prints only finding category and file/object identity, never the matched secret.

- [ ] **Step 3: Add Windows CI**

Use `windows-latest`, Node 20, and .NET 8. Run `npm ci`, typecheck, Node tests, broker tests, Python smoke, production audit, secret scan with generated fixture values, and `git diff --check`. Do not install Android SDK images, Visual Studio workloads, Electron binaries, services, or the administrator broker in CI.

- [ ] **Step 4: Update security documentation**

Document owner-only scope, trusted-toolchain exemption boundaries, broker local-only design, single-use destructive approvals, task-data protection, credential references, package-script risk, and a vulnerability-reporting checklist. State explicitly that starting MCP as administrator is unsupported.

- [ ] **Step 5: Run tests and commit**

```powershell
npm run build
node --test test/development-security-regression.test.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/scan-development-secrets.ps1
dotnet test broker/FeishuMcp.AdminBroker.Tests/FeishuMcp.AdminBroker.Tests.csproj
git add test/development-security-regression.test.mjs scripts/scan-development-secrets.ps1 .github/workflows/windows-development.yml SECURITY.md
git commit -m "test: harden local development automation"
```

Expected: every command exits 0 with zero secret findings.

## Task 5: Real Windows acceptance runner

**Files:**
- Create: `scripts/test-real-development-environment.ps1`
- Create: `test-real-development-environment.bat`
- Create: `docs/development-acceptance-checklist.md`
- Create: `test/real-development-runner.test.mjs`

- [ ] **Step 1: Write failing script-structure tests**

Assert default mode is read-only inspection, real changes require both `-Mode Android|Windows|All` and `-ConfirmRealChanges`, root must be explicitly provided and disposable, HTTP credentials come from environment without echo, cleanup is target-confined, and the script never changes ngrok configuration.

- [ ] **Step 2: Run test and verify failure**

Run: `node --test test/real-development-runner.test.mjs`

Expected: FAIL because the runner does not exist.

- [ ] **Step 3: Implement read-only default mode**

Default `-Mode Inspect` calls local `/health`, initializes MCP, checks 30 tools, inspects Android/Windows environment, checks broker state, and exits without applying plans, creating projects, starting devices, or writing outside a temporary report directory.

- [ ] **Step 4: Implement explicit Android acceptance mode**

After confirmation, create a disposable authorized root, create the controlled Kotlin project, build APK/AAB, run unit tests, create or select a test AVD by exact serial, boot and wait, install/start, capture bounded Logcat and screenshot, transfer one generated test file, test one loopback port forward, stop/clear/uninstall, sign with a configured test credential reference, and verify. Record pass/fail and redacted task IDs; do not delete a preexisting AVD.

- [ ] **Step 5: Implement explicit Windows acceptance mode**

Create disposable `.NET`, native, and Electron projects; restore/build/test/package; run and stop task-owned artifacts; validate Visual Studio/MSBuild and workload inspection; sign a disposable artifact with a test certificate reference; verify missing-credential behavior. Remove only the disposable root after the user opts into cleanup.

- [ ] **Step 6: Write the manual checklist**

Include prerequisites, disk/time expectations, UAC/broker installation, exact commands, expected task states/artifacts, secret-leak checks, port/process cleanup, ngrok `/health` and `/mcp` verification, and a sign-off table with date, commit, machine profile, Android result, Windows result, and reviewer.

- [ ] **Step 7: Run structure tests and commit**

```powershell
node --test test/real-development-runner.test.mjs
git add scripts/test-real-development-environment.ps1 test-real-development-environment.bat docs/development-acceptance-checklist.md test/real-development-runner.test.mjs
git commit -m "test: add real development acceptance runner"
```

## Task 6: README and detailed usage guide

**Files:**
- Modify: `README.md`
- Create: `docs/local-development-environment.md`
- Modify: `docs/aily-integration-guide.md`
- Create: `test/development-docs.test.mjs`

- [ ] **Step 1: Write failing documentation tests**

Assert all 30 tool names appear exactly where required, every new tool has a purpose, owner-only and no-GUI limits are explicit, administrator broker commands exist, fixed-domain placeholders do not expose credentials, all configuration keys match `config.ts`, and documented script paths exist.

- [ ] **Step 2: Run test and verify failure**

Run: `node --test test/development-docs.test.mjs`

Expected: FAIL until documentation is updated.

- [ ] **Step 3: Update README quick start**

Keep the current server/ngrok/PIN/directory workflow. Change the tool inventory to 30 and add a concise Android/Windows section covering broker installation, inspection, plan/apply, task query/log/cancel, project creation, build/test/package/run, device/emulator operations, credentials, and local-data exclusions.

- [ ] **Step 4: Write the detailed guide**

Document natural-language Feishu examples first, followed by parameter examples for integration debugging. Include `.NET`, native, Electron, Android build, emulator, physical device, signing, task recovery, concurrency, retention, failure remediation, broker update/removal, credential management, and real acceptance.

- [ ] **Step 5: Update Aily integration instructions**

Explain that all nine new tools are visible only to the configured owner, long operations return task IDs, the client must retry identical calls after approval, and clients without elicitation remain denied. Do not tell users to paste secrets into chat or configuration screenshots.

- [ ] **Step 6: Run docs tests and commit**

```powershell
node --test test/development-docs.test.mjs
git add README.md docs/local-development-environment.md docs/aily-integration-guide.md test/development-docs.test.mjs
git commit -m "docs: explain Android and Windows automation"
```

## Task 7: Final branch gate, real-machine report, and pull request

**Files:**
- Create after real validation: `docs/development-acceptance-report.md`
- Create before PR publication: `.github/development-pr-body.md`

- [ ] **Step 1: Synchronize with main without rewriting remote history**

```powershell
git fetch origin
git rebase origin/main
```

Expected: clean rebase; resolve only feature-branch conflicts and rerun the full gate after any resolution.

- [ ] **Step 2: Run the full automated gate once**

```powershell
npm ci
npm run typecheck
npm test
dotnet test broker/FeishuMcp.AdminBroker.Tests/FeishuMcp.AdminBroker.Tests.csproj
python test/e2e_test.py
npm audit --omit=dev
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/scan-development-secrets.ps1
git diff --check origin/main...HEAD
```

Expected: all commands exit 0, audit and secret findings are zero, and tool inventory is exactly 30.

- [ ] **Step 3: Run target-machine inspection and acceptance**

```powershell
.\test-real-development-environment.bat -Mode Inspect
.\test-real-development-environment.bat -Mode All -Root F:\FeishuMcpAcceptance -ConfirmRealChanges
```

Expected: Android and Windows checklists pass; all task-owned processes and ports are released. Do not run the second command until the disposable root and credential references have been reviewed locally.

- [ ] **Step 4: Commit the redacted acceptance report**

Record commit SHA, Windows version, component versions, aggregate durations, pass/fail checklist, and reviewer. Exclude username, full paths, device serial, owner ID, domain credential, task IDs, certificate private data, and secrets.

```powershell
git add docs/development-acceptance-report.md
git commit -m "test: record development environment acceptance"
```

- [ ] **Step 5: Push the feature branch and open a pull request**

```powershell
git push -u origin codex/android-windows-development-environment
gh pr create --base main --head codex/android-windows-development-environment --title "[codex] add Android and Windows development automation" --body-file .github/development-pr-body.md
```

Before running the PR command, create and commit `.github/development-pr-body.md` with these concrete sections: Summary; Security boundaries; Android capabilities; Windows capabilities; Automated validation; Real-machine acceptance; Configuration and migration; Known exclusions. Populate validation with the commands from Step 2 and the redacted results from Steps 3-4. It must state that GUI automation, Godot, Photoshop, arbitrary shell, root/bootloader operations, and always-admin MCP execution are excluded. The PR must remain unmerged until CI and a human security review pass.

```powershell
git add .github/development-pr-body.md
git commit -m "docs: prepare development automation review"
```
