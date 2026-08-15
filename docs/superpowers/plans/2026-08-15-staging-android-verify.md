# Android Staging 验证工作流 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a resumable `staging_android_verify` MCP workflow that validates ZeroXCore staging through SSH, the already-running `emulator-5554`, ADB, and the enroll/challenge/verify recovery path without exposing credentials or performing Git writes.

**Architecture:** Keep the MCP tool thin and put orchestration in focused staging modules: preflight, tunnel lifecycle, Android driver, state store, runner, and evidence writer. The runner persists a checkpointed state machine and only accepts a fixed SSH alias, fixed device ID, fixed staging port, and validated APK/package inputs.

**Tech Stack:** TypeScript/Node.js, existing MCP server/tool registry, child-process runner, Windows OpenSSH, ADB, JSON state files under the existing approval data root, Node test runner.

---

## File map

- Create `src/staging/types.ts`: input, state, result, checkpoint, and redacted evidence types.
- Create `src/staging/redaction.ts`: deterministic removal of PINs, tokens, cookies, private paths, and auth response fields.
- Create `src/staging/stateStore.ts`: atomic JSON checkpoint persistence, load/resume, terminal-state cleanup.
- Create `src/staging/tunnelManager.ts`: fixed SSH alias/port command construction, PID ownership, readiness probe, stop/reconnect.
- Create `src/staging/androidDriver.ts`: ADB device validation, APK hash/package validation, install, reverse, launch, UI actions, screenshot/logcat capture.
- Create `src/staging/runner.ts`: state-machine orchestration, retry policy, cancellation, cleanup, and evidence assembly.
- Create `src/tools/stagingAndroidVerify.ts`: MCP schema, owner authorization, queue wrapper, and runner invocation.
- Modify `src/index.ts`: register the new tool and add it to the tool list.
- Create `test/staging-redaction.test.mjs`, `test/staging-state-store.test.mjs`, `test/staging-tunnel-manager.test.mjs`, `test/staging-android-driver.test.mjs`, and `test/staging-runner.test.mjs`.
- Modify `test/tools-list.test.mjs` and `test/complete-tools-e2e.test.mjs` for the new registered tool and count.
- Create `docs/deployment/evidence/.gitkeep` only if the evidence directory needs to exist in a clean checkout; generated evidence remains ignored.

### Task 1: Define types and redaction rules

**Files:** create `src/staging/types.ts`, `src/staging/redaction.ts`; test `test/staging-redaction.test.mjs`.

- [ ] **Step 1: Write failing tests for redaction and state names.**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { redactStagingText } from "../dist/staging/redaction.js";

test("redacts bearer, cookie, pin, and Windows user path values", () => {
  const result = redactStagingText(
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456; Cookie: sid=secret; PIN=12345678; C:\\Users\\Lenovo\\x"
  );
  assert.match(result, /Bearer \[REDACTED\]/);
  assert.doesNotMatch(result, /abcdefghijklmnopqrstuvwxyz123456/);
  assert.doesNotMatch(result, /sid=secret|12345678|Lenovo/);
});
```

- [ ] **Step 2: Run the focused test and verify it fails because the module is absent.**

Run: `npm run build; node --test test/staging-redaction.test.mjs`

Expected: FAIL with a missing `dist/staging/redaction.js` module.

- [ ] **Step 3: Implement typed states and deterministic redaction.**

```ts
export type StagingState =
  | "created" | "preflight_passed" | "tunnel_connected" | "apk_installed"
  | "app_ready" | "binding_verified" | "tunnel_interrupted"
  | "failure_state_confirmed" | "tunnel_reconnected" | "recovery_verified"
  | "completed" | "failed" | "failed_cleanup" | "cancelled";

export function redactStagingText(input: string): string {
  return input
    .replace(/(authorization:\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/(cookie:\s*)[^\r\n]+/gi, "$1[REDACTED]")
    .replace(/(pin|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/C:\\Users\\[^\\\r\n ]+/gi, "C:\\Users\\[REDACTED]");
}
```

- [ ] **Step 4: Run the focused test and commit.**

Run: `npm run build; node --test test/staging-redaction.test.mjs`

Expected: PASS.

Commit: `git add src/staging/types.ts src/staging/redaction.ts test/staging-redaction.test.mjs && git commit -m "feat: add staging workflow types and redaction"`

### Task 2: Add checkpoint state storage

**Files:** create `src/staging/stateStore.ts`; test `test/staging-state-store.test.mjs`.

- [ ] **Step 1: Test atomic save/load, resume, and terminal cleanup.**

```js
test("persists the latest checkpoint and removes only terminal run data", async () => {
  const store = new StateStore(tempDir);
  await store.save({ runId: "run-1", state: "tunnel_connected", pid: 1234 });
  assert.equal((await store.load("run-1")).state, "tunnel_connected");
  await store.finish("run-1");
  assert.equal(await store.load("run-1"), null);
});
```

- [ ] **Step 2: Run the test and verify failure.**

Run: `npm run build; node --test test/staging-state-store.test.mjs`

Expected: FAIL because `StateStore` is not implemented.

- [ ] **Step 3: Implement atomic JSON writes under `APPROVAL_DATA_DIR/staging-runs`.**

Use a temporary file plus rename, restrict accepted transitions to the design state graph, preserve only redacted metadata, and retain failed runs until evidence has been written.

- [ ] **Step 4: Run tests and commit.**

Run: `npm run build; node --test test/staging-state-store.test.mjs`

Expected: PASS.

Commit: `git add src/staging/stateStore.ts test/staging-state-store.test.mjs && git commit -m "feat: persist staging workflow checkpoints"`

### Task 3: Implement safe SSH tunnel lifecycle

**Files:** create `src/staging/tunnelManager.ts`; test `test/staging-tunnel-manager.test.mjs`.

- [ ] **Step 1: Test fixed command construction and PID ownership.**

```js
const args = buildTunnelArgs("staging", 3100, 3100);
assert.deepEqual(args, ["-N", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-L", "127.0.0.1:3100:127.0.0.1:3100", "staging"]);
assert.throws(() => buildTunnelArgs("staging; del *", 3100, 3100), /invalid SSH alias/);
```

- [ ] **Step 2: Run the test and verify failure.**

Run: `npm run build; node --test test/staging-tunnel-manager.test.mjs`

Expected: FAIL because the tunnel module is absent.

- [ ] **Step 3: Implement `TunnelManager`.**

Use the existing process runner abstraction, validate alias against the local SSH config format, allow only `127.0.0.1` and port `3100`, probe the local listener before advancing state, and stop only the recorded child PID/tree.

- [ ] **Step 4: Test success, startup timeout, reconnect, and foreign-process protection.**

Run: `npm run build; node --test test/staging-tunnel-manager.test.mjs`

Expected: PASS with no real SSH process started.

- [ ] **Step 5: Commit.**

Commit: `git add src/staging/tunnelManager.ts test/staging-tunnel-manager.test.mjs && git commit -m "feat: add owned staging SSH tunnel lifecycle"`

### Task 4: Implement the ADB/Android driver

**Files:** create `src/staging/androidDriver.ts`; test `test/staging-android-driver.test.mjs`.

- [ ] **Step 1: Test device and APK guards.**

```js
assert.equal(selectDevice(["emulator-5554\tdevice"]), "emulator-5554");
assert.throws(() => selectDevice(["emulator-5556\tdevice"]), /emulator-5554/);
assert.throws(() => validateApkMetadata({ packageName: "other.app" }, "tech.zeroxcore.app"), /package/);
```

- [ ] **Step 2: Run the test and verify failure.**

Run: `npm run build; node --test test/staging-android-driver.test.mjs`

Expected: FAIL because the driver module is absent.

- [ ] **Step 3: Implement fixed-device ADB operations.**

Provide methods `preflight()`, `verifyApk()`, `install()`, `reverse()`, `launch()`, `inputText()`, `tap()`, `screenshot()`, `logcatTail()`, and `clearReverse()`. Every command must pass `-s emulator-5554`, use argument arrays, enforce output/time limits, and redact output before returning.

- [ ] **Step 4: Test with a fake ADB adapter.**

Run: `npm run build; node --test test/staging-android-driver.test.mjs`

Expected: PASS; no real emulator state changes occur in unit tests.

- [ ] **Step 5: Commit.**

Commit: `git add src/staging/androidDriver.ts test/staging-android-driver.test.mjs && git commit -m "feat: add fixed-emulator Android driver"`

### Task 5: Build the resumable runner and evidence writer

**Files:** create `src/staging/runner.ts`; test `test/staging-runner.test.mjs`.

- [ ] **Step 1: Write fake-adapter tests for the complete state graph.**

Cover successful recovery, SSH interruption, ADB loss, HTTP non-2xx, cancellation, duplicate resume, and cleanup failure. Assert that each result contains `runId`, redacted evidence, and the correct terminal state.

- [ ] **Step 2: Run tests and verify failure.**

Run: `npm run build; node --test test/staging-runner.test.mjs`

Expected: FAIL because `StagingRunner` is absent.

- [ ] **Step 3: Implement `StagingRunner`.**

The runner must save a checkpoint before and after every side effect, resume only from valid checkpoints, use the fixed sequence from the design, stop on unexpected network/device states, and execute cleanup in a `finally` path. Write evidence only after redaction and include commit/APK digest/device/run metadata.

- [ ] **Step 4: Run the complete runner test set.**

Run: `npm run build; node --test test/staging-runner.test.mjs`

Expected: PASS for all success and failure paths.

- [ ] **Step 5: Commit.**

Commit: `git add src/staging/runner.ts test/staging-runner.test.mjs && git commit -m "feat: orchestrate resumable staging verification"`

### Task 6: Register the MCP tool and update tool-list coverage

**Files:** create `src/tools/stagingAndroidVerify.ts`; modify `src/index.ts`, `test/tools-list.test.mjs`, `test/complete-tools-e2e.test.mjs`.

- [ ] **Step 1: Add failing registration tests.**

Assert that `staging_android_verify` appears in `tools/list`, has the exact schema fields, is owner-authorized, and rejects a non-owner, unsupported device, non-3100 port, or unsafe SSH alias before starting a process.

- [ ] **Step 2: Run tests and verify failure.**

Run: `npm run build; node --test test/tools-list.test.mjs test/complete-tools-e2e.test.mjs`

Expected: FAIL because the tool is not registered and the expected tool count is unchanged.

- [ ] **Step 3: Implement the thin MCP adapter.**

Use the existing `authorizeOwnerToolCall`, queue limits, request cancellation signal, and result helpers. The handler validates the schema, creates a run ID, starts/resumes `StagingRunner`, and returns structured status/evidence metadata without exposing process output or credentials.

- [ ] **Step 4: Register the tool and update the tool list/count assertions.**

Add the registration beside the existing development tools and update only the expected count and explicit tool-name assertions.

- [ ] **Step 5: Run focused and full tests.**

Run: `npm run build; node --test test/tools-list.test.mjs test/complete-tools-e2e.test.mjs; npm test`

Expected: all tests PASS; health reports one additional tool.

- [ ] **Step 6: Commit.**

Commit: `git add src/tools/stagingAndroidVerify.ts src/index.ts test/tools-list.test.mjs test/complete-tools-e2e.test.mjs && git commit -m "feat: expose staging Android verification tool"`

### Task 7: Real-environment acceptance

**Files:** modify `docs/deployment/staging-runbook.md` only if the command and evidence contract needs documenting; generated evidence stays ignored.

- [ ] **Step 1: Run preflight only.**

Call `staging_android_verify` with the staging SSH alias, the reviewed APK path, package name, and `emulator-5554`; confirm no tunnel or APK side effect occurs when any preflight check fails.

- [ ] **Step 2: Run the full workflow once with explicit user authorization.**

Verify the SSH tunnel, APK SHA-256, initial binding, intentional offline failure, recovery binding, evidence file, and cleanup. Do not commit or push from the tool.

- [ ] **Step 3: Run post-acceptance checks.**

Run: `git status --short; Get-NetTCPConnection -State Listen -LocalPort 3100; adb -s emulator-5554 reverse --list`

Expected: no unowned SSH process, no unexpected listener, and only the documented ADB reverse mapping remains or is explicitly cleaned up.

- [ ] **Step 4: Commit documentation only if changed.**

Commit: `git add docs/deployment/staging-runbook.md && git commit -m "docs: record staging verification workflow"`

## Coverage review

- The design state graph is covered by Tasks 2 and 5.
- SSH safety, fixed ports, alias-only execution, and cleanup are covered by Tasks 3 and 5.
- Fixed `emulator-5554`, APK/package/hash checks, and ADB operations are covered by Task 4.
- MCP schema, owner authorization, queue/cancellation, and tool-list registration are covered by Task 6.
- Redaction and credential exclusion are covered by Tasks 1, 2, 4, and 5.
- Real staging acceptance and evidence are covered by Task 7.
- No placeholders or unspecified implementation steps remain in this plan.
