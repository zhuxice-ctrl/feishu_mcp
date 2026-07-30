# Development Environment and Administrator Broker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect trusted Android and Windows toolchains, generate immutable environment-change plans, and apply approved plans through ordinary workers or a local allowlisted administrator broker.

**Architecture:** A versioned repository catalog defines accepted component IDs, discovery rules, publishers, sources, and install operations. Node creates signed short-lived plans bound to an environment snapshot; a C# Windows service independently validates the plan and reconstructs privileged commands from the same embedded catalog, exposing no generic process or download primitive.

**Tech Stack:** TypeScript, Zod, Node child processes with `shell: false`, Windows registry and `vswhere`, C# .NET 8 Windows service, named pipes, HMAC-SHA256, PowerShell installation scripts.

---

**Prerequisite:** Complete `2026-07-30-development-task-core.md` and verify `tools/list` contains exactly 24 tools.

## Task 1: Versioned trusted-component catalog

**Files:**
- Create: `config/development-package-catalog.json`
- Create: `src/development/environment/types.ts`
- Create: `src/development/environment/catalog.ts`
- Create: `test/development-environment-catalog.test.mjs`

- [ ] **Step 1: Write failing catalog tests**

Assert catalog version, unique component IDs, HTTPS fixed sources, exact `winget` IDs, exact Visual Studio workload IDs, supported target groups, and rejection of URL/executable/argument fields not present in the schema.

```js
const catalog = loadDevelopmentCatalog(catalogPath);
assert.equal(catalog.version, 1);
assert.equal(new Set(catalog.components.map((item) => item.id)).size, catalog.components.length);
assert(catalog.components.some((item) => item.id === "microsoft.dotnet.sdk.8"));
assert(catalog.components.some((item) => item.id === "google.android.platform-tools"));
```

- [ ] **Step 2: Run the test and verify failure**

Run: `npm run build; node --test test/development-environment-catalog.test.mjs`

Expected: FAIL because the catalog loader does not exist.

- [ ] **Step 3: Define strict catalog types**

Use a discriminated union whose install operations are limited to these forms:

```ts
export type CatalogInstallOperation =
  | { kind: "winget"; packageId: string; source: "winget" }
  | { kind: "vs_workload"; workloadId: string }
  | { kind: "android_sdk"; packageId: string }
  | { kind: "verified_archive"; artifactId: string; url: string; sha256: string };
export interface CatalogComponent {
  id: string;
  target: "android" | "dotnet" | "native" | "electron";
  displayName: string;
  versions: string[];
  discovery: { kind: "registry" | "vswhere" | "fixed_candidates" | "sdkmanager"; values: string[] };
  publishers: string[];
  install: CatalogInstallOperation;
}
```

Reject unknown keys when parsing. A `verified_archive` URL exists only in the reviewed repository catalog, must be HTTPS on an allowlisted publisher host, and is never copied from an MCP argument. Do not permit a caller-controlled URL, executable, free-form switch, script, or registry write.

- [ ] **Step 4: Populate the first catalog**

Include exact entries for Microsoft OpenJDK 17, a verified Gradle distribution, Android command-line tools/platform-tools/emulator/current supported platform/build-tools/system-image profiles, .NET SDK 8, Visual Studio Build Tools 2022 with managed desktop/native/WinUI workloads, Windows 11 SDK, CMake, Ninja, Node.js LTS, and Git. Keep version profiles current but finite; do not include every historical SDK.

- [ ] **Step 5: Run tests and commit**

```powershell
npm run build
node --test test/development-environment-catalog.test.mjs
git add config/development-package-catalog.json src/development/environment/types.ts src/development/environment/catalog.ts test/development-environment-catalog.test.mjs
git commit -m "feat: define trusted development catalog"
```

Expected: test exits 0.

## Task 2: Trusted executable discovery and environment snapshots

**Files:**
- Create: `src/development/environment/windowsSignature.ts`
- Create: `src/development/environment/trustedExecutable.ts`
- Create: `src/development/environment/inspect.ts`
- Create: `test/fixtures/fake-toolchain.mjs`
- Create: `test/development-trusted-executable.test.mjs`
- Create: `test/development-environment-inspect.test.mjs`

- [ ] **Step 1: Write failing discovery tests**

Create fake candidates under temporary roots. Assert canonicalization, version parsing, publisher/checksum verifier injection, cache invalidation after replacement, junction escape denial, ambiguous candidate reporting, and a deterministic environment digest.

```js
const resolver = new TrustedExecutableResolver({ verify: fakeVerifier, candidates: [candidate] });
const first = await resolver.resolve("dotnet");
assert.equal(first.trusted, true);
await replaceFixture(candidate);
const second = await resolver.resolve("dotnet");
assert.notEqual(second.fileIdentity, first.fileIdentity);
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npm run build; node --test test/development-trusted-executable.test.mjs test/development-environment-inspect.test.mjs`

Expected: FAIL because discovery modules do not exist.

- [ ] **Step 3: Implement Windows signature verification without shell strings**

Invoke a fixed `powershell.exe` path with an argument array and a repository-owned script body that calls `Get-AuthenticodeSignature -LiteralPath`. Parse compact JSON containing status, signer subject, and thumbprint. A failed, unsigned, or unexpected publisher is untrusted. Tests inject a verifier and never depend on a real signature.

- [ ] **Step 4: Implement canonical discovery**

Resolve registry entries with fixed registry keys, Visual Studio through a verified `vswhere.exe`, Android through configured/standard SDK roots, and ordinary tools through finite candidates and `where.exe`. Record canonical path, real path, size, modification time, version, publisher, discovery source, and SHA-256 when required.

- [ ] **Step 5: Build deterministic snapshots**

Sort targets and components by ID, exclude absolute paths from the public response, and hash the full private canonical snapshot. Public status contains component ID, display name, state `ready|missing|untrusted|incompatible`, version, and remediation; it does not contain environment variables or user paths.

- [ ] **Step 6: Run tests and commit**

```powershell
npm run build
node --test test/development-trusted-executable.test.mjs test/development-environment-inspect.test.mjs
git add src/development/environment test/fixtures/fake-toolchain.mjs test/development-trusted-executable.test.mjs test/development-environment-inspect.test.mjs
git commit -m "feat: inspect trusted development toolchains"
```

Expected: all focused tests pass.

## Task 3: Immutable signed environment plans

**Files:**
- Create: `src/development/environment/planStore.ts`
- Create: `src/development/environment/planner.ts`
- Create: `test/development-environment-plan.test.mjs`

- [ ] **Step 1: Write failing plan tests**

Assert exact component selection, dependency ordering, size summaries, 30-minute expiry, owner binding, environment-digest binding, catalog binding, HMAC validation, atomic single-use claim, and rejection after any component/version/source mutation.

```js
const plan = planner.create({ ownerKey, targets: ["android"], requested: ["google.android.platform-tools"], snapshot });
assert.equal(plan.version, 1);
assert.equal(plan.environmentDigest, snapshot.digest);
assert.equal(store.claim(plan.id, ownerKey, snapshot.digest).status, "claimed");
assert.equal(store.claim(plan.id, ownerKey, snapshot.digest).status, "already_used");
```

- [ ] **Step 2: Run the test and verify failure**

Run: `npm run build; node --test test/development-environment-plan.test.mjs`

Expected: FAIL because planner and store do not exist.

- [ ] **Step 3: Define and sign the plan**

Persist a versioned body containing plan ID, owner key, catalog digest, environment digest, ordered operation descriptors, created/expiry timestamps, download/disk estimates, privilege/reboot flags, and status. Sign canonical JSON with HMAC-SHA256 using a key derived from `APPROVAL_STATE_SECRET` and the label `environment-plan-v1`.

- [ ] **Step 4: Implement atomic claim and stale checks**

Before claim, rerun inspection and compare environment and catalog digests. Use expected-status `planned` in the atomic update. On mismatch return `ENVIRONMENT_PLAN_STALE`; on expiry return `APPROVAL_EXPIRED`; on a second claim return `ENVIRONMENT_PLAN_ALREADY_USED`.

- [ ] **Step 5: Run tests and commit**

```powershell
npm run build
node --test test/development-environment-plan.test.mjs
git add src/development/environment/planStore.ts src/development/environment/planner.ts test/development-environment-plan.test.mjs
git commit -m "feat: create immutable environment plans"
```

## Task 4: C# allowlisted administrator broker

**Files:**
- Create: `broker/FeishuMcp.AdminBroker/FeishuMcp.AdminBroker.csproj`
- Create: `broker/FeishuMcp.AdminBroker/Program.cs`
- Create: `broker/FeishuMcp.AdminBroker/BrokerService.cs`
- Create: `broker/FeishuMcp.AdminBroker/BrokerProtocol.cs`
- Create: `broker/FeishuMcp.AdminBroker/BrokerCatalog.cs`
- Create: `broker/FeishuMcp.AdminBroker/OperationExecutor.cs`
- Create: `broker/FeishuMcp.AdminBroker.Tests/FeishuMcp.AdminBroker.Tests.csproj`
- Create: `broker/FeishuMcp.AdminBroker.Tests/BrokerProtocolTests.cs`
- Create: `broker/FeishuMcp.AdminBroker.Tests/BrokerCatalogTests.cs`
- Create: `broker/Directory.Build.props`
- Create: `scripts/build-admin-broker.ps1`
- Create: `test/admin-broker-build-script.test.mjs`

- [ ] **Step 1: Create failing broker protocol tests**

Use xUnit to assert valid HMAC acceptance and rejection of wrong owner SID, timestamp older than 120 seconds, reused nonce, already-applied plan ID, protocol mismatch, catalog mismatch, unknown operation ID, extra JSON properties, an executable path, a URL, and free-form arguments.

```csharp
var result = validator.Validate(validRequest with { OperationId = "run_command" });
Assert.Equal(BrokerError.UnsupportedOperation, result.Error);
Assert.False(result.Accepted);
```

- [ ] **Step 2: Run tests and verify failure**

Run: `dotnet test broker/FeishuMcp.AdminBroker.Tests/FeishuMcp.AdminBroker.Tests.csproj`

Expected: FAIL because broker implementation does not exist.

- [ ] **Step 3: Define the strict protocol**

Use one length-prefixed UTF-8 JSON request capped at 64 KiB and one length-prefixed response. Request fields are exactly protocol version, request ID, plan ID, operation ID, component ID, version, catalog digest, owner SID, timestamp, nonce, and HMAC. Deserialize with `UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow`.

- [ ] **Step 4: Embed and validate the catalog**

Embed `config/development-package-catalog.json` at build time. Map each operation ID to a fixed executable discovery method and a fixed argument builder. `OperationExecutor` receives typed catalog records only and starts processes with `UseShellExecute = false`; no public method accepts raw executable, URL, shell, registry path, or argument list.

- [ ] **Step 5: Implement local pipe ACL and replay protection**

Create a named pipe with `PipeSecurity` granting the configured owner SID and LocalSystem only. Read the shared 32-byte key from an ACL-protected local file created during installation. Validate HMAC with `CryptographicOperations.FixedTimeEquals`. Persist claimed plan IDs atomically before execution and keep a bounded nonce cache.

- [ ] **Step 6: Implement service lifecycle**

Use `Microsoft.Extensions.Hosting.WindowsServices`. Serialize operations with `SemaphoreSlim(1,1)`. Report only stage, exit code, and redacted message. Stop on catalog/signature validation failure. Never self-update through the broker protocol.

- [ ] **Step 7: Run broker tests and commit**

Add a deterministic build script that runs `dotnet publish` for `win-x64` and `win-arm64` as self-contained single-file artifacts, writes them under ignored `artifacts/admin-broker/<runtime>/`, and produces an adjacent JSON manifest containing protocol version, catalog digest, runtime, filename, byte size, and SHA-256. The script accepts only the two runtime enums and a repository-relative output root.

```powershell
dotnet test broker/FeishuMcp.AdminBroker.Tests/FeishuMcp.AdminBroker.Tests.csproj
node --test test/admin-broker-build-script.test.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-admin-broker.ps1 -Runtime win-x64
git add broker config/development-package-catalog.json scripts/build-admin-broker.ps1 test/admin-broker-build-script.test.mjs
git commit -m "feat: add allowlisted administrator broker"
```

Expected: all broker tests pass and the manifest SHA-256 matches the published artifact.

## Task 5: Broker client and one-time installation scripts

**Files:**
- Create: `src/development/environment/brokerClient.ts`
- Create: `src/development/environment/applyPlan.ts`
- Create: `scripts/install-admin-broker.ps1`
- Create: `scripts/uninstall-admin-broker.ps1`
- Create: `install-feishu-mcp-admin-broker.bat`
- Create: `uninstall-feishu-mcp-admin-broker.bat`
- Create: `test/development-broker-client.test.mjs`
- Create: `test/admin-broker-scripts.test.mjs`
- Modify: `.gitignore`

- [x] **Step 1: Write failing client and script tests**

Use a temporary mock named-pipe server to assert length caps, HMAC, timeout, protocol errors, disconnects, and redaction. Parse scripts as text to assert fixed service name, literal paths, SID ACL setup, no embedded secret, no remote script execution, and no use of `Invoke-Expression`.

- [x] **Step 2: Run tests and verify failure**

Run: `npm run build; node --test test/development-broker-client.test.mjs test/admin-broker-scripts.test.mjs`

Expected: FAIL because files do not exist.

- [x] **Step 3: Implement the broker client**

Connect only to `\\.\pipe\feishu-mcp-admin-<sid-hash>`, cap request and response at 64 KiB, use a 30-second connection timeout, sign canonical fields, and map broker errors to structured MCP errors. Never log the pipe secret, HMAC, nonce, or owner SID.

- [x] **Step 4: Implement plan application**

Claim the plan only after approval. Apply ordinary `android_sdk` steps through validated task launch specs and privileged steps through a repository-owned Node worker that calls `brokerClient`. Stop on first failed step, record the failed component, and do not retry automatically.

- [x] **Step 5: Implement install and uninstall scripts**

The installer verifies the broker artifact SHA-256 against the adjacent release manifest, creates `%ProgramData%\FeishuMcp\Broker`, generates a random key, applies ACLs for SYSTEM and the current owner SID, installs the fixed Windows service, and starts it. The uninstaller stops/removes only that exact service and deletes only the verified broker directory after path and service-name checks. Both scripts require elevation and use `-LiteralPath`.

- [x] **Step 6: Ignore local broker material**

Ignore `broker/**/bin/`, `broker/**/obj/`, `artifacts/admin-broker/`, `*.broker-key`, `broker-registration.local.json`, `*.pfx`, `*.p12`, `*.keystore`, and `key.properties`; do not ignore broker source or test projects.

- [x] **Step 7: Run tests and commit**

```powershell
npm run build
node --test test/development-broker-client.test.mjs test/admin-broker-scripts.test.mjs
git add src/development/environment scripts install-feishu-mcp-admin-broker.bat uninstall-feishu-mcp-admin-broker.bat .gitignore test/development-broker-client.test.mjs test/admin-broker-scripts.test.mjs
git commit -m "feat: connect and install administrator broker"
```

## Task 6: Environment MCP tools and Phase 2 gate

**Files:**
- Create: `src/tools/developmentEnvironment.ts`
- Create: `test/development-environment-tools.test.mjs`
- Modify: `src/index.ts`
- Modify: `src/tools/results.ts`
- Modify: `test/tools-list.test.mjs`
- Modify: `test/health-concurrency.test.mjs`

- [ ] **Step 1: Write failing tool tests**

Assert owner-only inspection, structured public status without paths, plan-only behavior, approval before apply, changed-snapshot rejection, single-use plan rejection, broker-unavailable mapping, and no caller URL/executable/argument fields accepted by Zod.

- [ ] **Step 2: Run test and verify failure**

Run: `npm run build; node --test test/development-environment-tools.test.mjs`

Expected: FAIL because environment tools are not registered.

- [ ] **Step 3: Implement the three tool registrations**

Register:

```ts
"inspect_development_environment"
"plan_environment_changes"
"apply_environment_plan"
```

Inspection accepts a nonempty unique target array. Planning accepts targets, exact catalog component IDs, and intent `install|update|repair`. Apply accepts only `{ planId: z.string().uuid() }`, calls `requestApproval` with `decisionMode: "single_use"` while displaying the redacted component/version/size/privilege/reboot summary, then atomically claims the plan, enqueues application, and returns a task ID.

- [ ] **Step 4: Update inventory and health**

Append the three names after the task tools, for exactly 27 tools. Health adds only catalog version, broker state `ready|missing|incompatible`, and aggregate environment-plan/task counts; it exposes no path, SID, component command, plan ID, or version fingerprint.

- [ ] **Step 5: Run the Phase 2 gate**

```powershell
npm run typecheck
npm test
dotnet test broker/FeishuMcp.AdminBroker.Tests/FeishuMcp.AdminBroker.Tests.csproj
python test/e2e_test.py
npm audit --omit=dev
git diff --check
```

Expected: every command exits 0 and `tools/list` contains exactly 27 unique tools.

- [ ] **Step 6: Commit**

```powershell
git add src/tools/developmentEnvironment.ts src/index.ts src/tools/results.ts test/development-environment-tools.test.mjs test/tools-list.test.mjs test/health-concurrency.test.mjs
git commit -m "feat: expose trusted environment provisioning"
```
