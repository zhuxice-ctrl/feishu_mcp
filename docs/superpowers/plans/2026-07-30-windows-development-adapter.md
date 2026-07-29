# Windows Development Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add complete structured `.NET`, Visual Studio/MSBuild, native CMake/Ninja, and Electron project, build, test, package, signing, run, and stop capabilities through `windows_development`.

**Architecture:** Detect project ecosystems and trusted tool instances, map strict action schemas to fixed argument arrays, bind project-manifest digests to approvals, and run long work through the shared task engine. Repository-owned providers create controlled projects; existing project scripts run only by exact manifest name and digest.

**Tech Stack:** TypeScript, Zod, .NET SDK, Visual Studio/MSBuild/Windows SDK, MSVC, CMake, Ninja, CTest, Node.js/npm/pnpm/Yarn, Electron Builder/Forge, SignTool, DPAPI credential references.

---

**Prerequisite:** Complete `2026-07-30-android-development-adapter.md` and verify `tools/list` contains exactly 28 tools.

## Task 1: Windows project detection and trusted toolchain selection

**Files:**
- Create: `src/development/windows/types.ts`
- Create: `src/development/windows/projectDetector.ts`
- Create: `src/development/windows/toolchain.ts`
- Create: `test/windows-project-detector.test.mjs`
- Create: `test/windows-toolchain.test.mjs`

- [ ] **Step 1: Write failing detection tests**

Create temporary `.sln`, `.csproj`, `.vcxproj`, `CMakeLists.txt`, `CMakePresets.json`, `package.json`, and lockfile fixtures. Assert deterministic ecosystem detection, mixed-project reporting, solution/project membership, architecture/configuration enums, lockfile/package-manager mapping, and rejection of junction escapes.

```js
assert.deepEqual(await detectWindowsProject(dotnetRoot), {
  ecosystems: ["dotnet"],
  entrypoints: [{ kind: "project", relativePath: "App.csproj" }],
  packageManager: null,
});
```

- [ ] **Step 2: Write failing toolchain-selection tests**

Mock multiple Visual Studio instances and assert explicit compatible-instance selection by instance ID, workload validation, Windows SDK/SignTool architecture matching, and failure on untrusted or ambiguous instances.

- [ ] **Step 3: Run tests and verify failure**

Run: `npm run build; node --test test/windows-project-detector.test.mjs test/windows-toolchain.test.mjs`

Expected: FAIL because Windows modules do not exist.

- [ ] **Step 4: Implement project detection**

Read only fixed manifest names, canonicalize entrypoints, and return relative paths. A caller must select an entrypoint when a root contains more than one valid solution/project. Do not execute MSBuild evaluation or package scripts during inspection.

- [ ] **Step 5: Implement trusted toolchain selection**

Select only records from the environment snapshot: `dotnet`, a `vswhere`-verified Visual Studio/MSBuild instance, Windows SDK tools, CMake, Ninja, Node.js, Corepack/package managers, and SignTool. Bind instance ID, version, workloads, and file identities into the private toolchain digest.

- [ ] **Step 6: Run tests and commit**

```powershell
npm run build
node --test test/windows-project-detector.test.mjs test/windows-toolchain.test.mjs
git add src/development/windows test/windows-project-detector.test.mjs test/windows-toolchain.test.mjs
git commit -m "feat: detect Windows development projects"
```

## Task 2: `.NET` and native project providers

**Files:**
- Create: `src/development/windows/dotnetProjectProvider.ts`
- Create: `src/development/windows/nativeProjectProvider.ts`
- Create: `templates/windows/native-basic/CMakeLists.txt.tpl`
- Create: `templates/windows/native-basic/src/main.cpp.tpl`
- Create: `templates/windows/native-basic/tests/main_test.cpp.tpl`
- Create: `templates/windows/native-basic/CMakePresets.json.tpl`
- Create: `test/windows-dotnet-project-provider.test.mjs`
- Create: `test/windows-native-project-provider.test.mjs`

- [ ] **Step 1: Write failing provider tests**

Assert available-template enumeration, strict name/path/framework validation, official `dotnet new` invocation for installed templates, explicit failure when WinUI templates are missing, native template token replacement, nonempty-destination denial, staging rollback, and provider registration under `dotnet` and `native`.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm run build; node --test test/windows-dotnet-project-provider.test.mjs test/windows-native-project-provider.test.mjs`

Expected: FAIL because providers do not exist.

- [ ] **Step 3: Implement `.NET` creation**

Enumerate `dotnet new list --format json` through the trusted executable. Accept only catalog-approved short names such as `console`, `classlib`, `xunit`, `wpf`, and installed WinUI/MSIX profiles. Invoke `dotnet new <shortName> --name <validated> --output <staging> --framework <enum>` with no caller switches, then move staging atomically.

- [ ] **Step 4: Implement native creation**

Render the repository CMake template with project name, C++ standard enum, executable/library choice, and test option. Presets are limited to catalog-defined `msvc-debug`, `msvc-release`, `ninja-debug`, and `ninja-release`. Do not embed local Visual Studio paths.

- [ ] **Step 5: Run tests and commit**

```powershell
npm run build
node --test test/windows-dotnet-project-provider.test.mjs test/windows-native-project-provider.test.mjs
git add src/development/windows templates/windows/native-basic test/windows-dotnet-project-provider.test.mjs test/windows-native-project-provider.test.mjs
git commit -m "feat: create dotnet and native projects"
```

## Task 3: Electron project provider and lockfile policy

**Files:**
- Create: `src/development/windows/electronProjectProvider.ts`
- Create: `src/development/windows/electronManifest.ts`
- Create: `templates/windows/electron-basic/package.json.tpl`
- Create: `templates/windows/electron-basic/package-lock.json.tpl`
- Create: `templates/windows/electron-basic/src/main.js.tpl`
- Create: `templates/windows/electron-basic/src/preload.js.tpl`
- Create: `templates/windows/electron-basic/src/index.html.tpl`
- Create: `test/windows-electron-project-provider.test.mjs`
- Create: `test/windows-electron-security.test.mjs`

- [ ] **Step 1: Write failing provider and security tests**

Assert exact template dependencies, lockfile presence, no install during rendering, supported npm/pnpm/Yarn lockfiles, package-script enumeration, manifest+lock digest, changed-script invalidation, lifecycle-script reporting, and rejection of script names containing whitespace, prefixes, shell suffixes, or missing manifest entries.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm run build; node --test test/windows-electron-project-provider.test.mjs test/windows-electron-security.test.mjs`

Expected: FAIL because Electron provider and parser do not exist.

- [ ] **Step 3: Implement the controlled template**

Pin Electron and packager versions in both template files, include scripts `start`, `test`, and `package`, and contain no postinstall download script outside the pinned dependency lifecycle. Rendering replaces only project name, package ID, product name, and package-manager profile.

- [ ] **Step 4: Implement strict manifest inspection**

Parse JSON without prototype keys, require one recognized lockfile, map it to exactly one package manager, and return script name plus SHA-256 of exact script text. Summarize lifecycle scripts that dependency installation may execute. Never return registry credentials.

- [ ] **Step 5: Run tests and commit**

```powershell
npm run build
node --test test/windows-electron-project-provider.test.mjs test/windows-electron-security.test.mjs
git add src/development/windows templates/windows/electron-basic test/windows-electron-project-provider.test.mjs test/windows-electron-security.test.mjs
git commit -m "feat: add locked Electron project provider"
```

## Task 4: `.NET`, Visual Studio, and MSBuild actions

**Files:**
- Create: `src/development/windows/dotnet.ts`
- Create: `src/development/windows/msbuild.ts`
- Create: `src/development/windows/windowsArtifacts.ts`
- Create: `test/fixtures/fake-dotnet.mjs`
- Create: `test/fixtures/fake-msbuild.mjs`
- Create: `test/windows-dotnet-actions.test.mjs`
- Create: `test/windows-msbuild-actions.test.mjs`

- [ ] **Step 1: Write failing action tests**

Cover restore with locked mode, build/test/publish/pack, configuration/framework/runtime enums, solution/project selection, MSBuild instance selection, WPF/WinUI/MSIX profile checks, binary logs inside task storage, timeout/cancel, script digest, and artifact confinement.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm run build; node --test test/windows-dotnet-actions.test.mjs test/windows-msbuild-actions.test.mjs`

Expected: FAIL because action modules do not exist.

- [ ] **Step 3: Implement fixed `dotnet` actions**

When `packages.lock.json` exists, map restore to `restore --locked-mode`. When it is absent, expose a separate `generate_dependency_lock` action that requires exact approval and invokes `restore --use-lock-file`; ordinary restore never silently creates or changes a lock. Map the remaining actions to `build --no-restore`, `test --no-build --logger trx`, `publish --no-build`, and `pack --no-build`. Configuration, framework, runtime, architecture, and output are separately validated fields. A caller cannot supply MSBuild properties or switches.

- [ ] **Step 4: Implement fixed MSBuild actions**

Use the selected trusted `MSBuild.exe` with a canonical solution/project, `/nologo`, `/m:<bounded>`, `/t:<fixed-target>`, and adapter-generated configuration/platform/output properties. Allow only fixed targets `Restore`, `Build`, `Rebuild`, `Clean`, `Test`, and catalog-approved MSIX packaging targets.

- [ ] **Step 5: Collect artifacts**

Scan only known output, package, publish, TestResults, and AppPackages roots. Canonicalize and hash installers/packages/binaries; record test reports as reports. Never scan the entire project or user profile.

- [ ] **Step 6: Run tests and commit**

```powershell
npm run build
node --test test/windows-dotnet-actions.test.mjs test/windows-msbuild-actions.test.mjs
git add src/development/windows/dotnet.ts src/development/windows/msbuild.ts src/development/windows/windowsArtifacts.ts test/fixtures/fake-dotnet.mjs test/fixtures/fake-msbuild.mjs test/windows-dotnet-actions.test.mjs test/windows-msbuild-actions.test.mjs
git commit -m "feat: build dotnet and MSBuild projects"
```

## Task 5: Native CMake, Ninja, and CTest actions

**Files:**
- Create: `src/development/windows/native.ts`
- Create: `test/fixtures/fake-cmake.mjs`
- Create: `test/windows-native-actions.test.mjs`

- [ ] **Step 1: Write failing native tests**

Cover configure/build/test/install-to-authorized-root/CPack, preset allowlist, generator/toolchain identity, build directory confinement, configuration/target enums discovered from CMake File API, parallelism cap, cancellation, and malicious cache-variable or target input rejection.

- [ ] **Step 2: Run test and verify failure**

Run: `npm run build; node --test test/windows-native-actions.test.mjs`

Expected: FAIL because native actions do not exist.

- [ ] **Step 3: Implement fixed CMake actions**

Prefer approved project presets. Otherwise generate adapter-owned configure arguments using a verified MSVC or Ninja generator. Build targets must come from CMake File API replies, not caller strings. Install destinations require directory authorization and use `cmake --install`; package uses `cpack --config` in the verified build root.

- [ ] **Step 4: Run tests and commit**

```powershell
npm run build
node --test test/windows-native-actions.test.mjs
git add src/development/windows/native.ts test/fixtures/fake-cmake.mjs test/windows-native-actions.test.mjs
git commit -m "feat: build native Windows projects"
```

## Task 6: Electron dependency, script, test, and package actions

**Files:**
- Create: `src/development/windows/electron.ts`
- Create: `test/fixtures/fake-package-manager.mjs`
- Create: `test/windows-electron-actions.test.mjs`
- Create: `test/windows-electron-injection.test.mjs`

- [ ] **Step 1: Write failing Electron tests**

Cover `npm ci`, `pnpm install --frozen-lockfile`, and `yarn install --immutable`; exact manifest script execution; lifecycle-script approval summary; changed manifest/lock invalidation; package artifact collection; registry redaction; and shell/flag/script-name injection attempts.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm run build; node --test test/windows-electron-actions.test.mjs test/windows-electron-injection.test.mjs`

Expected: FAIL because Electron actions do not exist.

- [ ] **Step 3: Implement frozen installation**

Choose the package manager solely from the recognized lockfile. Use the trusted executable or trusted Corepack shim with fixed frozen-install arguments. Bind package manifest, lockfile, package-manager version, configured registry origin, and lifecycle-script summary to approval.

- [ ] **Step 4: Implement exact script execution**

Accept a script name enum populated from the inspected current manifest, re-read and digest immediately before queueing, and invoke the package manager as `["run", scriptName]` with no `--` suffix. Test and package actions may select only manifest scripts classified during inspection.

- [ ] **Step 5: Collect Electron artifacts**

Inspect configured packager output directories for `.exe`, `.msix`, `.msi`, `.zip`, block maps, and update metadata. Reject junctions and paths outside the project-authorized output root.

- [ ] **Step 6: Run tests and commit**

```powershell
npm run build
node --test test/windows-electron-actions.test.mjs test/windows-electron-injection.test.mjs
git add src/development/windows/electron.ts test/fixtures/fake-package-manager.mjs test/windows-electron-actions.test.mjs test/windows-electron-injection.test.mjs
git commit -m "feat: build locked Electron projects"
```

## Task 7: Windows signing, execution, and process ownership

**Files:**
- Create: `src/development/windows/signing.ts`
- Create: `src/development/windows/run.ts`
- Create: `scripts/import-development-signing-credential.ps1`
- Create: `test/windows-signing.test.mjs`
- Create: `test/windows-run.test.mjs`

- [ ] **Step 1: Write failing signing and run tests**

Assert SignTool trust, certificate fingerprint lookup, validity and code-signing EKU, DPAPI PFX import without password arguments, timestamp-origin allowlist, signature verification, staged output, executable artifact confinement, task-owned start/stop, restart recovery, and refusal to stop unrelated PIDs.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm run build; node --test test/windows-signing.test.mjs test/windows-run.test.mjs`

Expected: FAIL because signing and run modules do not exist.

- [ ] **Step 3: Implement certificate resolution and signing**

Prefer a CurrentUser certificate-store thumbprint referenced by credential ID. For an encrypted PFX reference, the fixed local helper decrypts with DPAPI and imports into a temporary CurrentUser store location without placing the password on the command line, then removes it in `finally`. Invoke trusted SignTool with fixed digest and catalog timestamp origin, verify, and return only public certificate metadata.

- [ ] **Step 4: Implement owned process execution**

Run only an artifact produced or explicitly selected inside the authorized project/output root. Persist its canonical path hash in the launch spec. Treat a running application as a task; stop routes through `cancel_development_task` or a `stop` action that resolves to the same task ID. Never accept a PID from the caller.

- [ ] **Step 5: Run tests and commit**

```powershell
npm run build
node --test test/windows-signing.test.mjs test/windows-run.test.mjs
git add src/development/windows/signing.ts src/development/windows/run.ts scripts/import-development-signing-credential.ps1 test/windows-signing.test.mjs test/windows-run.test.mjs
git commit -m "feat: sign and run Windows artifacts"
```

## Task 8: `windows_development` tool and Phase 4 gate

**Files:**
- Create: `src/tools/windowsDevelopment.ts`
- Create: `test/windows-development-tool.test.mjs`
- Create: `test/windows-development-e2e.test.mjs`
- Modify: `src/index.ts`
- Modify: `src/tools/results.ts`
- Modify: `test/tools-list.test.mjs`

- [ ] **Step 1: Write failing tool and HTTP tests**

Assert strict ecosystem/action schemas, owner-only access, project-directory approval, exact operation approval, synchronous inspection, background task IDs, logs/cancel/artifacts, manifest digest changes, missing workload errors, and no arbitrary executable/command/URL/switch field.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm run build; node --test test/windows-development-tool.test.mjs test/windows-development-e2e.test.mjs`

Expected: FAIL because `windows_development` is not registered.

- [ ] **Step 3: Implement action dispatch**

Register one strict `windows_development` tool. Inspect actions return synchronously. Restore/build/test/package/run operations revalidate project and toolchain digests and use standard exact approval. Dependency-lock generation and signing call `requestApproval` with `decisionMode: "single_use"`. Approved work enqueues an internal task and returns its task ID. Stop resolves an owned running task; it never accepts a process ID.

- [ ] **Step 4: Register providers and tool**

Register `.NET`, native, and Electron providers in the internal registry. Append `windows_development` after `android_development` in `TOOL_NAMES`. Update inventory to exactly 29 tools.

- [ ] **Step 5: Run the Phase 4 gate**

```powershell
npm run typecheck
npm test
dotnet test broker/FeishuMcp.AdminBroker.Tests/FeishuMcp.AdminBroker.Tests.csproj
python test/e2e_test.py
npm audit --omit=dev
git diff --check
```

Expected: every command exits 0 and `tools/list` contains exactly 29 unique tools.

- [ ] **Step 6: Commit**

```powershell
git add src/tools/windowsDevelopment.ts src/index.ts src/tools/results.ts test/windows-development-tool.test.mjs test/windows-development-e2e.test.mjs test/tools-list.test.mjs
git commit -m "feat: expose Windows development adapter"
```
