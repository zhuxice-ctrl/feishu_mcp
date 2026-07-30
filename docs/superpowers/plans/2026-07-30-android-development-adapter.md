# Android Development Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a controlled Android project provider and complete owner-only Android build, test, emulator, device, diagnostic, transfer, forwarding, and signing operations through `android_development`.

**Architecture:** Resolve Android tools only through the trusted environment snapshot, construct argument arrays from action-specific schemas, and route long operations through the persistent task core. Short read-only inspections run synchronously; every device write, project execution, emulator mutation, and signing action uses exact approval and an explicit target.

**Tech Stack:** TypeScript, Zod, Android SDK command-line tools, ADB, Emulator, AVD Manager, Gradle/Android Gradle Plugin, `apksigner`, DPAPI-backed local credential references.

---

**Prerequisite:** Complete `2026-07-30-development-environment-broker.md` and verify `tools/list` contains exactly 27 tools.

## Task 1: Android contracts and command builders

**Files:**
- Create: `src/development/android/types.ts`
- Create: `src/development/android/toolchain.ts`
- Create: `src/development/android/commands.ts`
- Create: `test/android-command-builders.test.mjs`

- [ ] **Step 1: Write failing command-builder tests**

Assert every supported action produces an executable reference plus an argument array, never a shell string. Cover whitespace, Unicode paths, malicious package IDs, malicious device serials, Gradle task injection, shell metacharacters, and missing trusted components.

```js
assert.deepEqual(buildAdbCommand(toolchain, { action: "start_app", serial: "emulator-5554", packageId: "com.example.app", activity: ".MainActivity" }), {
  executable: toolchain.adb.path,
  args: ["-s", "emulator-5554", "shell", "am", "start", "-n", "com.example.app/.MainActivity"],
});
assert.throws(() => buildAdbCommand(toolchain, { action: "start_app", serial: "x & whoami", packageId: "com.example.app", activity: ".MainActivity" }), /serial/i);
```

- [ ] **Step 2: Run test and verify failure**

Run: `npm run build; node --test test/android-command-builders.test.mjs`

Expected: FAIL because Android modules do not exist.

- [ ] **Step 3: Define strict identifiers**

Validate device serials with `/^[A-Za-z0-9._:-]{1,128}$/`, package IDs as dot-separated Java identifiers, activities as package IDs or a leading-dot class, AVD names with `/^[A-Za-z0-9._-]{1,64}$/`, and port values from 1 through 65535. Build variants, test kinds, diagnostic operations, and artifact formats are enums.

- [ ] **Step 4: Resolve the trusted Android toolchain**

Require explicit trusted records for Java 17, Android SDK root, ADB, emulator, SDK Manager, AVD Manager, build-tools `apksigner`, and the approved Gradle distribution. Return `ENVIRONMENT_MISSING` or `TOOLCHAIN_UNTRUSTED` with component IDs only; do not return installation paths.

- [ ] **Step 5: Implement pure command builders**

Builders return `{ executable, args, stdin? }` for fixed operations. They must not read environment variables or the filesystem. Reject extra fields with strict Zod schemas. Use `shell: false` in every eventual execution path.

- [ ] **Step 6: Run tests and commit**

```powershell
npm run build
node --test test/android-command-builders.test.mjs
git add src/development/android test/android-command-builders.test.mjs
git commit -m "feat: define safe Android commands"
```

## Task 2: Versioned Android project provider

**Files:**
- Create: `src/development/projects/types.ts`
- Create: `src/development/projects/registry.ts`
- Create: `src/development/android/projectProvider.ts`
- Create: `templates/android/kotlin-basic/settings.gradle.kts.tpl`
- Create: `templates/android/kotlin-basic/build.gradle.kts.tpl`
- Create: `templates/android/kotlin-basic/app/build.gradle.kts.tpl`
- Create: `templates/android/kotlin-basic/app/src/main/AndroidManifest.xml.tpl`
- Create: `templates/android/kotlin-basic/app/src/main/java/__PACKAGE_PATH__/MainActivity.kt.tpl`
- Create: `templates/android/compose-basic/settings.gradle.kts.tpl`
- Create: `templates/android/compose-basic/build.gradle.kts.tpl`
- Create: `templates/android/compose-basic/app/build.gradle.kts.tpl`
- Create: `templates/android/compose-basic/app/src/main/AndroidManifest.xml.tpl`
- Create: `templates/android/compose-basic/app/src/main/java/__PACKAGE_PATH__/MainActivity.kt.tpl`
- Create: `test/android-project-provider.test.mjs`

- [ ] **Step 1: Write failing provider tests**

Assert project inspection, template enumeration, path and package validation, refusal to overwrite nonempty destinations, no unresolved template tokens, exact file inventory, atomic rollback on failure, Gradle-wrapper checksum configuration, and registration under provider key `android`.

- [ ] **Step 2: Run test and verify failure**

Run: `npm run build; node --test test/android-project-provider.test.mjs`

Expected: FAIL because provider and templates do not exist.

- [ ] **Step 3: Define the provider interface**

```ts
export interface DevelopmentProjectProvider {
  readonly ecosystem: "android" | "dotnet" | "native" | "electron";
  inspect(root: string): Promise<ProjectInspection>;
  templates(): ProjectTemplateSummary[];
  create(request: ProjectCreateRequest, stagingRoot: string): Promise<ProjectCreateResult>;
}
```

The registry rejects duplicate ecosystem keys and is not exposed as a generic plug-in loader.

- [ ] **Step 4: Add controlled templates**

Pin template versions to the approved catalog profile. Templates contain no remote scripts, credentials, local paths, wrapper JAR, or binary files. Replace only declared tokens: project name, package ID, package path, compile SDK, min SDK, target SDK, AGP, Kotlin, Gradle, and Compose versions.

- [ ] **Step 5: Generate the Gradle Wrapper safely**

After staging text files, run the verified installed Gradle distribution with `wrapper --gradle-version <catalog-version> --distribution-type bin`. Write `distributionSha256Sum` from the trusted catalog into `gradle-wrapper.properties`, then atomically rename staging to the authorized destination.

- [ ] **Step 6: Run tests and commit**

```powershell
npm run build
node --test test/android-project-provider.test.mjs
git add src/development/projects src/development/android/projectProvider.ts templates/android test/android-project-provider.test.mjs
git commit -m "feat: add controlled Android templates"
```

## Task 3: Gradle build, test, and artifact collection

**Files:**
- Create: `src/development/android/gradle.ts`
- Create: `src/development/android/artifacts.ts`
- Create: `test/fixtures/fake-gradle.mjs`
- Create: `test/android-gradle.test.mjs`

- [ ] **Step 1: Write failing Gradle tests**

Cover wrapper real-path confinement, allowed wrapper URL and checksum, recognized modules/variants, clean/build/unit/instrumented test actions, fixed flags, timeout, cancellation, script-digest approval input, and artifact collection that refuses symlinks or files outside `build/outputs` and test-report roots.

- [ ] **Step 2: Run test and verify failure**

Run: `npm run build; node --test test/android-gradle.test.mjs`

Expected: FAIL because Gradle adapter does not exist.

- [ ] **Step 3: Inspect and digest executable project inputs**

Hash `settings.gradle*`, root/module `build.gradle*`, `gradle.properties` after sensitive-property redaction, version catalogs, wrapper properties, wrapper JAR, and requested module. Bind the digest to the approval subject. Reject wrapper distributions outside `services.gradle.org` or without the catalog checksum.

- [ ] **Step 4: Map actions to fixed Gradle tasks**

Use `gradlew.bat --no-daemon --console=plain --stacktrace` plus exactly one adapter-generated task such as `:<module>:assembleDebug`, `:<module>:bundleRelease`, `:<module>:testDebugUnitTest`, or `:<module>:connectedDebugAndroidTest`. A caller never supplies a Gradle task or flag.

- [ ] **Step 5: Collect artifacts**

After success, scan only expected output directories for `.apk`, `.aab`, JUnit XML, and HTML report entry points. Canonicalize, size, and hash packages before passing the manifest to the task worker.

- [ ] **Step 6: Run tests and commit**

```powershell
npm run build
node --test test/android-gradle.test.mjs
git add src/development/android/gradle.ts src/development/android/artifacts.ts test/fixtures/fake-gradle.mjs test/android-gradle.test.mjs
git commit -m "feat: build and test Android projects"
```

## Task 4: ADB devices, application lifecycle, diagnostics, transfer, and forwarding

**Files:**
- Create: `src/development/android/adb.ts`
- Create: `src/development/android/adbDiagnostics.ts`
- Create: `test/fixtures/fake-adb.mjs`
- Create: `test/android-adb.test.mjs`
- Create: `test/android-adb-security.test.mjs`

- [ ] **Step 1: Write failing ADB tests**

Cover device parsing, offline/unauthorized states, mandatory serial, install/uninstall/start/stop/clear, Logcat, screenshot, push/pull, forward/reverse, package validation, transfer-root validation, output limits, and error mapping.

- [ ] **Step 2: Write failing ADB security tests**

Attempt pipes, redirection, command joining, `su`, `run-as`, `setprop`, `settings put`, `pm install`, bootloader/recovery, arbitrary `sh`, host substitution, path traversal, and a second device with no explicit serial. Every case must fail before process spawn.

- [ ] **Step 3: Run tests and verify failure**

Run: `npm run build; node --test test/android-adb.test.mjs test/android-adb-security.test.mjs`

Expected: FAIL because ADB modules do not exist.

- [ ] **Step 4: Implement read-only device inspection**

Parse `adb devices -l` without trusting extra tokens. Return serial, state, model, product, transport ID, and emulator boolean. Do not return USB topology or user filesystem paths.

- [ ] **Step 5: Implement structured lifecycle and transfer actions**

Generate fixed argument arrays for install, uninstall, `am start`, `am force-stop`, `pm clear`, Logcat, `exec-out screencap -p`, push/pull, and forward/reverse. Host file paths must pass directory authorization; device paths must be absolute, normalized POSIX paths and reject `/data`, `/system`, `/vendor`, `/proc`, `/sys`, and `/dev` except adapter-owned application-accessible targets.

- [ ] **Step 6: Implement diagnostics without arbitrary shell**

Expose only enums for `getprop_subset`, `dumpsys_package`, `dumpsys_activity`, `pm_path`, `df_data`, and `pidof_package`. Each enum maps to a fixed token array. Do not expose a raw token or command field in the MCP schema.

- [ ] **Step 7: Run tests and commit**

```powershell
npm run build
node --test test/android-adb.test.mjs test/android-adb-security.test.mjs
git add src/development/android/adb.ts src/development/android/adbDiagnostics.ts test/fixtures/fake-adb.mjs test/android-adb.test.mjs test/android-adb-security.test.mjs
git commit -m "feat: add controlled Android device operations"
```

## Task 5: Emulator and AVD lifecycle

**Files:**
- Create: `src/development/android/emulator.ts`
- Create: `test/fixtures/fake-emulator.mjs`
- Create: `test/android-emulator.test.mjs`

- [ ] **Step 1: Write failing emulator tests**

Cover AVD listing, exact catalog image IDs, AVD name validation, bounded stdin for `avdmanager`, creation rollback, detached start, boot readiness polling through explicit serial, timeout, stop, duplicate start, and no arbitrary emulator flags.

- [ ] **Step 2: Run test and verify failure**

Run: `npm run build; node --test test/android-emulator.test.mjs`

Expected: FAIL because emulator module does not exist.

- [ ] **Step 3: Implement AVD creation**

Use `avdmanager create avd --name <name> --package <catalog-image> --device <catalog-device> --force` with internal stdin `no\n`. Reject an image not installed and trusted in the current snapshot. On failure remove only the newly staged AVD paths proven to be under the standard AVD root.

- [ ] **Step 4: Implement start and readiness**

Use a finite adapter-owned emulator flag set. After launch, poll `adb -s <serial> shell getprop sys.boot_completed` and `dev.bootcomplete` until both indicate readiness or timeout. Return the explicit serial and task ID; do not treat process creation as boot success.

- [ ] **Step 5: Run tests and commit**

```powershell
npm run build
node --test test/android-emulator.test.mjs
git add src/development/android/emulator.ts test/fixtures/fake-emulator.mjs test/android-emulator.test.mjs
git commit -m "feat: manage Android emulators"
```

## Task 6: DPAPI credential references and Android signing

**Files:**
- Create: `src/development/credentials/types.ts`
- Create: `src/development/credentials/dpapiStore.ts`
- Create: `src/development/android/signing.ts`
- Create: `scripts/manage-development-credentials.ps1`
- Create: `manage-development-credentials.bat`
- Create: `test/development-credentials.test.mjs`
- Create: `test/android-signing.test.mjs`

- [ ] **Step 1: Write failing credential and signing tests**

Assert opaque credential IDs, owner binding, local-only create/list/remove, DPAPI helper argument arrays, no secret in metadata/logs/process arguments, `apksigner` environment references, certificate summary, signed-output staging, and cleanup on failure.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm run build; node --test test/development-credentials.test.mjs test/android-signing.test.mjs`

Expected: FAIL because credential and signing modules do not exist.

- [ ] **Step 3: Implement local credential management**

The PowerShell script prompts with `Read-Host -AsSecureString`, encrypts using DPAPI CurrentUser, stores blobs under `APPROVAL_DATA_DIR\credentials` with owner-only ACLs, and lists only ID, kind, alias, fingerprint, and timestamps. It never accepts a plaintext secret command-line argument. Extend the task worker with a closed credential-resolver interface that converts `secretEnvRefs` to process environment values only in worker memory and registers them with the streaming redactor before process spawn.

- [ ] **Step 4: Implement signing**

Resolve keystore path through directory authorization and credential ID through the local store. Persist only `secretEnvRefs` for `FEISHU_MCP_KS_PASS` and `FEISHU_MCP_KEY_PASS`; the worker resolves and redacts them in memory. Invoke `apksigner` with `--ks-pass env:FEISHU_MCP_KS_PASS` and `--key-pass env:FEISHU_MCP_KEY_PASS`. Sign to a staging path, verify with `apksigner verify --verbose --print-certs`, then atomically move to the authorized output.

- [ ] **Step 5: Run tests and commit**

```powershell
npm run build
node --test test/development-credentials.test.mjs test/android-signing.test.mjs
git add src/development/credentials src/development/android/signing.ts scripts/manage-development-credentials.ps1 manage-development-credentials.bat test/development-credentials.test.mjs test/android-signing.test.mjs
git commit -m "feat: sign Android artifacts with local credentials"
```

## Task 7: `android_development` tool and Phase 3 gate

**Files:**
- Create: `src/tools/androidDevelopment.ts`
- Create: `test/android-development-tool.test.mjs`
- Create: `test/android-development-e2e.test.mjs`
- Modify: `src/index.ts`
- Modify: `src/tools/results.ts`
- Modify: `test/tools-list.test.mjs`

- [x] **Step 1: Write failing tool and HTTP tests**

Assert all action schemas are strict, owner-only, exact device selection, directory approval, operation approval and retry, synchronous inspection, background task IDs, task logs/cancel, artifact summaries, changed-project digest reapproval, and denial by a legacy client that cannot display approval.

- [x] **Step 2: Run tests and verify failure**

Run: `npm run build; node --test test/android-development-tool.test.mjs test/android-development-e2e.test.mjs`

Expected: FAIL because `android_development` is not registered.

- [x] **Step 3: Implement action dispatch**

Register one strict `android_development` tool. Inspect/list actions run synchronously behind the normal tool concurrency gate. Build and test use standard exact approval so unchanged safe operations may be remembered. Emulator creation, device install/uninstall/clear, transfer, forwarding, restricted diagnostics, and signing call `requestApproval` with `decisionMode: "single_use"`. Approved long actions enqueue internal launch specs and immediately return `{ ok: true, taskId, state: "queued" }`.

- [x] **Step 4: Register the Android provider and tool**

Register `AndroidProjectProvider` in the internal project registry and append `android_development` after environment tools in `TOOL_NAMES`. Update the inventory test to exactly 28 tools.

- [x] **Step 5: Run the Phase 3 gate**

```powershell
npm run typecheck
npm test
dotnet test broker/FeishuMcp.AdminBroker.Tests/FeishuMcp.AdminBroker.Tests.csproj
python test/e2e_test.py
npm audit --omit=dev
git diff --check
```

Expected: every command exits 0 and `tools/list` contains exactly 28 unique tools.

- [x] **Step 6: Commit**

```powershell
git add src/tools/androidDevelopment.ts src/index.ts src/tools/results.ts test/android-development-tool.test.mjs test/android-development-e2e.test.mjs test/tools-list.test.mjs
git commit -m "feat: expose Android development adapter"
```
