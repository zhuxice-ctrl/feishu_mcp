# Development Task Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the owner-only persistent background-task foundation and the three task-control MCP tools required by later Android, Windows, and environment adapters.

**Architecture:** Persist one atomic metadata file and append-only redacted log per task under the protected approval data directory. A detached Node worker runs validated internal launch specifications with `shell: false`; the MCP coordinator owns queueing and resource locks, while restart recovery trusts only fresh worker heartbeats and never force-kills an unverifiable PID.

**Tech Stack:** Node.js 20+, TypeScript 5.7, Zod 4, MCP SDK, Node test runner, Windows `taskkill.exe` only inside the verified worker process.

---

## Task 1: Development configuration and owner-only authorization

**Files:**
- Modify: `src/config.ts`
- Modify: `src/security/toolAccess.ts`
- Modify: `src/security/approval.ts`
- Modify: `src/security/approvalState.ts`
- Modify: `src/security/approvalStore.ts`
- Modify: `src/tools/registry.ts`
- Modify: `src/tools/results.ts`
- Modify: `.env.example`
- Modify: `.gitignore`
- Create: `test/development-config.test.mjs`
- Create: `test/development-owner-access.test.mjs`
- Create: `test/development-single-use-approval.test.mjs`
- Modify: `test/approval-store.test.mjs`

- [x] **Step 1: Write the failing configuration tests**

Create subprocess-based tests so each case imports a fresh `dist/config.js`. Assert defaults of 4 total tasks, 2 builds, 14 retention days, a 2-hour task runtime, and a task directory exactly one level below `APPROVAL_DATA_DIR`. Assert limits above 16 tasks, above 8 builds, above 365 retention days, above a 24-hour runtime, and a task directory outside `APPROVAL_DATA_DIR` terminate with a nonzero exit.

```js
const script = "import('./dist/config.js').then(c=>console.log(JSON.stringify({total:c.DEV_MAX_TASKS,builds:c.DEV_MAX_BUILDS,days:c.DEV_TASK_RETENTION_DAYS,runtime:c.DEV_TASK_MAX_RUNTIME_MS,dir:c.DEV_TASK_DATA_DIR})))";
const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
  cwd: projectDir,
  encoding: "utf8",
  env: { ...process.env, APPROVAL_DATA_DIR: root, DEV_TASK_DATA_DIR: "" },
});
assert.equal(result.status, 0, result.stderr);
assert.deepEqual(JSON.parse(result.stdout), {
  total: 4,
  builds: 2,
  days: 14,
  runtime: 7_200_000,
  dir: path.join(root, "tasks"),
});
```

- [x] **Step 2: Write the failing owner authorization tests**

Import `authorizeOwnerToolCall` inside `runWithRequestContext`. Assert configured owner succeeds, a different authenticated identity receives `OWNER_REQUIRED`, and a missing `OWNER_USER_ID` receives `OWNER_NOT_CONFIGURED`.

```js
const result = await runWithRequestContext(
  { token: "", userId: "other", email: null },
  () => authorizeOwnerToolCall("get_development_task", {}),
);
assert.equal(JSON.parse(result.content[0].text).code, "OWNER_REQUIRED");
```

- [x] **Step 3: Run the new tests and verify failure**

Run: `npm run build; node --test test/development-config.test.mjs test/development-owner-access.test.mjs`

Expected: FAIL because the development exports and `authorizeOwnerToolCall` do not exist.

- [x] **Step 4: Add bounded configuration**

Export these exact values from `src/config.ts` and require `DEV_TASK_DATA_DIR` to be inside `APPROVAL_DATA_DIR` using `path.relative` rather than string prefixes:

```ts
export const DEV_MAX_TASKS = envBoundedPositiveInt("DEV_MAX_TASKS", 4, 16);
export const DEV_MAX_BUILDS = envBoundedPositiveInt("DEV_MAX_BUILDS", 2, 8);
export const DEV_TASK_QUEUE_TIMEOUT_MS = envBoundedPositiveInt(
  "DEV_TASK_QUEUE_TIMEOUT_MS", 15 * 60_000, MAX_TIMEOUT_MS,
);
export const DEV_TASK_RETENTION_DAYS = envBoundedPositiveInt("DEV_TASK_RETENTION_DAYS", 14, 365);
export const DEV_TASK_MAX_TOTAL_BYTES = envBoundedPositiveInt(
  "DEV_TASK_MAX_TOTAL_BYTES", 1_073_741_824, 10 * 1_073_741_824,
);
export const DEV_TASK_LOG_MAX_BYTES = envBoundedPositiveInt(
  "DEV_TASK_LOG_MAX_BYTES", 52_428_800, 536_870_912,
);
export const DEV_TASK_HEARTBEAT_MS = envBoundedPositiveInt("DEV_TASK_HEARTBEAT_MS", 2_000, 60_000);
export const DEV_TASK_CANCEL_GRACE_MS = envBoundedPositiveInt("DEV_TASK_CANCEL_GRACE_MS", 5_000, 60_000);
export const DEV_TASK_MAX_RUNTIME_MS = envBoundedPositiveInt(
  "DEV_TASK_MAX_RUNTIME_MS", 2 * 60 * 60_000, 24 * 60 * 60_000,
);
export const DEV_TASK_DATA_DIR = path.resolve(
  process.env.DEV_TASK_DATA_DIR || path.join(APPROVAL_DATA_DIR, "tasks"),
);
const taskDataRelative = path.relative(path.resolve(APPROVAL_DATA_DIR), DEV_TASK_DATA_DIR);
if (taskDataRelative.startsWith("..") || path.isAbsolute(taskDataRelative)) {
  throw new Error("DEV_TASK_DATA_DIR must be inside APPROVAL_DATA_DIR");
}
```

- [x] **Step 5: Add owner authorization and error codes**

Add `OWNER_REQUIRED`, `OWNER_NOT_CONFIGURED`, `TASK_NOT_FOUND`, `TASK_QUEUE_FULL`, `TASK_INTERRUPTED`, and `TASK_CANCELLED` to `ToolErrorCode`. Add this function to `toolAccess.ts` without changing `authorizeToolCall`:

```ts
export function authorizeOwnerToolCall(toolName: string, args: unknown): ToolAccessError | null {
  const authenticated = authorizeToolCall(toolName, args);
  if (authenticated) return authenticated;
  if (!OWNER_USER_ID) return toolError("OWNER_NOT_CONFIGURED", "Development tools require OWNER_USER_ID.");
  if (getRequestUserId() !== OWNER_USER_ID) {
    logger.warn("owner_tool_authorization_denied", {
      toolName,
      identityPresent: getRequestUserId() !== null,
    });
    return toolError("OWNER_REQUIRED", "This development tool is restricted to the configured owner.");
  }
  return null;
}
```

- [x] **Step 6: Add single-use approval mode**

Before documentation, add a failing approval test that calls `requestApproval` with `decisionMode: "single_use"`. Assert the elicitation enum is exactly `allow_once, deny`, an injected `allow_session` or `allow_permanent` response is rejected, and standard approvals retain all four current choices. Then add `decisionMode?: "standard" | "single_use"` to `ApprovalRequest`; default it to `standard`, generate the matching enum, and validate the accepted response against the same mode before storing any decision.

```ts
const allowedDecisions = request.decisionMode === "single_use"
  ? ["allow_once", "deny"] as const
  : ["allow_once", "allow_session", "allow_permanent", "deny"] as const;
if (!allowedDecisions.includes(response.decision)) {
  return toolError("APPROVAL_DENIED", "This operation requires a single-use decision.");
}
```

Run: `npm run build; node --test test/development-single-use-approval.test.mjs test/approval-elicitation.test.mjs`

Expected: both tests pass; standard approval behavior is unchanged.

Single-use requests must bypass remembered session and permanent grants. Persist the normalized decision mode in `ApprovalStatePayload`, treat a missing legacy value as `standard`, and compare it in direct, prior-subject, and continuation matching. Tests must prove both stored grant types are ignored and signed states cannot switch between standard and single-use modes.

- [x] **Step 7: Extend typed approval subjects**

Add `development`, `environment_plan`, `device`, and `credential` to both `ApprovalSubjectKind` and `ToolSubject.kind`. Update approval-store parsing to accept exactly the old and new values, and extend `approval-store.test.mjs` to persist/reload one record of every new kind. Existing stored approvals remain valid without migration.

```ts
export type ApprovalSubjectKind =
  | "command" | "origin" | "path" | "paths"
  | "development" | "environment_plan" | "device" | "credential";
```

- [x] **Step 8: Document and ignore local task data**

Add the nine bounded configuration names plus `DEV_TASK_DATA_DIR` to `.env.example` with their defaults. Add `/tasks/`, `/.development-data/`, `*.task.json`, `*.heartbeat`, and `*.cancel-request` to `.gitignore`. Root-anchor directory rules so the future tracked `src/development/tasks/` source directory remains visible to Git. Do not ignore the future tracked `broker/` source directory.

- [x] **Step 9: Run focused and existing authorization tests**

Run: `npm run build; node --test test/development-config.test.mjs test/development-owner-access.test.mjs test/development-single-use-approval.test.mjs test/approval-elicitation.test.mjs test/approval-state.test.mjs test/approval-store.test.mjs test/security-auth.test.mjs test/auth-modes.test.mjs`

Expected: all tests pass.

- [x] **Step 10: Commit**

```powershell
git add src/config.ts src/security/toolAccess.ts src/security/approval.ts src/security/approvalState.ts src/security/approvalStore.ts src/tools/registry.ts src/tools/results.ts .env.example .gitignore test/development-config.test.mjs test/development-owner-access.test.mjs test/development-single-use-approval.test.mjs test/approval-store.test.mjs docs/superpowers/plans/2026-07-30-development-task-core.md
git commit -m "feat: gate development tools to owner"
```

## Task 2: Task types, owner keys, atomic store, and streaming redaction

**Files:**
- Create: `src/development/tasks/types.ts`
- Create: `src/development/tasks/ownerKey.ts`
- Create: `src/development/tasks/redaction.ts`
- Create: `src/development/tasks/store.ts`
- Create: `test/development-task-store.test.mjs`
- Create: `test/development-task-redaction.test.mjs`

- [x] **Step 1: Write failing store tests**

Cover create, read, compare-and-update, list by owner key, atomic metadata replacement, corrupt-file quarantine, and rejection of invalid task IDs. Use only a temporary directory.

```js
const store = new DevelopmentTaskStore(root);
const created = store.create({ ownerKey: "owner-key", tool: "android_development", action: "build", class: "build", resources: ["project:c:/tmp/app"] });
assert.match(created.id, /^[0-9a-f-]{36}$/i);
assert.equal(store.get(created.id)?.state, "queued");
assert.equal(store.update(created.id, "queued", { state: "running", stage: "spawn" }).state, "running");
assert.throws(() => store.update(created.id, "queued", { state: "failed" }), /state changed/i);
```

- [x] **Step 2: Write failing redaction tests**

Assert configured secret values, `Authorization: Bearer`, password-like environment assignments, Gradle signing properties, and split-across-chunk secrets are redacted before they reach disk.

```js
const redactor = new StreamingTaskRedactor(["split-secret-value"]);
const output = redactor.push("token=split-secret-") + redactor.push("value\n") + redactor.flush();
assert.doesNotMatch(output, /split-secret-value/);
assert.match(output, /\[REDACTED\]/);
```

- [x] **Step 3: Run the tests and verify failure**

Run: `npm run build; node --test test/development-task-store.test.mjs test/development-task-redaction.test.mjs`

Expected: FAIL because the task modules do not exist.

- [x] **Step 4: Define stable task contracts**

Define and export these exact unions and interfaces in `types.ts`:

```ts
export type DevelopmentTaskState = "queued" | "running" | "succeeded" | "failed" | "cancel_requested" | "cancelled" | "interrupted";
export type DevelopmentTaskClass = "default" | "build" | "privileged";
export interface DevelopmentArtifact { name: string; path: string; kind: string; size?: number; sha256?: string; }
export interface DevelopmentLaunchSpec {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  secretEnvRefs?: Record<string, string>;
  stdin?: string;
  timeoutMs: number;
  successExitCodes: number[];
}
export interface DevelopmentTaskRecord {
  version: 1;
  id: string;
  ownerKey: string;
  tool: string;
  action: string;
  class: DevelopmentTaskClass;
  resources: string[];
  state: DevelopmentTaskState;
  stage: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  endedAt?: string;
  worker?: { pid: number; nonce: string; heartbeatAt: string };
  exit?: { code: number | null; errorCode?: string; message?: string };
  artifacts: DevelopmentArtifact[];
}
```

Persist `DevelopmentLaunchSpec` in a separate mode-`0600` `launch.json` file that task-query tools never return. `env` may contain only non-secret adapter-generated values; sensitive-name keys and configured secret values are rejected before persistence. `secretEnvRefs` stores opaque local credential IDs, never decrypted values.

- [x] **Step 5: Derive non-reversible owner keys**

In `ownerKey.ts`, derive a full SHA-256 HMAC from `APPROVAL_STATE_SECRET` and the canonical owner ID. Throw at task creation if either value is missing; never persist the raw user ID.

```ts
export function developmentOwnerKey(userId: string): string {
  if (!APPROVAL_STATE_SECRET) throw new Error("APPROVAL_STATE_SECRET is required for development tasks");
  return createHmac("sha256", APPROVAL_STATE_SECRET).update(userId, "utf8").digest("hex");
}
```

- [x] **Step 6: Implement the atomic store**

Use `mkdirSync(..., { recursive: true, mode: 0o700 })`, exclusive temporary files, `fsyncSync`, and `renameSync`. Validate parsed records before returning them. Quarantine corrupt metadata by renaming it to `<id>.corrupt-<timestamp>.json`; do not silently treat corrupt running work as successful. Require the expected state argument for every transition.

- [x] **Step 7: Implement line-aware streaming redaction**

Keep `maxSecretLength - 1` characters between chunks, redact configured secret values longest-first, and apply case-insensitive patterns for bearer headers and sensitive assignments. Cap the retained tail at 4096 characters and replace matches with `[REDACTED]`.

```ts
const PATTERNS = [
  /authorization\s*:\s*bearer\s+[^\s]+/gi,
  /\b(password|passwd|token|secret|storepass|keypass)\s*[=:]\s*[^\s]+/gi,
  /-P(android\.inject\.signing\.(store|key)\.password)=[^\s]+/gi,
];
```

- [x] **Step 8: Run focused tests**

Run: `npm run build; node --test test/development-task-store.test.mjs test/development-task-redaction.test.mjs`

Expected: all tests pass and temporary roots contain no unredacted fixture secret.

- [x] **Step 9: Commit**

```powershell
git add src/development/tasks test/development-task-store.test.mjs test/development-task-redaction.test.mjs
git commit -m "feat: persist redacted development tasks"
```

## Task 3: Resource scheduler and bounded queue

**Files:**
- Create: `src/development/tasks/scheduler.ts`
- Create: `test/development-task-scheduler.test.mjs`

- [ ] **Step 1: Write failing scheduler tests**

Use deferred promises to prove: global limit 4, build limit 2, privileged limit 1, FIFO order, same-project serialization, same-device serialization, different resources parallelism, queue timeout, queued cancellation, and lock release after rejection.

```js
const scheduler = new DevelopmentTaskScheduler({ total: 4, builds: 2, queueTimeoutMs: 100 });
const first = scheduler.run("a", "build", ["project:x"], () => gate.promise);
const second = scheduler.run("b", "build", ["project:x"], async () => "second");
await tick();
assert.deepEqual(scheduler.summary(), { active: 1, queued: 1, totalLimit: 4, buildLimit: 2 });
gate.resolve("first");
assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
```

- [ ] **Step 2: Run the test and verify failure**

Run: `npm run build; node --test test/development-task-scheduler.test.mjs`

Expected: FAIL because the scheduler does not exist.

- [ ] **Step 3: Implement fixed-order resource acquisition**

Normalize and sort unique resource keys before checking conflicts. Maintain active task records and one FIFO waiter list. A task can start only when global/class capacity and every resource are free. Never hold a partial set of resources.

```ts
const normalizedResources = [...new Set(resources)].sort((a, b) => a.localeCompare(b));
const blocked = normalizedResources.some((resource) => this.heldResources.has(resource));
const classBlocked = taskClass === "build" && this.activeBuilds >= this.options.builds;
const privilegedBlocked = taskClass === "privileged" && this.activePrivileged >= 1;
```

- [ ] **Step 4: Implement queued cancellation and summary**

`cancel(taskId)` removes only a queued waiter, clears its timeout, rejects it with `DevelopmentTaskCancelledError`, and then drains the queue. `summary()` returns only counts and limits; it must not include task IDs or resources.

- [ ] **Step 5: Run the scheduler tests**

Run: `npm run build; node --test test/development-task-scheduler.test.mjs`

Expected: all tests pass without timing flakes across three consecutive runs.

- [ ] **Step 6: Commit**

```powershell
git add src/development/tasks/scheduler.ts test/development-task-scheduler.test.mjs
git commit -m "feat: schedule bounded development tasks"
```

## Task 4: Detached worker, heartbeat, recovery, and safe cancellation

**Files:**
- Create: `src/development/tasks/workerProtocol.ts`
- Create: `src/development/tasks/worker.ts`
- Create: `src/development/tasks/coordinator.ts`
- Create: `test/fixtures/development-worker-fixture.mjs`
- Create: `test/development-task-worker.test.mjs`
- Create: `test/development-task-recovery.test.mjs`

- [ ] **Step 1: Write failing worker tests**

The fixture must print staged output, optionally sleep, write an artifact, and exit with a requested code. Test success, nonzero exit, timeout, log redaction, artifact validation, cancel-before-start, cancel-while-running, and a server-side coordinator restart while the detached worker remains alive.

```js
const task = coordinator.enqueue({
  ownerKey,
  tool: "windows_development",
  action: "test_fixture",
  class: "build",
  resources: ["project:test"],
  launch: { executable: process.execPath, args: [fixture, "--sleep", "500"], cwd: root, env: {}, timeoutMs: 5_000, successExitCodes: [0] },
});
await waitForState(store, task.id, "running");
await coordinator.cancel(task.id, ownerKey);
assert.equal((await waitForTerminal(store, task.id)).state, "cancelled");
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npm run build; node --test test/development-task-worker.test.mjs test/development-task-recovery.test.mjs`

Expected: FAIL because worker and coordinator modules do not exist.

- [ ] **Step 3: Implement the file protocol**

Use these files inside each task directory: `metadata.json`, `launch.json`, `worker-token`, `heartbeat.json`, `stdout.log`, `stderr.log`, and `cancel-request`. The token is 32 random bytes in hex and mode `0600`. The worker receives only task directory and token through environment variables and exits if the token file differs.

- [ ] **Step 4: Implement the worker process**

Spawn the validated launch spec with `shell: false`, `windowsHide: true`, and piped stdout/stderr. Reject secret-looking keys or configured secret values in persisted `env`. Permit at most 4096 bytes of internal adapter-provided stdin, write it once, and close stdin; MCP schemas never expose this field. Phase 1 accepts only an empty `secretEnvRefs` map; the DPAPI resolver added in the Android phase resolves opaque references in worker memory immediately before spawn. Redact output before append. Refresh heartbeat atomically every `DEV_TASK_HEARTBEAT_MS`. Poll `cancel-request`; on cancellation, terminate only the worker's own child tree, wait `DEV_TASK_CANCEL_GRACE_MS`, then use `taskkill.exe /PID <child.pid> /T /F` on Windows. Finalize metadata exactly once.

- [ ] **Step 5: Implement coordinator dispatch**

Persist queued metadata and launch spec before scheduler admission. Start `process.execPath` with `dist/development/tasks/worker.js`, `detached: true`, `stdio: "ignore"`, a minimal environment, and `unref()`. The coordinator never launches a caller-provided spec; only internal adapters may call `enqueueInternal`.

- [ ] **Step 6: Implement restart recovery**

On construction, scan validated metadata. Rebuild resource occupancy for running tasks with a heartbeat newer than three heartbeat intervals. Mark stale running/cancel-requested tasks `interrupted`. Requeue previously queued tasks only when their launch spec and owner key validate. Never call `taskkill` from the recovered coordinator.

- [ ] **Step 7: Validate artifacts safely**

The worker accepts an artifact manifest only from its own child protocol file. Canonicalize every artifact and keep only paths inside the authorized project/output roots recorded by the internal adapter. Record size and SHA-256 after the child exits; never read artifact contents into metadata.

- [ ] **Step 8: Run focused tests**

Run: `npm run build; node --test test/development-task-worker.test.mjs test/development-task-recovery.test.mjs test/development-task-scheduler.test.mjs`

Expected: all tests pass; the recovery test observes the same task ID before and after coordinator reconstruction.

- [ ] **Step 9: Commit**

```powershell
git add src/development/tasks test/fixtures/development-worker-fixture.mjs test/development-task-worker.test.mjs test/development-task-recovery.test.mjs
git commit -m "feat: run recoverable development workers"
```

## Task 5: Owner task-control MCP tools

**Files:**
- Create: `src/tools/developmentTasks.ts`
- Create: `test/development-task-tools.test.mjs`
- Modify: `src/index.ts`
- Modify: `test/tools-list.test.mjs`

- [ ] **Step 1: Write failing tool tests**

Register the tools on an in-memory MCP server or call exported handlers. Assert owner-only access, cross-owner denial, unknown-task denial, cursor pagination, byte and line limits, path-free artifact summaries, queued cancellation, running cancellation, terminal-task idempotence, and no launch spec leakage.

```js
const result = await getDevelopmentTask({ taskId }, ownerContext());
const body = JSON.parse(result.content[0].text);
assert.equal(body.task.id, taskId);
assert.equal("ownerKey" in body.task, false);
assert.equal("worker" in body.task, false);
assert.equal("launch" in body.task, false);
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npm run build; node --test test/development-task-tools.test.mjs`

Expected: FAIL because tool handlers do not exist.

- [ ] **Step 3: Implement `get_development_task`**

Schema: `{ taskId: z.string().uuid() }`. Return ID, tool, action, state, stage, timestamps, redacted exit summary, and artifact names/kinds/sizes/hashes. Return paths only when they remain inside a currently authorized owner directory; otherwise return a stable artifact ID.

- [ ] **Step 4: Implement `read_development_task_logs`**

Schema: task UUID, stream enum `stdout|stderr|both`, optional `{ stdout, stderr }` nonnegative byte cursors, max bytes 65,536, and max lines 500. Open logs read-only, start at UTF-8-safe byte boundaries, and return `{ cursors, nextCursors, eof, truncated, stdout, stderr }`. Keeping independent cursors prevents one stream from skipping bytes in the other. Do not follow symlinks.

- [ ] **Step 5: Implement `cancel_development_task`**

Schema: task UUID. Cancel queued work through the scheduler; for running work atomically change state to `cancel_requested` and create `cancel-request`. Return terminal tasks unchanged with `alreadyTerminal: true`.

- [ ] **Step 6: Register exactly three new tools**

Import and call `registerDevelopmentTaskTools(server)` after current tool registration. Append the three names to `TOOL_NAMES` in this order and update the startup line to use `TOOL_NAMES.length`:

```ts
"get_development_task",
"read_development_task_logs",
"cancel_development_task",
```

Update `tools-list.test.mjs` to expect 24 tools at this phase.

- [ ] **Step 7: Run focused and HTTP inventory tests**

Run: `npm run build; node --test test/development-task-tools.test.mjs test/tools-list.test.mjs`

Expected: all tests pass and `tools/list` contains exactly 24 unique names.

- [ ] **Step 8: Commit**

```powershell
git add src/tools/developmentTasks.ts src/index.ts test/development-task-tools.test.mjs test/tools-list.test.mjs
git commit -m "feat: expose development task controls"
```

## Task 6: Health summary, retention, and Phase 1 regression gate

**Files:**
- Modify: `src/development/tasks/store.ts`
- Modify: `src/development/tasks/coordinator.ts`
- Modify: `src/index.ts`
- Modify: `test/health-concurrency.test.mjs`
- Create: `test/development-task-retention.test.mjs`

- [ ] **Step 1: Write failing retention and health tests**

Assert cleanup deletes only terminal tasks older than retention, respects the total-byte cap oldest-first, never deletes project artifacts, leaves queued/running tasks untouched, and health exposes only counts and limits.

```js
assert.deepEqual(health.developmentTasks, {
  queued: 0,
  running: 0,
  terminal: 0,
  totalLimit: 4,
  buildLimit: 2,
});
assert.doesNotMatch(JSON.stringify(health), /taskId|ownerKey|device|project|worker|heartbeat/i);
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npm run build; node --test test/development-task-retention.test.mjs test/health-concurrency.test.mjs`

Expected: FAIL because cleanup and the health summary are not wired.

- [ ] **Step 3: Implement safe retention**

Compute task-directory sizes without following symlinks. Select only terminal records. Delete by canonical task directory using exact UUID names, first by age and then oldest-first until under the byte cap. Log counts only.

- [ ] **Step 4: Add health summary and scheduled cleanup**

Add `developmentTasks: coordinator.summary()` to `/health`. Start recovery before listening, perform initial cleanup after recovery, and schedule cleanup hourly. The summary must contain only aggregate counts and configured limits.

- [ ] **Step 5: Run the complete Phase 1 gate**

```powershell
npm run typecheck
npm test
python test/e2e_test.py
npm audit --omit=dev
git diff --check
```

Expected: every command exits 0, existing 21-tool behavior remains intact apart from the intentional inventory increase to 24, and secret fixture scans find no raw values in task storage or output.

- [ ] **Step 6: Commit**

```powershell
git add src/development/tasks/store.ts src/development/tasks/coordinator.ts src/index.ts test/health-concurrency.test.mjs test/development-task-retention.test.mjs
git commit -m "feat: recover and retain development tasks"
```
