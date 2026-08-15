# 通用 Android 自动化验证工作流 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reusable, contract-first Android verification engine where each application is a Profile or constrained plugin, while SSH, ADB, state, topology, evidence, and MCP integration remain application-independent.

**Architecture:** A thin MCP adapter sends a versioned `RunRequest` to a topology-based coordinator. The coordinator uses `TunnelAdapter`, `AndroidDeviceAdapter`, `ProfileRegistry`, `StateStore`, and `EvidenceWriter` contracts. ZeroXCore is the first Profile only; no core module may branch on its package name, UI text, API path, or directory.

**Tech Stack:** TypeScript/Node.js, existing MCP tool registry, Node child-process abstraction, Windows OpenSSH, ADB, JSON checkpoints under `APPROVAL_DATA_DIR`, Node test runner.

---

## File map

- Create `src/android-workflow/contracts.ts`: versioned request/result, adapter, node, graph, Profile, plugin, error, and evidence interfaces.
- Create `src/android-workflow/redaction.ts`: shared credential/path/response redaction.
- Create `src/android-workflow/stateStore.ts`: atomic checkpoints, valid topology transitions, resume and terminal cleanup.
- Create `src/android-workflow/topology.ts`: graph validation, node execution, retry/cancel rules, and transition events.
- Create `src/android-workflow/tunnelAdapter.ts`: OpenSSH alias adapter with fixed staging loopback constraints.
- Create `src/android-workflow/androidDeviceAdapter.ts`: fixed `emulator-5554` ADB adapter.
- Create `src/android-workflow/profileRegistry.ts`: Profile/plugin registration, version validation, capability allowlist.
- Create `src/android-workflow/profiles/zeroxcore.ts`: first application Profile; no core module imports this file.
- Create `src/android-workflow/coordinator.ts`: profile-driven orchestration and evidence assembly.
- Create `src/tools/stagingAndroidVerify.ts`: MCP schema, owner authorization, queue/cancellation, coordinator call.
- Modify `src/index.ts`: register the tool and update tool names/count.
- Create `test/android-workflow-contracts.test.mjs`, `test/android-workflow-topology.test.mjs`, `test/android-workflow-state-store.test.mjs`, `test/android-workflow-tunnel.test.mjs`, `test/android-workflow-device.test.mjs`, `test/android-workflow-profiles.test.mjs`, and `test/android-workflow-coordinator.test.mjs`.
- Modify `test/tools-list.test.mjs` and `test/complete-tools-e2e.test.mjs` for registration and count.

### Task 1: Define versioned contracts and capability boundaries

**Files:** create `src/android-workflow/contracts.ts`; test `test/android-workflow-contracts.test.mjs`.

- [ ] **Step 1: Write failing contract tests.**

```js
test("accepts a profile request without app-specific fields in the core request", () => {
  const request = parseRunRequest({ profileId: "zeroxcore", workdir: "F:\\zeroxcore", apkPath: "app-debug.apk", sshHost: "staging" });
  assert.equal(request.contractVersion, 1);
  assert.equal(request.deviceId, "emulator-5554");
});

test("rejects undeclared profile capabilities and arbitrary node actions", () => {
  assert.throws(() => validateNode({ type: "shell", command: "whoami" }), /undeclared action/);
});
```

- [ ] **Step 2: Run and verify failure.**

Run: `npm run build; node --test test/android-workflow-contracts.test.mjs`

Expected: FAIL because the contract module is absent.

- [ ] **Step 3: Implement contracts.**

Define `RunRequest`, `RunResult`, `WorkflowNode`, `WorkflowGraph`, `TunnelAdapter`, `AndroidDeviceAdapter`, `AndroidAppProfile`, `ProfilePlugin`, `WorkflowContext`, `StagingError`, and `EvidenceRecord`. Keep app-specific values inside Profile types and expose only capability-scoped context methods to plugins.

- [ ] **Step 4: Run and commit.**

Run: `npm run build; node --test test/android-workflow-contracts.test.mjs`

Expected: PASS.

Commit: `git add src/android-workflow/contracts.ts test/android-workflow-contracts.test.mjs && git commit -m "feat: define reusable Android workflow contracts"`

### Task 2: Add redaction and checkpoint storage

**Files:** create `src/android-workflow/redaction.ts`, `src/android-workflow/stateStore.ts`; tests `test/android-workflow-state-store.test.mjs`.

- [ ] **Step 1: Test secrets, paths, atomic saves, resume and terminal cleanup.**

```js
test("redacts bearer, cookie, PIN, and Windows user values", () => {
  const safe = redact("Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456 PIN=12345678 C:\\Users\\Lenovo\\secret");
  assert.doesNotMatch(safe, /abcdefghijklmnopqrstuvwxyz123456|12345678|Lenovo/);
});

test("resumes the latest valid checkpoint and removes only terminal state", async () => {
  const store = new StateStore(tempDir);
  await store.save({ runId: "r1", state: "tunnel_connected", profileVersion: 1 });
  assert.equal((await store.load("r1")).state, "tunnel_connected");
  await store.finish("r1");
  assert.equal(await store.load("r1"), null);
});
```

- [ ] **Step 2: Run and verify failure.**

Run: `npm run build; node --test test/android-workflow-state-store.test.mjs`

Expected: FAIL because modules are absent.

- [ ] **Step 3: Implement atomic state and redaction.**

Write temporary JSON beside the run file and rename atomically. Validate all graph transitions before saving. Store only redacted metadata; retain failed runs until evidence is complete and delete terminal checkpoints after successful cleanup.

- [ ] **Step 4: Run and commit.**

Run: `npm run build; node --test test/android-workflow-state-store.test.mjs`

Expected: PASS.

Commit: `git add src/android-workflow/redaction.ts src/android-workflow/stateStore.ts test/android-workflow-state-store.test.mjs && git commit -m "feat: add redacted Android workflow checkpoints"`

### Task 3: Implement topology coordinator

**Files:** create `src/android-workflow/topology.ts`; test `test/android-workflow-topology.test.mjs`.

- [ ] **Step 1: Test legal/illegal transitions, retries, cancellation and expected interruption.**

```js
test("allows the declared offline branch but rejects skipping app_ready", () => {
  assert.doesNotThrow(() => graph.transition("binding_verified", "tunnel_interrupted"));
  assert.throws(() => graph.transition("created", "recovery_passed"), /invalid transition/);
});
```

- [ ] **Step 2: Run and verify failure.**

Run: `npm run build; node --test test/android-workflow-topology.test.mjs`

Expected: FAIL because the topology module is absent.

- [ ] **Step 3: Implement graph validation and node execution.**

Nodes receive `WorkflowContext`, return typed outputs, emit `StateEvent`, honor `AbortSignal`, and retry only when the node contract marks the error retryable. The only expected network interruption edge is the Profile-declared offline branch.

- [ ] **Step 4: Run and commit.**

Run: `npm run build; node --test test/android-workflow-topology.test.mjs`

Expected: PASS.

Commit: `git add src/android-workflow/topology.ts test/android-workflow-topology.test.mjs && git commit -m "feat: add contract-driven workflow topology"`

### Task 4: Implement platform adapters

**Files:** create `src/android-workflow/tunnelAdapter.ts`, `src/android-workflow/androidDeviceAdapter.ts`; tests `test/android-workflow-tunnel.test.mjs`, `test/android-workflow-device.test.mjs`.

- [ ] **Step 1: Test fixed SSH arguments and device/APK guards.**

```js
assert.deepEqual(buildTunnelArgs("staging", 3100, 3100), ["-N", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-L", "127.0.0.1:3100:127.0.0.1:3100", "staging"]);
assert.throws(() => buildTunnelArgs("staging;del", 3100, 3100), /invalid SSH alias/);
assert.equal(selectDevice(["emulator-5554\tdevice"]), "emulator-5554");
assert.throws(() => selectDevice(["emulator-5556\tdevice"]), /emulator-5554/);
```

- [ ] **Step 2: Run and verify failure.**

Run: `npm run build; node --test test/android-workflow-tunnel.test.mjs test/android-workflow-device.test.mjs`

Expected: FAIL because adapters are absent.

- [ ] **Step 3: Implement adapters behind contracts.**

Tunnel adapter accepts only an SSH config alias and fixed staging loopback ports. Device adapter passes `-s emulator-5554` to every ADB command, validates APK package/hash, supports install/launch/tap/input/assert/screenshot/logcat, and never exposes raw process handles to Profiles.

- [ ] **Step 4: Run and commit.**

Run: `npm run build; node --test test/android-workflow-tunnel.test.mjs test/android-workflow-device.test.mjs`

Expected: PASS without real SSH or ADB side effects.

Commit: `git add src/android-workflow/tunnelAdapter.ts src/android-workflow/androidDeviceAdapter.ts test/android-workflow-tunnel.test.mjs test/android-workflow-device.test.mjs && git commit -m "feat: add contract-backed SSH and Android adapters"`

### Task 5: Add Profile registry and ZeroXCore first Profile

**Files:** create `src/android-workflow/profileRegistry.ts`, `src/android-workflow/profiles/zeroxcore.ts`; test `test/android-workflow-profiles.test.mjs`.

- [ ] **Step 1: Test generic and app-specific Profile isolation.**

```js
test("registry loads ZeroXCore without leaking its package into core contracts", () => {
  const profile = registry.get("zeroxcore");
  assert.equal(profile.packageName, "tech.zeroxcore.app");
  assert.equal(registry.coreSchema().includes("tech.zeroxcore.app"), false);
});

test("a second dummy profile can be registered without coordinator changes", () => {
  registry.register(dummyProfile);
  assert.equal(registry.get("dummy").id, "dummy");
});
```

- [ ] **Step 2: Run and verify failure.**

Run: `npm run build; node --test test/android-workflow-profiles.test.mjs`

Expected: FAIL because the registry and Profile are absent.

- [ ] **Step 3: Implement registry, declarative nodes, and ZeroXCore Profile.**

Registry validates Profile version, allowed capabilities, unique IDs, fixed device/port policy, and graph node types. ZeroXCore declares its package, staging port, UI assertions, enroll/challenge/verify nodes, offline branch, and recovery branch. Core files must not import the ZeroXCore Profile.

- [ ] **Step 4: Add the restricted plugin seam.**

Define `ProfilePlugin` loading by explicit registry entry only; provide `WorkflowContext` methods, capability checks, timeout, cancellation, and redacted outputs. Do not load arbitrary paths or execute plugin-provided shell commands.

- [ ] **Step 5: Run and commit.**

Run: `npm run build; node --test test/android-workflow-profiles.test.mjs`

Expected: PASS for ZeroXCore and dummy Profile isolation.

Commit: `git add src/android-workflow/profileRegistry.ts src/android-workflow/profiles/zeroxcore.ts test/android-workflow-profiles.test.mjs && git commit -m "feat: add profile registry and ZeroXCore profile"`

### Task 6: Implement coordinator and evidence

**Files:** create `src/android-workflow/coordinator.ts`; test `test/android-workflow-coordinator.test.mjs`.

- [ ] **Step 1: Test profile-driven success, disconnect/reconnect, failure and cleanup.**

Use fake adapters and a dummy Profile to prove the coordinator does not branch on ZeroXCore names. Assert `runId`, Profile version, APK digest, node statuses, redacted evidence, cleanup, resume, and cancellation.

- [ ] **Step 2: Run and verify failure.**

Run: `npm run build; node --test test/android-workflow-coordinator.test.mjs`

Expected: FAIL because the coordinator is absent.

- [ ] **Step 3: Implement profile-driven coordination.**

Resolve Profile from the registry, run preflight, execute its topology nodes through adapters, checkpoint before/after side effects, write redacted Markdown/JSON evidence, and clean up owned resources in `finally`.

- [ ] **Step 4: Run and commit.**

Run: `npm run build; node --test test/android-workflow-coordinator.test.mjs`

Expected: PASS.

Commit: `git add src/android-workflow/coordinator.ts test/android-workflow-coordinator.test.mjs && git commit -m "feat: coordinate reusable Android verification profiles"`

### Task 7: Register the generic MCP tool

**Files:** create `src/tools/stagingAndroidVerify.ts`; modify `src/index.ts`, `test/tools-list.test.mjs`, `test/complete-tools-e2e.test.mjs`.

- [ ] **Step 1: Add failing MCP registration tests.**

Assert the schema accepts `profileId`, `workdir`, `apkPath`, and `sshHost`, defaults the device to `emulator-5554`, rejects unknown profiles and unsafe overrides, requires owner authorization, and returns `runId`/status/evidence metadata.

- [ ] **Step 2: Run and verify failure.**

Run: `npm run build; node --test test/tools-list.test.mjs test/complete-tools-e2e.test.mjs`

Expected: FAIL because the tool is not registered.

- [ ] **Step 3: Implement a thin adapter.**

Use existing owner authorization, queue limits, cancellation signal, and result helpers. The handler must not contain app-specific branches; it validates the request and delegates to the generic coordinator.

- [ ] **Step 4: Register and update tool-count assertions.**

Add the tool beside development tools and update only explicit tool names and expected count.

- [ ] **Step 5: Run focused and full tests.**

Run: `npm run build; node --test test/tools-list.test.mjs test/complete-tools-e2e.test.mjs; npm test`

Expected: PASS; health reports one additional generic tool.

- [ ] **Step 6: Commit.**

Commit: `git add src/tools/stagingAndroidVerify.ts src/index.ts test/tools-list.test.mjs test/complete-tools-e2e.test.mjs && git commit -m "feat: expose reusable Android verification MCP tool"`

### Task 8: Real-environment acceptance and extension check

**Files:** modify `docs/deployment/staging-runbook.md` only if command/evidence documentation changes; generated evidence stays ignored.

- [ ] **Step 1: Run Profile preflight with `zeroxcore`.**

Use the staging SSH alias, the reviewed APK, and `emulator-5554`; confirm no side effect occurs before all preflight contracts pass.

- [ ] **Step 2: Run the full ZeroXCore Profile once with explicit authorization.**

Verify initial binding, intentional offline failure, recovery binding, evidence, and cleanup. Do not commit or push.

- [ ] **Step 3: Register and execute a dummy Profile in fake adapters.**

Confirm a second application can be added by Profile registration alone and that the coordinator, state store, adapters, MCP schema, and evidence format remain unchanged.

- [ ] **Step 4: Run post-acceptance checks.**

Run: `git status --short; Get-NetTCPConnection -State Listen -LocalPort 3100; adb -s emulator-5554 reverse --list`

Expected: no unowned SSH process, no unexpected listener, and no untracked sensitive evidence.

## Self-review checklist

- Core contains no ZeroXCore package, UI text, endpoint, or directory branch.
- All cross-cutting capabilities use contracts and typed errors.
- Topology transitions, retries, cancellation, resume, cleanup, and evidence are tested.
- New applications are represented by Profile data or a restricted plugin, not coordinator edits.
- SSH, ADB, Profile, state, evidence, and MCP layers have separate responsibilities.
- Security constraints are enforced centrally and cannot be weakened by a Profile.
- ZeroXCore is covered as the first Profile and a dummy Profile proves reuse.
- No placeholders or unspecified implementation steps remain.
