# Android and Windows Development Environment Roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved 30-tool Android and Windows local development environment without developing directly on `main`.

**Architecture:** Build a persistent owner-only task core first, then add trusted environment provisioning and the administrator broker, then the Android and Windows adapters, and finish with the shared project tool and real-path release checks. Each phase is independently testable and lands as a sequence of small commits on `codex/android-windows-development-environment`.

**Tech Stack:** Node.js 20+, TypeScript 5.7, MCP TypeScript SDK v2 beta, Zod 4, Node test runner, PowerShell 7/Windows PowerShell 5.1, .NET 8 C# broker, Android SDK/ADB/Gradle, Visual Studio/MSBuild/.NET/CMake/Ninja/Node/Electron.

---

## Branch and worktree

- Feature branch: `codex/android-windows-development-environment`
- Dedicated worktree: `F:\feishu_mcp\feishu-mcp-android-windows-dev`
- Base commit: `a27dbb49ff11607fd4cb6797cd4d211b951ca696`
- Canonical `main` worktree remains: `F:\feishu_mcp\aily-local-file-mcp`

All implementation commands in the phase plans run from the dedicated worktree. Do not commit implementation directly to `main`, do not force-push, and do not copy `.env`, task data, broker credentials, certificates, keystores, or approval data into the worktree.

## Plan sequence

1. `2026-07-30-development-task-core.md`
   - owner-only authorization for development tools;
   - task storage, redaction, worker protocol, recovery, resource locks;
   - `get_development_task`, `read_development_task_logs`, and `cancel_development_task`.
2. `2026-07-30-development-environment-broker.md`
   - trusted executable discovery and environment snapshots;
   - immutable environment plans;
   - local named-pipe administrator broker;
   - `inspect_development_environment`, `plan_environment_changes`, and `apply_environment_plan`.
3. `2026-07-30-android-development-adapter.md`
   - controlled Android project provider;
   - Gradle, SDK, emulator, ADB, signing, artifacts;
   - `android_development`.
4. `2026-07-30-windows-development-adapter.md`
   - `.NET`, Visual Studio/MSBuild, native CMake/Ninja, and Electron;
   - packaging, signing, execution, artifacts;
   - `windows_development`.
5. `2026-07-30-development-integration-release.md`
   - `manage_development_project` provider aggregation;
   - exact 30-tool HTTP integration;
   - launcher, approval manager, README, detailed guide, security and real-machine checks.

The phases are ordered dependencies. An agent may parallelize tasks inside a phase only where the phase plan explicitly marks file ownership as disjoint. Do not run Android and Windows integration edits to `src/index.ts`, `src/config.ts`, `.env.example`, `README.md`, or shared test fixtures concurrently.

## Locked file ownership

| Area | Primary files | Owning phase |
|---|---|---|
| Development task core | `src/development/tasks/*`, `src/tools/developmentTasks.ts` | Phase 1 |
| Owner authorization | `src/security/toolAccess.ts` | Phase 1 |
| Shared development configuration | `src/config.ts`, `.env.example` | Phase 1, then serialized integration edits |
| Tool inventory and registration | `src/index.ts`, `test/tools-list.test.mjs` | Serialized at the end of each phase |
| Environment discovery and plans | `src/development/environment/*`, `src/tools/developmentEnvironment.ts` | Phase 2 |
| Administrator broker | `broker/*`, `scripts/*admin-broker*` | Phase 2 |
| Android | `src/development/android/*`, `src/tools/androidDevelopment.ts`, `templates/android/*` | Phase 3 |
| Windows | `src/development/windows/*`, `src/tools/windowsDevelopment.ts`, `templates/windows/*` | Phase 4 |
| Project provider aggregation | `src/development/projects/*`, `src/tools/developmentProjects.ts` | Phase 5 |
| End-user documentation and release checks | `README.md`, `docs/local-development-environment.md`, `SECURITY.md` | Phase 5 |

## Phase gates

Every phase must satisfy all of these before the next begins:

- [ ] `npm run typecheck` exits 0.
- [ ] `npm test` exits 0 with no skipped new security test.
- [ ] `python test/e2e_test.py` exits 0.
- [ ] `git diff --check` exits 0.
- [ ] `npm audit --omit=dev` reports 0 vulnerabilities.
- [ ] New task data, logs, PIDs, broker registration, credentials, certificates, and keystores are ignored by Git.
- [ ] `git status --short` contains only the files named by the current task before each commit.
- [ ] No test modifies a real SDK, Visual Studio installation, Android device, emulator, user project, or project under `F:\` outside a generated temporary root.

## Review gates

- Phase 1 review focuses on persistence correctness, owner isolation, process identity, cancellation, and log redaction.
- Phase 2 review focuses on trust discovery, immutable plans, pipe ACLs, replay prevention, and absence of a generic privileged execution primitive.
- Phase 3 review focuses on explicit device selection, ADB-shell grammar, Gradle-wrapper validation, and signing-secret handling.
- Phase 4 review focuses on project-script digests, lockfile enforcement, Visual Studio instance selection, signing, and process ownership.
- Phase 5 review compares every design requirement with a passing automated or documented real-machine acceptance check.

## Final merge procedure

After every phase passes and the real Windows acceptance report is committed:

```powershell
git fetch origin
git rebase origin/main
npm ci
npm test
python test/e2e_test.py
npm audit --omit=dev
git diff --check origin/main...HEAD
git push -u origin codex/android-windows-development-environment
```

Open a pull request from `codex/android-windows-development-environment` to `main`. Merge only after CI and the target-machine acceptance checklist pass. Delete the feature branch and dedicated worktree only after `origin/main` contains the merge commit and the local `.env` remains in the canonical main worktree.
