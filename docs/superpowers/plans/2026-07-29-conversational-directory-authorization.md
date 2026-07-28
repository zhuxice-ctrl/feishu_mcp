# Conversational Directory Authorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow the authenticated `owner` identity to use `F:\` by default and approve other local directories directly through Feishu MCP `input_required`, with once/session/permanent decisions and automatic retry of the original tool.

**Architecture:** Keep the existing 21-tool MCP surface. Add a per-user directory grant store and a directory-specific MRTR approval coordinator, then refactor path validation into a pure boundary inspector plus an asynchronous batch authorization layer used by every path-bearing tool. Preserve `ALLOWED_DIRS` compatibility, make `OWNER_DEFAULT_DIRS` owner-only, and hard-protect only the MCP approval data directory.

**Tech Stack:** Node.js 20+, TypeScript 5.7, MCP TypeScript SDK v2 beta, Express, Zod 4, Node test runner, PowerShell, Python 3.11, ngrok 3.

---

## Working Rules

- Read the approved design first: `docs/superpowers/specs/2026-07-29-conversational-directory-authorization-design.md`.
- Start from branch `codex/conversational-directory-authorization-plan` commit containing this plan; create an implementation branch such as `kimi/conversational-directory-authorization`.
- Never print or commit `.env`, PIN, Bearer Token, approval signing secret, ngrok credentials, request state, or real permanent directory records.
- Tests use generated identities and temporary directories only. They must not read or modify real files under `C:\`, `D:\`, `F:\`, `%USERPROFILE%`, or `%LOCALAPPDATA%`.
- Run `npm run build` before focused Node tests because tests import `dist/`.
- Follow TDD: add a failing test, run it and observe the expected failure, implement the smallest coherent behavior, rerun, then commit.
- Do not change the public tool list. `tools/list` must remain exactly 21 tools.
- Do not weaken the hard denial for `APPROVAL_DATA_DIR` or its descendants.
- Do not add a terminal, browser, query-string, or plain-text approval fallback.
- Do not force-push or rewrite `main` history.

## File Map

### New source files

- `src/security/directoryRoots.ts` — pure directory normalization, physical resolution, containment and scope inference.
- `src/security/directoryGrantStore.ts` — effective-root computation plus per-user session/permanent directory grants.
- `src/security/directoryAuthorization.ts` — signed Feishu `input_required` directory approval flow.

### New tests

- `test/directory-config.test.mjs`
- `test/directory-roots.test.mjs`
- `test/directory-grant-store.test.mjs`
- `test/directory-authorization.test.mjs`
- `test/directory-path-guard.test.mjs`
- `test/directory-filesystem-tools.test.mjs`
- `test/directory-development-tools.test.mjs`
- `test/directory-authorization-e2e.test.mjs`
- `test/approval-management.test.mjs`
- `test/helpers/mcp-http-fixture.mjs` — reusable local HTTP/MRTR test server fixture.

### Existing files to modify

- `src/config.ts`
- `src/security/approvalState.ts`
- `src/security/approvalStore.ts`
- `src/security/pathGuard.ts`
- `src/security/toolAccess.ts`
- `src/tools/results.ts`
- `src/tools/helpers.ts`
- `src/tools/filesystem.ts`
- `src/tools/command.ts`
- `src/tools/contentSearch.ts`
- `src/tools/git.ts`
- `src/tools/diff.ts`
- `src/tools/patch.ts`
- `src/index.ts`
- `scripts/manage-approvals.ps1`
- `scripts/start-feishu-mcp.ps1`
- `.env.example`
- `README.md`
- `docs/aily-integration-guide.md`
- `test/launcher.test.mjs`
- `test/health-concurrency.test.mjs`
- `test/tools-list.test.mjs`
- `test/complete-tools-e2e.test.mjs`
- `test/e2e_test.py`

## Task 1: Owner-Specific Directory Configuration

**Files:**
- Modify: `src/config.ts`
- Modify: `.env.example`
- Create: `test/directory-config.test.mjs`

- [ ] **Step 1: Write failing configuration tests**

Create `test/directory-config.test.mjs`. Use child processes so each case imports a fresh `dist/config.js`:

```js
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const projectDir = path.resolve(import.meta.dirname, "..");

function readConfig(overrides) {
  const source = [
    "const c = await import('./dist/config.js');",
    "process.stdout.write(JSON.stringify({",
    " ownerUserId: c.OWNER_USER_ID,",
    " ownerDefaultDirs: c.OWNER_DEFAULT_DIRS,",
    " allowedDirs: c.ALLOWED_DIRS",
    "}));",
  ].join("\n");
  return spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: projectDir,
    env: {
      ...process.env,
      AUTH_MODE: "none",
      AUTH_PIN: "",
      ALLOWED_DIRS: "",
      OWNER_USER_ID: "",
      OWNER_DEFAULT_DIRS: "",
      ...overrides,
    },
    encoding: "utf8",
  });
}

test("owner defaults are empty unless both settings are configured", () => {
  const empty = readConfig({});
  assert.equal(empty.status, 0, empty.stderr);
  assert.deepEqual(JSON.parse(empty.stdout), {
    ownerUserId: "",
    ownerDefaultDirs: [],
    allowedDirs: [],
  });

  const missingIdentity = readConfig({ OWNER_DEFAULT_DIRS: "F:\\" });
  assert.notEqual(missingIdentity.status, 0);
  assert.match(missingIdentity.stderr, /OWNER_USER_ID.*required/i);
});

test("path lists trim, resolve and deduplicate case-insensitively on Windows", () => {
  const result = readConfig({
    OWNER_USER_ID: "owner",
    OWNER_DEFAULT_DIRS: process.platform === "win32" ? "F:\\,f:\\" : "/tmp,/tmp",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ownerDefaultDirs.length, 1);
});
```

- [ ] **Step 2: Build and verify the expected failure**

Run:

```powershell
npm run build
node --test test/directory-config.test.mjs
```

Expected: FAIL because `OWNER_USER_ID` and `OWNER_DEFAULT_DIRS` are not exported.

- [ ] **Step 3: Implement shared path-list parsing**

In `src/config.ts`, replace the one-off `rawDirs` pipeline with a reusable parser and export the new settings:

```ts
function envPathList(name: string): string[] {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const raw of (process.env[name] ?? "").split(",")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const resolved = path.resolve(trimmed);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(resolved);
  }
  return values;
}

export const ALLOWED_DIRS = envPathList("ALLOWED_DIRS");
export const OWNER_USER_ID = process.env.OWNER_USER_ID?.trim() ?? "";
export const OWNER_DEFAULT_DIRS = envPathList("OWNER_DEFAULT_DIRS");

if (OWNER_DEFAULT_DIRS.length > 0 && !OWNER_USER_ID) {
  throw new Error("OWNER_USER_ID is required when OWNER_DEFAULT_DIRS is configured");
}
```

Do not assign `owner` or `F:\` as code defaults. They are deployment configuration, not universal package behavior.

- [ ] **Step 4: Document the new environment values**

Add to `.env.example`:

```env
# Optional device-owner identity and owner-only default roots.
# For this deployment: OWNER_USER_ID=owner and OWNER_DEFAULT_DIRS=F:\
OWNER_USER_ID=
OWNER_DEFAULT_DIRS=
```

- [ ] **Step 5: Run focused checks**

Run:

```powershell
npm run build
node --test test/directory-config.test.mjs test/security-auth.test.mjs
npm run typecheck
```

Expected: all tests PASS and typecheck exits 0.

- [ ] **Step 6: Commit**

```powershell
git add src/config.ts .env.example test/directory-config.test.mjs
git commit -m "feat: add owner-specific directory configuration"
```

## Task 2: Directory Roots and Persistent Grant Store

**Files:**
- Create: `src/security/directoryRoots.ts`
- Create: `src/security/directoryGrantStore.ts`
- Create: `test/directory-roots.test.mjs`
- Create: `test/directory-grant-store.test.mjs`

- [ ] **Step 1: Write failing root-normalization tests**

Create `test/directory-roots.test.mjs` using temporary directories. Cover existing files, existing directories, missing write targets, case-insensitive Windows containment, and symlink/junction resolution:

```js
test("file requests infer the containing directory and bind the physical path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "directory-root-"));
  try {
    const file = path.join(root, "project", "file.txt");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "x");
    const scope = canonicalizeDirectoryScope(file, "file");
    assert.equal(scope.logicalRoot, path.dirname(file));
    assert.equal(scope.physicalRoot, await realpath(path.dirname(file)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing file binds its requested parent through the nearest real ancestor", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "directory-root-missing-"));
  try {
    const scope = canonicalizeDirectoryScope(
      path.join(root, "new-project", "file.txt"),
      "file",
    );
    assert.equal(scope.logicalRoot, path.join(root, "new-project"));
    assert.equal(scope.physicalRoot, path.join(await realpath(root), "new-project"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Write failing store tests**

Create `test/directory-grant-store.test.mjs`:

```js
test("effective roots combine global, owner, session and permanent sources by user", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "directory-grants-"));
  try {
    const makeScope = (name) => ({
      logicalRoot: path.join(dataDir, name),
      physicalRoot: path.join(dataDir, name),
    });
    const store = new DirectoryGrantStore({
      dataDir,
      staticRoots: [makeScope("static")],
      ownerUserId: "owner",
      ownerRoots: [makeScope("owner")],
    });
    store.rememberSessionBatch("owner", [makeScope("session")]);
    store.rememberPermanentBatch("owner", [makeScope("permanent")]);

    assert.deepEqual(
      store.effectiveRoots("owner").map((item) => item.source),
      ["static", "owner_default", "session", "permanent"],
    );
    assert.deepEqual(
      store.effectiveRoots("other").map((item) => item.source),
      ["static"],
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("permanent grants reload and revoke by id without leaking across users", async () => {
  const projectRoot = {
    logicalRoot: path.join(dataDir, "project"),
    physicalRoot: path.join(dataDir, "project"),
  };
  const projectFile = path.join(projectRoot.physicalRoot, "file.txt");
  const options = {
    dataDir,
    staticRoots: [],
    ownerUserId: "owner",
    ownerRoots: [],
  };
  const store = new DirectoryGrantStore(options);
  const [record] = store.rememberPermanentBatch("owner", [projectRoot]);
  const reloaded = new DirectoryGrantStore(options);
  assert.equal(reloaded.hasAccess("owner", projectFile), true);
  assert.equal(reloaded.hasAccess("other", projectFile), false);
  assert.equal(reloaded.revoke(record.id), true);
  assert.equal(reloaded.hasAccess("owner", projectFile), false);
});
```

Also assert a two-root permanent batch either commits both records or leaves the old JSON byte-identical, a session batch becomes visible only after the whole batch validates, session grants disappear with a fresh instance, duplicates collapse by physical root, malformed on-disk records fail closed, and `summary()` exposes counts only.

- [ ] **Step 3: Verify missing-module failures**

Run:

```powershell
npm run build
node --test test/directory-roots.test.mjs test/directory-grant-store.test.mjs
```

Expected: FAIL because both modules are missing.

- [ ] **Step 4: Implement pure root utilities**

Create `src/security/directoryRoots.ts` with these public contracts:

```ts
import fs from "node:fs";
import path from "node:path";

export type DirectoryScopeKind = "file" | "directory";

export interface CanonicalDirectoryRoot {
  logicalRoot: string;
  physicalRoot: string;
}

export function pathKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function isInsideDirectory(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolveThroughExistingAncestor(candidate: string): string {
  let cursor = path.resolve(candidate);
  const missing: string[] = [];
  for (;;) {
    try {
      fs.lstatSync(cursor);
      return path.resolve(fs.realpathSync(cursor), ...missing);
    } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new Error(`No existing ancestor for ${candidate}`);
      missing.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

export function canonicalizeDirectoryScope(
  candidate: string,
  kind: DirectoryScopeKind,
): CanonicalDirectoryRoot {
  const absolute = path.resolve(candidate);
  const logicalRoot = kind === "file" ? path.dirname(absolute) : absolute;
  return {
    logicalRoot,
    physicalRoot: resolveThroughExistingAncestor(logicalRoot),
  };
}
```

Add a `deduplicateRoots()` helper that sorts by `pathKey(logicalRoot)`, removes duplicates by physical root, and returns a fresh array.

- [ ] **Step 5: Implement the directory grant store**

Create `src/security/directoryGrantStore.ts` with focused persistence and no MCP dependencies:

```ts
export type EffectiveRootSource = "static" | "owner_default" | "session" | "permanent";

export interface DirectoryGrantRecord extends CanonicalDirectoryRoot {
  id: string;
  userId: string;
  createdAt: string;
}

export interface EffectiveRoot extends CanonicalDirectoryRoot {
  source: EffectiveRootSource;
}

export interface DirectoryGrantStoreOptions {
  dataDir?: string;
  staticRoots?: CanonicalDirectoryRoot[];
  ownerUserId?: string;
  ownerRoots?: CanonicalDirectoryRoot[];
}

export class DirectoryGrantStore {
  effectiveRoots(userId: string | null): EffectiveRoot[];
  hasAccess(userId: string | null, physicalCandidate: string): boolean;
  rememberSessionBatch(userId: string, roots: CanonicalDirectoryRoot[]): void;
  rememberPermanentBatch(userId: string, roots: CanonicalDirectoryRoot[]): DirectoryGrantRecord[];
  listForUser(userId: string): DirectoryGrantRecord[];
  revoke(id: string): boolean;
  clear(userId?: string): void;
  summary(): { session: number; permanent: number };
}
```

Store permanent records at `path.join(dataDir, "directory-grants.json")`. Validate the complete batch before mutating memory. Use the atomic write pattern already implemented in `src/security/approvalStore.ts`: create the directory with mode `0o700`, open a sibling temporary file with `wx`/`0o600`, write the complete next JSON document, `fsync`, close, rename and best-effort `chmod(0o600)`. Update the in-memory permanent set only after the rename succeeds. Strictly validate the persisted schema and fail closed on malformed records.

Initialize the production singleton from configuration:

```ts
const staticRoots = ALLOWED_DIRS.map((root) => canonicalizeDirectoryScope(root, "directory"));
const ownerRoots = OWNER_DEFAULT_DIRS.map((root) => canonicalizeDirectoryScope(root, "directory"));

export const directoryGrantStore = new DirectoryGrantStore({
  dataDir: APPROVAL_DATA_DIR,
  staticRoots,
  ownerUserId: OWNER_USER_ID,
  ownerRoots,
});
```

- [ ] **Step 6: Run focused tests**

Run:

```powershell
npm run build
node --test test/directory-roots.test.mjs test/directory-grant-store.test.mjs test/approval-store.test.mjs
```

Expected: all tests PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/security/directoryRoots.ts src/security/directoryGrantStore.ts test/directory-roots.test.mjs test/directory-grant-store.test.mjs
git commit -m "feat: add per-user directory grant store"
```

## Task 3: Signed Feishu Directory Approval

**Files:**
- Create: `src/security/directoryAuthorization.ts`
- Modify: `src/security/approvalState.ts`
- Modify: `src/tools/results.ts`
- Create: `test/directory-authorization.test.mjs`

- [ ] **Step 1: Extend the structured error contract in a failing test**

Add these codes to the expected error-code coverage in a new `test/directory-authorization.test.mjs`:

```ts
"DIRECTORY_APPROVAL_DENIED"
"DIRECTORY_GRANT_PERSIST_FAILED"
"DIRECTORY_IDENTITY_REQUIRED"
```

The test must assert `toolError(code, message)` serializes the exact code and remains non-retryable by default.

- [ ] **Step 2: Write failing MRTR tests**

Use `runWithRequestContext()` and a synthetic modern `ServerContext`, following `test/approval-elicitation.test.mjs`:

```js
function context(state, inputResponses, modern = true) {
  return {
    mcpReq: {
      envelope: modern ? {} : undefined,
      requestState: () => state,
      inputResponses,
      signal: new AbortController().signal,
    },
  };
}

test("outside roots emit one directory input request and allow_once stores nothing", async () => {
  const request = directoryRequest([rootA]);
  const first = await requestDirectoryAuthorization(context(), request, store);
  assert.equal(first.resultType, "input_required");
  assert.deepEqual(Object.keys(first.inputRequests), ["directory_approval"]);

  const verified = await approvalStateCodec.verify(first.requestState, context());
  const second = await requestDirectoryAuthorization(
    context(verified, {
      directory_approval: { action: "accept", content: { decision: "allow_once" } },
    }),
    request,
    store,
  );
  assert.equal(second.allowed, true);
  assert.deepEqual(second.roots, [rootA]);
  assert.equal(second.decision, "allow_once");
  assert.match(second.rootsDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(store.summary(), { session: 0, permanent: 0 });
});
```

Define `directoryRequest`, `rootA`, the isolated store, and a `runWithRequestContext()` wrapper locally in this test file before using them. Implement the remaining cases as an explicit table and assert each expected terminal result:

```js
const decisionCases = [
  ["allow_session", { action: "accept", content: { decision: "allow_session" } }, "allowed", { session: 1, permanent: 0 }],
  ["allow_permanent", { action: "accept", content: { decision: "allow_permanent" } }, "allowed", { session: 0, permanent: 1 }],
  ["deny", { action: "accept", content: { decision: "deny" } }, "DIRECTORY_APPROVAL_DENIED", { session: 0, permanent: 0 }],
  ["cancel", { action: "cancel" }, "DIRECTORY_APPROVAL_DENIED", { session: 0, permanent: 0 }],
  ["timeout", undefined, "DIRECTORY_APPROVAL_DENIED", { session: 0, permanent: 0 }],
];
```

For unsupported clients expect `CLIENT_ELICITATION_UNSUPPORTED`; for missing identity expect `DIRECTORY_IDENTITY_REQUIRED`. Mutate exactly one of `userId`, `tool`, `argsDigest`, `logicalRoot`, `physicalRoot` and `nonce` per test and expect `APPROVAL_DENIED`; replay the unchanged accepted state and expect the same denial.

- [ ] **Step 3: Verify expected failures**

Run:

```powershell
npm run build
node --test test/directory-authorization.test.mjs
```

Expected: FAIL because the coordinator and error codes do not exist.

- [ ] **Step 4: Add directory error codes**

Extend `ToolErrorCode` in `src/tools/results.ts` with exactly:

```ts
| "DIRECTORY_APPROVAL_DENIED"
| "DIRECTORY_GRANT_PERSIST_FAILED"
| "DIRECTORY_IDENTITY_REQUIRED"
```

- [ ] **Step 5: Define a directory request-state payload**

In `src/security/approvalState.ts`, make the codec accept a union while preserving all existing operation/ask-user behavior:

```ts
export interface DirectoryApprovalStatePayload {
  version: 1;
  kind: "directory";
  tool: string;
  userId: string;
  argsDigest: string;
  rootsDigest: string;
  nonce: string;
}

export interface ApprovalStatePayload {
  version: 1;
  tool: string;
  userId: string | null;
  subjectKey: string;
  argsDigest: string;
  nonce: string;
  priorSubjectKeys?: string[];
  authorizedDirectoryRootsDigest?: string;
}

export type SignedRequestStatePayload = ApprovalStatePayload | DirectoryApprovalStatePayload;

export const approvalStateCodec = createRequestStateCodec<SignedRequestStatePayload>({
  key: loadOrCreateApprovalKey(),
  ttlSeconds: Math.ceil(APPROVAL_TIMEOUT_MS / 1000),
  bind: () => getRequestUserId() ?? "__anonymous__",
});

export function mintApprovalState(
  payload: SignedRequestStatePayload,
  ctx?: ServerContext,
): Promise<string> {
  return approvalStateCodec.mint(payload, ctx);
}
```

Do not alter the existing `ApprovalStatePayload` fields or version.

- [ ] **Step 6: Implement `requestDirectoryAuthorization`**

Create `src/security/directoryAuthorization.ts`:

```ts
export interface DirectoryAuthorizationRequest {
  tool: string;
  userId: string | null;
  argsDigest: string;
  access: "read" | "write" | "search" | "command" | "git" | "patch";
  roots: CanonicalDirectoryRoot[];
}

export interface DirectoryAuthorizationAllowed {
  allowed: true;
  roots: CanonicalDirectoryRoot[];
  rootsDigest: string;
  decision: "allow_once" | "allow_session" | "allow_permanent" | "remembered";
}

export type DirectoryAuthorizationOutcome =
  | DirectoryAuthorizationAllowed
  | CallToolResult
  | InputRequiredResult;
```

Use this decision schema:

```ts
const directoryDecisionSchema = z.object({
  decision: z.enum(["allow_once", "allow_session", "allow_permanent", "deny"]),
});
```

Compute `rootsDigest` from a canonical JSON representation of sorted pairs `{ logicalRoot, physicalRoot }`. On the first round, return `inputRequired` with key `directory_approval`. On retry, require a non-null user, compare all signed fields, consume the shared signed nonce, and use the store's batch methods for session/permanent decisions. Persist the complete permanent batch before returning success and convert persistence exceptions into `DIRECTORY_GRANT_PERSIST_FAILED`; no failed decision may leave a subset authorized.

At entry, if every requested root is already covered by the store, return `{ allowed: true, roots, rootsDigest, decision: "remembered" }` without minting state. Return `rootsDigest` for every allowed decision so downstream operation approvals can carry an `allow_once` predecessor safely.

Render the card without logging roots:

```ts
function renderDirectoryMessage(request: DirectoryAuthorizationRequest): string {
  return [
    `Authorize directory access for ${request.tool}?`,
    `Access type: ${request.access}`,
    ...request.roots.map((root, index) => `Directory ${index + 1}: ${root.logicalRoot}`),
    "Allow once: this original tool call only.",
    "Allow session: until this MCP process stops.",
    "Allow permanently: survives restarts until locally revoked.",
    "Deny: do not run the operation.",
    "Permanent approval expands local filesystem access for this user.",
  ].join("\n");
}
```

If `ctx.mcpReq.envelope` is absent, return `CLIENT_ELICITATION_UNSUPPORTED`. If `userId` is null, return `DIRECTORY_IDENTITY_REQUIRED` before minting state.

- [ ] **Step 7: Run approval tests**

Run:

```powershell
npm run build
node --test test/directory-authorization.test.mjs test/approval-elicitation.test.mjs test/approval-state.test.mjs test/ask-user.test.mjs
```

Expected: all tests PASS, including unchanged operation approvals and `ask_user`.

- [ ] **Step 8: Commit**

```powershell
git add src/security/directoryAuthorization.ts src/security/approvalState.ts src/tools/results.ts test/directory-authorization.test.mjs
git commit -m "feat: add signed directory approvals"
```

## Task 4: Dynamic Path Boundary and Batch Authorization

**Files:**
- Modify: `src/security/pathGuard.ts`
- Modify: `src/security/approval.ts`
- Modify: `src/security/approvalStore.ts`
- Modify: `src/security/toolAccess.ts`
- Modify: `src/tools/helpers.ts`
- Create: `test/directory-path-guard.test.mjs`
- Modify: `test/path-guard.test.mjs`
- Modify: `test/approval-elicitation.test.mjs`

- [ ] **Step 1: Write failing effective-root and internal-path tests**

Create `test/directory-path-guard.test.mjs`:

```js
test("owner defaults apply only to the configured owner", () => {
  const owner = inspectPathBoundary(fileInOwnerRoot, "owner", store);
  const other = inspectPathBoundary(fileInOwnerRoot, "other", store);
  assert.equal(owner.status, "allowed");
  assert.equal(owner.matchedRoot.source, "owner_default");
  assert.equal(other.status, "outside");
});

test("approval data is denied before any directory approval request", async () => {
  const inspected = inspectPathBoundary(path.join(dataDir, "approval.key"), "owner", store);
  assert.deepEqual(inspected, {
    status: "denied",
    code: "SENSITIVE_PATH",
    message: "The internal approval directory is protected.",
  });
});
```

Add tests for relative paths resolving against the first effective root, owner `F:\` semantics using temporary roots instead of the real drive, session/permanent roots, physical symlink escape, and a grant whose logical root points through a junction.

- [ ] **Step 2: Write failing batch authorization tests**

Test one and multiple requests with an injectable fake authorization function:

```js
test("batch authorization requests every outside scope before returning any path", async () => {
  const requested = [];
  const inputRequiredResult = {
    resultType: "input_required",
    inputRequests: { directory_approval: { method: "elicitation/create", params: {} } },
    requestState: "signed-state",
  };
  const result = await resolvePathsGuardAndAuthorize(
    "move_file",
    [
      { argName: "source", inputPath: source, operation: "write", scope: "file" },
      { argName: "destination", inputPath: destination, operation: "write", scope: "file" },
    ],
    { source, destination },
    context(),
    { authorize: async (request) => { requested.push(request); return inputRequiredResult; } },
  );
  assert.equal(result.ok, false);
  assert.equal(result.result, inputRequiredResult);
  assert.equal(requested[0].roots.length, 2);
});
```

Extend `test/approval-elicitation.test.mjs` with a predecessor-chain regression:

```js
const directoryStatePayload = (overrides = {}) => ({
  version: 1,
  kind: "directory",
  tool: "execute_command",
  userId: "owner",
  argsDigest: "args",
  rootsDigest: "roots",
  nonce: "directory-nonce",
  ...overrides,
});

test("an allow-once directory proof survives one downstream operation approval", async () => {
  const directoryState = directoryStatePayload({
    tool: "execute_command",
    userId: "owner",
    argsDigest: "args",
    rootsDigest: "roots",
    nonce: "directory-nonce",
  });
  consumeSignedNonce(directoryState.nonce);

  const first = await requestApproval(context(directoryState), {
    tool: "execute_command",
    userId: "owner",
    subject: { kind: "command", key: "command", display: "node --version" },
    argsDigest: "args",
    reasons: ["Interpreter execution requires approval."],
    authorizedDirectoryRootsDigest: "roots",
  });
  assert.equal(first.resultType, "input_required");
  const next = await approvalStateCodec.verify(first.requestState, context());
  assert.equal(next.authorizedDirectoryRootsDigest, "roots");
  assert.notEqual(next.nonce, directoryState.nonce);
});
```

Use this mutation table for negative cases and assert every call returns `APPROVAL_DENIED`:

```js
const predecessorMutations = [
  { userId: "other" },
  { tool: "read_file" },
  { argsDigest: "changed-args" },
  { rootsDigest: "changed-roots" },
];
```

- [ ] **Step 3: Verify failures before refactor**

Run:

```powershell
npm run build
node --test test/directory-path-guard.test.mjs test/path-guard.test.mjs
```

Expected: FAIL because dynamic inspection and batch authorization do not exist.

- [ ] **Step 4: Refactor `pathGuard.ts` into pure inspection**

Export these contracts:

```ts
export interface AllowedPathInspection {
  status: "allowed";
  logicalPath: string;
  physicalPath: string;
  matchedRoot: EffectiveRoot;
}

export interface OutsidePathInspection {
  status: "outside";
  logicalPath: string;
  physicalPath: string;
}

export interface DeniedPathInspection {
  status: "denied";
  code: "SENSITIVE_PATH" | "OUTSIDE_ALLOWED_DIRS";
  message: string;
}

export type PathBoundaryInspection =
  | AllowedPathInspection
  | OutsidePathInspection
  | DeniedPathInspection;

export function inspectPathBoundary(
  inputPath: string,
  userId = getRequestUserId(),
  store = directoryGrantStore,
): PathBoundaryInspection;

export function inspectPathBoundaryWithAdditionalRoots(
  inputPath: string,
  additionalRoots: CanonicalDirectoryRoot[],
  userId?: string | null,
  store?: DirectoryGrantStore,
): PathBoundaryInspection;
```

Resolve relative paths against `store.effectiveRoots(userId)[0]?.logicalRoot`. Always check `isInternalApprovalPath()` for both logical and physical candidates before evaluating ordinary roots. Compare physical candidates to physical effective roots.

Keep `validatePath()` as a backwards-compatible synchronous wrapper for unchanged internal callers, but make it consult current request identity and effective roots. It must never trigger approval itself.

- [ ] **Step 5: Add batch path authorization in `helpers.ts`**

Define:

```ts
export interface PathAccessRequest {
  argName: string;
  inputPath: string;
  operation: "read" | "write";
  scope: "file" | "directory";
  access?: DirectoryAuthorizationRequest["access"];
}

export interface AuthorizedPath {
  argName: string;
  inputPath: string;
  resolvedPath: string;
  boundarySource: EffectiveRootSource | "allow_once";
}

export interface DirectoryAuthorizationProof {
  rootsDigest: string;
  source: "owner_default" | "session" | "permanent" | "allow_once";
}

export async function resolvePathsGuardAndAuthorize(
  toolName: string,
  requests: PathAccessRequest[],
  args: unknown,
  ctx: ServerContext,
  deps: {
    authorize?: typeof requestDirectoryAuthorization;
    store?: DirectoryGrantStore;
  } = {},
): Promise<
  | { ok: true; paths: AuthorizedPath[]; directoryProof?: DirectoryAuthorizationProof }
  | { ok: false; error?: string; result?: CallToolResult | InputRequiredResult }
>;
```

Algorithm:

```ts
const initial = requests.map((request) => inspectPathBoundary(request.inputPath));
const hardDenial = initial.find((item) => item.status === "denied");
if (hardDenial?.status === "denied") {
  return { ok: false, result: toolError(hardDenial.code, hardDenial.message) };
}

const outsideRoots = deduplicateRoots(
  initial.flatMap((item, index) =>
    item.status === "outside"
      ? [canonicalizeDirectoryScope(item.logicalPath, requests[index].scope)]
      : [],
  ),
);

let ephemeralRoots: CanonicalDirectoryRoot[] = [];
if (outsideRoots.length > 0) {
  const outcome = await requestDirectoryAuthorization(ctx, {
    tool: toolName,
    userId: getRequestUserId(),
    argsDigest: digestArguments(args),
    access: requests.some((item) => item.access === "patch") ? "patch"
      : requests.some((item) => item.access === "command") ? "command"
      : requests.some((item) => item.access === "git") ? "git"
      : requests.some((item) => item.access === "write") ? "write"
      : requests.some((item) => item.access === "search") ? "search"
      : "read",
    roots: outsideRoots,
  });
  if (!("allowed" in outcome)) return { ok: false, result: outcome };
  ephemeralRoots = outcome.roots;
}

const verified = requests.map((request) =>
  inspectPathBoundaryWithAdditionalRoots(request.inputPath, ephemeralRoots),
);
if (!verified.every((item) => item.status === "allowed")) {
  return { ok: false, error: "Directory authorization did not cover every physical target." };
}
```

Use `deps.authorize ?? requestDirectoryAuthorization` and `deps.store ?? directoryGrantStore`; the injectable dependencies are required by the isolated tests above. Populate each successful path's `boundarySource` from the matched effective root, or `"allow_once"` for a current-call ephemeral root. Only after every path is allowed should the function call `checkFileAccess()` for each target. Any failure returns before the caller performs work.

Make existing `resolveGuardAndAuthorize()` a one-request adapter around `resolvePathsGuardAndAuthorize()` so single-path tools remain concise.

- [ ] **Step 6: Prevent duplicate absolute-path approval**

Modify `authorizeFilePath()` in `src/security/toolAccess.ts` to accept an optional boundary source:

```ts
export async function authorizeFilePath(
  toolName: string,
  argName: string,
  rawPath: string,
  resolvedPath: string,
  args: unknown,
  ctx: ServerContext,
  options: { directoryAuthorized?: boolean } = {},
): Promise<ApprovalOutcome> {
  const kinds = inspectPath(toolName, rawPath, resolvedPath)
    .filter((kind) => !(options.directoryAuthorized && kind === "absolute_path"));
  // preserve the existing sensitive-file policy for remaining kinds
}
```

Treat paths whose `boundarySource` is `owner_default`, `session`, `permanent`, or `allow_once` as `directoryAuthorized=true`. Preserve current static `ALLOWED_DIRS` consent behavior for backwards compatibility.

For `allow_once`, include `{ rootsDigest: outcome.rootsDigest, source: "allow_once" }` in the successful batch result. When `authorizeFilePath()` or command-risk approval needs another card, pass this proof into `requestApproval()` as `authorizedDirectoryRootsDigest`.

Extend `ApprovalRequest` in `src/security/approval.ts`:

```ts
export interface ApprovalRequest {
  tool: string;
  userId: string | null;
  subject: { kind: ApprovalSubjectKind; key: string; display: string };
  argsDigest: string;
  reasons: string[];
  priorSubjectKeys?: string[];
  authorizedDirectoryRootsDigest?: string;
}
```

When the current signed state is a consumed `DirectoryApprovalStatePayload` whose user/tool/args/root digest matches this predecessor field, `requestApproval()` must mint a fresh operation approval state carrying `authorizedDirectoryRootsDigest` instead of rejecting the predecessor as a state mismatch. This is the only valid transition from an already-consumed directory nonce. On the next retry, the path layer recomputes the canonical outside-root digest and may use those exact roots as ephemeral roots only when the signed operation state has matching user/tool/args/digest fields; the normal operation approval then consumes its own fresh nonce. A changed root set, missing digest, stale state, or replay fails with `APPROVAL_DENIED`. Never put this proof into `DirectoryGrantStore`.

- [ ] **Step 7: Run focused guard tests**

Run:

```powershell
npm run build
node --test test/directory-path-guard.test.mjs test/path-guard.test.mjs test/approval-elicitation.test.mjs test/consent-terminal.test.mjs
```

Expected: all tests PASS and no production test reads stdin.

- [ ] **Step 8: Commit**

```powershell
git add src/security/pathGuard.ts src/security/approval.ts src/security/approvalStore.ts src/security/toolAccess.ts src/tools/helpers.ts test/directory-path-guard.test.mjs test/path-guard.test.mjs test/approval-elicitation.test.mjs
git commit -m "feat: authorize dynamic directory boundaries"
```

## Task 5: Filesystem Tool Integration

**Files:**
- Modify: `src/tools/filesystem.ts`
- Create: `test/helpers/mcp-http-fixture.mjs`
- Create: `test/directory-filesystem-tools.test.mjs`
- Modify: `test/tools-list.test.mjs`

- [ ] **Step 1: Write failing real-tool tests**

Create `test/helpers/mcp-http-fixture.mjs` so all new E2E-style tests use the same correct modern envelope:

```js
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";

const projectDir = path.resolve(import.meta.dirname, "..", "..");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) =>
    server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

function parseMcp(text) {
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("data:")) return JSON.parse(line.slice(5).trim());
  }
  return JSON.parse(text);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

export function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function startMcpFixture({
  allowedDirs = "",
  ownerUserId = "owner",
  ownerDefaultDirs = "",
  approvalDataDir,
  userId = "owner",
  env = {},
}) {
  const port = await freePort();
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: projectDir,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      AUTH_MODE: "none",
      AUTH_PIN: "",
      MCP_AUTH_TOKEN: "",
      AUTH_USER_HEADER: "x-test-user",
      ALLOWED_DIRS: allowedDirs,
      OWNER_USER_ID: ownerUserId,
      OWNER_DEFAULT_DIRS: ownerDefaultDirs,
      APPROVAL_DATA_DIR: approvalDataDir,
      APPROVAL_STATE_SECRET: "0123456789abcdef0123456789abcdef",
      LOG_LEVEL: "error",
      NGROK_DOMAIN: "",
      ...env,
    },
    stdio: "ignore",
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`${baseUrl}/health`)).ok) break; } catch {}
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  let id = 0;
  async function rpc(method, params, modern = false) {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-test-user": userId,
    };
    let requestParams = params;
    if (modern) {
      headers["mcp-protocol-version"] = "2026-07-28";
      headers["mcp-method"] = method;
      if (method === "tools/call") headers["mcp-name"] = params.name;
      requestParams = {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } },
          "io.modelcontextprotocol/clientInfo": { name: "directory-test", version: "1.0.0" },
        },
      };
    }
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: requestParams }),
    });
    const payload = parseMcp(await response.text());
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.error, undefined, JSON.stringify(payload));
    return payload.result;
  }

  const callModern = (name, args) =>
    rpc("tools/call", { name, arguments: args }, true);
  const retryModern = (name, args, initial, inputResponses) =>
    rpc("tools/call", {
      name,
      arguments: args,
      requestState: initial.requestState,
      inputResponses,
    }, true);

  return {
    child,
    baseUrl,
    rpc,
    callModern,
    retryModern,
    stop: () => stopChild(child),
  };
}
```

Create `test/directory-filesystem-tools.test.mjs` using a static allowed root plus a separate outside temporary project. Authenticate as `owner` and test:

```js
test("read_file approves an outside parent and automatically retries", async () => {
  const first = await fixture.callModern("read_file", { path: outsideFile });
  assert.equal(first.resultType, "input_required");
  assert.match(first.inputRequests.directory_approval.params.message, /read_file/);
  assert.match(first.inputRequests.directory_approval.params.message, new RegExp(escapeRegex(path.dirname(outsideFile))));

  const second = await fixture.retryModern("read_file", { path: outsideFile }, first, {
    directory_approval: { action: "accept", content: { decision: "allow_once" } },
  });
  assert.equal(second.content[0].text, "outside content");
});
```

Drive the remaining tool cases from this exact table; the expected scope is what the card must display:

```js
const cases = [
  ["write_file", { path: outsideFile, content: "new" }, path.dirname(outsideFile)],
  ["create_directory", { path: outsideDirectory }, outsideDirectory],
  ["list_directory", { path: outsideDirectory }, outsideDirectory],
  ["search_files", { path: outsideDirectory, pattern: "*.txt" }, outsideDirectory],
  ["get_file_info", { path: outsideFile }, path.dirname(outsideFile)],
];
```

For each case, first assert `input_required`, then retry with `allow_once` and assert the tool's real success result. For `move_file`, use two different outside parent directories and assert both appear in one card. Retry that card with `deny` and assert source/destination bytes are unchanged. Repeat a read with `allow_session` and assert the second call has no card; repeat with `allow_permanent`, restart the fixture with the same approval data directory, and assert no card. Call `list_allowed_directories` as `owner` and `other` and assert only `owner` sees owner/session/permanent roots.

- [ ] **Step 2: Verify existing tools return outside errors**

Run:

```powershell
npm run build
node --test test/directory-filesystem-tools.test.mjs
```

Expected: FAIL because current tools return `OUTSIDE_ALLOWED_DIRS`/plain path errors instead of `input_required`.

- [ ] **Step 3: Migrate all single-path filesystem tools**

For `read_file`, `write_file`, `edit_file`, `create_directory`, `list_directory`, `search_files`, and `get_file_info`, call the one-path adapter with an explicit scope:

```ts
const guard = await resolveGuardAndAuthorize(
  "read_file",
  "path",
  args.path,
  "read",
  args,
  ctx,
  { scope: "file", access: "read" },
);
if (!guard.ok) return guard.result ?? errorResult(guard.error ?? "Invalid path");
```

Use `scope: "directory"` for directory and search roots. Do not authorize after reading metadata or contents; authorization remains before filesystem work.

- [ ] **Step 4: Batch-authorize `move_file`**

Replace the two sequential guards with one all-or-nothing call:

```ts
const guarded = await resolvePathsGuardAndAuthorize(
  "move_file",
  [
    { argName: "source", inputPath: args.source, operation: "write", scope: "file", access: "write" },
    { argName: "destination", inputPath: args.destination, operation: "write", scope: "file", access: "write" },
  ],
  args,
  ctx,
);
if (!guarded.ok) return guarded.result ?? errorResult(guarded.error ?? "Invalid paths");
const src = guarded.paths.find((item) => item.argName === "source")!.resolvedPath;
const dst = guarded.paths.find((item) => item.argName === "destination")!.resolvedPath;
```

Keep all existing rollback/trash behavior unchanged.

- [ ] **Step 5: Return effective roots from `list_allowed_directories`**

Replace the static `getAllowedDirectories()` call with a per-user view:

```ts
const roots = directoryGrantStore.effectiveRoots(getRequestUserId());
const visible = roots.map((item) => ({ path: item.logicalRoot, source: item.source }));
return toolJson({ ok: true, directories: visible, count: visible.length });
```

Preserve a readable text block in `content[0].text`, one root per line, so existing agents remain usable.

- [ ] **Step 6: Assert the public tool count is unchanged**

In `test/tools-list.test.mjs`, keep the exact existing 21-name array and add:

```js
assert.equal(tools.length, 21);
assert.equal(tools.some((tool) => tool.name === "request_directory_access"), false);
```

- [ ] **Step 7: Run filesystem tests**

Run:

```powershell
npm run build
node --test test/directory-filesystem-tools.test.mjs test/atomic-write.test.mjs test/path-guard.test.mjs test/tools-list.test.mjs
```

Expected: all tests PASS.

- [ ] **Step 8: Commit**

```powershell
git add src/tools/filesystem.ts test/helpers/mcp-http-fixture.mjs test/directory-filesystem-tools.test.mjs test/tools-list.test.mjs
git commit -m "feat: approve directories from filesystem tools"
```

## Task 6: Command, Search, Git, Diff, and Patch Integration

**Files:**
- Modify: `src/tools/command.ts`
- Modify: `src/tools/contentSearch.ts`
- Modify: `src/tools/git.ts`
- Modify: `src/tools/diff.ts`
- Modify: `src/tools/patch.ts`
- Create: `test/directory-development-tools.test.mjs`
- Modify: `test/command-tool.test.mjs`
- Modify: `test/content-search.test.mjs`
- Modify: `test/git-tools.test.mjs`
- Modify: `test/diff-tool.test.mjs`
- Modify: `test/patch-tool.test.mjs`

- [ ] **Step 1: Write failing command/search/Git/diff tests**

Create `test/directory-development-tools.test.mjs` with temporary inside/outside roots. Define local `context`, `retry`, and `countRenderedDirectories` helpers (or import them from `test/helpers/mcp-http-fixture.mjs`) before use. Include these exact core tests:

```js
test("execute_command requests directory approval before command-risk approval", async () => {
  const first = await executeCommand({ command: "node --version", workdir: outside }, context());
  assert.equal(first.resultType, "input_required");
  assert.deepEqual(Object.keys(first.inputRequests), ["directory_approval"]);

  const afterDirectory = await retry(first, "allow_once");
  assert.equal(afterDirectory.resultType, "input_required");
  assert.deepEqual(Object.keys(afterDirectory.inputRequests), ["approval"]);
});

test("compare_files requests both outside parents in one card", async () => {
  const result = await compareFiles({ path_a: first, path_b: second }, context());
  assert.equal(result.resultType, "input_required");
  assert.equal(countRenderedDirectories(result), 2);
});
```

Add `search_content`, `git_status`, `git_diff`, an outside Git file filter, and session/permanent reuse. Assert no process starts before directory approval.

- [ ] **Step 2: Write failing multi-file patch tests**

Add a patch with targets in two separate outside directories. Assert the first result contains both roots and that denying leaves both directories byte-identical. Add a retry test that allows once and applies the entire transaction.

- [ ] **Step 3: Verify expected failures**

Run:

```powershell
npm run build
node --test test/directory-development-tools.test.mjs test/command-tool.test.mjs test/patch-tool.test.mjs
```

Expected: FAIL because these tools still reject outside roots before elicitation.

- [ ] **Step 4: Integrate `execute_command`**

Before command classification approval and before `fs.statSync(workdir)`, resolve the workdir through the new helper:

```ts
const workdirGuard = await resolvePathsGuardAndAuthorize(
  "execute_command",
  [{
    argName: "workdir",
    inputPath: requestedWorkdir,
    operation: "read",
    scope: "directory",
    access: "command",
  }],
  args,
  ctx,
);
if (!workdirGuard.ok) {
  return workdirGuard.result ?? toolError("OUTSIDE_ALLOWED_DIRS", workdirGuard.error ?? "Invalid workdir");
}
const workdir = workdirGuard.paths[0].resolvedPath;
```

Then run the existing command-risk approval. The MRTR chain may legitimately show directory approval followed by command approval; keep both signed states independently replay-safe.

- [ ] **Step 5: Integrate search and Git**

- `search_content`: authorize the search root with `scope: "directory"`, `access: "search"` before traversal.
- `git_status`/`git_diff`: authorize repository root with `scope: "directory"`, `access: "git"` before invoking Git.
- `git_diff.file`: validate the file inside the already authorized repository; do not create a broader root from a repository-relative file.
- Preserve metadata-directory exclusion, sensitive-file skipping, disabled pager and external-diff settings.

Use the exact helper shape:

```ts
const guarded = await resolvePathsGuardAndAuthorize(
  "git_status",
  [{ argName: "path", inputPath: raw, operation: "read", scope: "directory", access: "git" }],
  args,
  ctx,
);
```

- [ ] **Step 6: Batch-authorize file comparison**

Call `resolvePathsGuardAndAuthorize()` once for `path_a` and `path_b`, both with `scope: "file"`, then perform size checks and reads only after the combined result is allowed.

- [ ] **Step 7: Batch-authorize patch targets**

Keep the current sequence “parse first, collect every source/destination, guard all, stage, commit”. Replace per-target static guarding with one batch directory approval before acquiring path locks or staging files:

```ts
const authorization = await resolvePathsGuardAndAuthorize(
  "apply_patch",
  rawTargets.map((target) => ({
    argName: target.role,
    inputPath: target.path,
    operation: "write",
    scope: target.kind === "directory" ? "directory" : "file",
    access: "patch",
  })),
  args,
  ctx,
);
if (!authorization.ok) return authorization.result ?? toolError("OUTSIDE_ALLOWED_DIRS", authorization.error ?? "Invalid targets");
```

The tool must not create temp files, acquire target locks, move trash, or write backups until every directory is authorized.

- [ ] **Step 8: Run development-tool tests**

Run:

```powershell
npm run build
node --test test/directory-development-tools.test.mjs test/command-tool.test.mjs test/content-search.test.mjs test/git-tools.test.mjs test/diff-tool.test.mjs test/patch-tool.test.mjs test/process-runner.test.mjs
```

Expected: all tests PASS.

- [ ] **Step 9: Commit**

```powershell
git add src/tools/command.ts src/tools/contentSearch.ts src/tools/git.ts src/tools/diff.ts src/tools/patch.ts test/directory-development-tools.test.mjs test/command-tool.test.mjs test/content-search.test.mjs test/git-tools.test.mjs test/diff-tool.test.mjs test/patch-tool.test.mjs
git commit -m "feat: approve directories for development tools"
```

## Task 7: Management, Health, Launcher, and Documentation

**Files:**
- Modify: `src/index.ts`
- Modify: `scripts/manage-approvals.ps1`
- Modify: `scripts/start-feishu-mcp.ps1`
- Modify: `README.md`
- Modify: `docs/aily-integration-guide.md`
- Modify: `test/launcher.test.mjs`
- Modify: `test/health-concurrency.test.mjs`
- Create: `test/approval-management.test.mjs`

- [ ] **Step 1: Write failing health tests**

Extend `test/health-concurrency.test.mjs`:

```js
assert.deepEqual(health.directoryAuthorization, {
  enabled: true,
  ownerDefaults: 1,
  session: 0,
  permanent: 0,
  unsupportedClientPolicy: "deny",
});
assert.doesNotMatch(
  JSON.stringify(health),
  /F:\\\\|owner|logicalRoot|physicalRoot|directory-grants\.json/i,
);
```

Use a temporary `OWNER_DEFAULT_DIRS`, not the real `F:\`.

- [ ] **Step 2: Write failing launcher tests**

Extend the launcher fixture with `OWNER_USER_ID=owner`, a temporary `OWNER_DEFAULT_DIRS`, and empty `ALLOWED_DIRS`. Assert `-CheckOnly` succeeds, reports only `ownerDefaultCount`, and does not print owner identity or paths. Add failure cases for owner dirs without identity and both directory lists empty.

- [ ] **Step 3: Write failing approval-management tests**

Create `test/approval-management.test.mjs`. Invoke `scripts/manage-approvals.ps1` against a temporary data directory and assert:

- directory grants can be listed as numbered redacted records;
- a directory grant can be removed by id/number;
- directory grants can be cleared independently;
- operation approvals remain intact when clearing only directory grants;
- output does not contain raw user ids or full paths.

Use this executable fixture rather than the real approval directory:

```js
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const projectDir = path.resolve(import.meta.dirname, "..");
const script = path.join(projectDir, "scripts", "manage-approvals.ps1");

function run(dataDir, ...args) {
  return spawnSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
    "-DataDir", dataDir, ...args,
  ], { cwd: projectDir, encoding: "utf8" });
}

test("directory grants list redacted values and remove independently", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "approval-manager-"));
  const fullPath = path.join(dataDir, "private-project");
  try {
    await writeFile(path.join(dataDir, "directory-grants.json"), JSON.stringify({
      version: 1,
      grants: [{
        id: "11111111-1111-4111-8111-111111111111",
        userId: "owner",
        logicalRoot: fullPath,
        physicalRoot: fullPath,
        createdAt: "2026-07-29T00:00:00.000Z",
      }],
    }), "utf8");
    await writeFile(path.join(dataDir, "approvals.json"), JSON.stringify({
      version: 1,
      approvals: [{ id: "keep-operation-approval" }],
    }), "utf8");

    const listed = run(dataDir, "-ListDirectories");
    assert.equal(listed.status, 0, listed.stderr);
    assert.doesNotMatch(listed.stdout, /owner|private-project/);

    const removed = run(dataDir, "-RemoveDirectory", "11111111");
    assert.equal(removed.status, 0, removed.stderr);
    assert.deepEqual(
      JSON.parse(await readFile(path.join(dataDir, "directory-grants.json"), "utf8")),
      { version: 1, grants: [] },
    );
    assert.match(await readFile(path.join(dataDir, "approvals.json"), "utf8"), /keep-operation-approval/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
```

Add this clear-isolation test:

```js
test("ClearDirectories leaves operation approvals byte-identical", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "approval-manager-clear-"));
  try {
    await writeFile(path.join(dataDir, "directory-grants.json"), JSON.stringify({
      version: 1,
      grants: ["one", "two"].map((name) => ({
        id: `${name}-id`, userId: "owner",
        logicalRoot: path.join(dataDir, name),
        physicalRoot: path.join(dataDir, name),
        createdAt: "2026-07-29T00:00:00.000Z",
      })),
    }), "utf8");
    await writeFile(path.join(dataDir, "approvals.json"), JSON.stringify({
      version: 1, approvals: [{ id: "keep-operation-approval" }],
    }), "utf8");
    const before = await readFile(path.join(dataDir, "approvals.json"));
    const cleared = run(dataDir, "-ClearDirectories");
    assert.equal(cleared.status, 0, cleared.stderr);
    assert.deepEqual(
      JSON.parse(await readFile(path.join(dataDir, "directory-grants.json"), "utf8")),
      { version: 1, grants: [] },
    );
    assert.deepEqual(await readFile(path.join(dataDir, "approvals.json")), before);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 4: Update `/health` and the startup banner**

In `src/index.ts`, add counts only:

```ts
directoryAuthorization: {
  enabled: true,
  ownerDefaults: OWNER_DEFAULT_DIRS.length,
  ...directoryGrantStore.summary(),
  unsupportedClientPolicy: "deny",
},
```

The banner may say:

```ts
`Directory authorization: Feishu input_required (owner defaults ${OWNER_DEFAULT_DIRS.length}, permanent ${directoryGrantStore.summary().permanent})`
```

Do not print `OWNER_USER_ID`, roots, grant ids or store paths.

- [ ] **Step 5: Extend the management script**

Add explicit PowerShell switches without breaking existing ones:

```powershell
param(
    [switch]$List,
    [string]$Remove = "",
    [switch]$Clear,
    [switch]$ListDirectories,
    [string]$RemoveDirectory = "",
    [switch]$ClearDirectories,
    [string]$DataDir = ""
)
```

Read `directory-grants.json`, show index/id prefix, an irreversible SHA-256 user hash prefix, root basename plus drive/volume label only, and creation time. Never print the complete logical/physical path. Use the same atomic rewrite strategy for remove/clear.

- [ ] **Step 6: Update launcher validation**

Change the allowed-root precondition:

```powershell
$allowedDirs = [Environment]::GetEnvironmentVariable("ALLOWED_DIRS", "Process")
$ownerDirs = [Environment]::GetEnvironmentVariable("OWNER_DEFAULT_DIRS", "Process")
$ownerId = [Environment]::GetEnvironmentVariable("OWNER_USER_ID", "Process")

if ([string]::IsNullOrWhiteSpace($allowedDirs) -and [string]::IsNullOrWhiteSpace($ownerDirs)) {
    throw "ALLOWED_DIRS or OWNER_DEFAULT_DIRS must configure at least one directory"
}
if (-not [string]::IsNullOrWhiteSpace($ownerDirs) -and [string]::IsNullOrWhiteSpace($ownerId)) {
    throw "OWNER_USER_ID is required when OWNER_DEFAULT_DIRS is configured"
}
```

In check-mode JSON, report only counts:

```powershell
ownerDefaultCount = @($ownerDirs -split ',' | Where-Object { $_.Trim() }).Count
permanentDirectoryGrantCount = $directoryGrantCount
```

- [ ] **Step 7: Update README and Feishu guide**

Document the exact deployment values without including secrets:

```env
ALLOWED_DIRS=
OWNER_USER_ID=owner
OWNER_DEFAULT_DIRS=F:\
```

Explain that the enterprise-internal MCP tool must remain visible only to the owner because `x-aily-user=owner` is a fixed header. Include the four directory choices, automatic retry, permanent-grant management commands, the sole internal-data exception, and the fact that tools/list remains 21.

- [ ] **Step 8: Run integration/documentation tests**

Run:

```powershell
npm run build
node --test test/launcher.test.mjs test/health-concurrency.test.mjs test/security-auth.test.mjs test/tools-list.test.mjs
npm run typecheck
```

Expected: all tests PASS and output contains no real path or secret.

- [ ] **Step 9: Commit**

```powershell
git add src/index.ts scripts/manage-approvals.ps1 scripts/start-feishu-mcp.ps1 README.md docs/aily-integration-guide.md test/launcher.test.mjs test/health-concurrency.test.mjs test/approval-management.test.mjs
git commit -m "feat: expose conversational directory controls"
```

## Task 8: HTTP, Python, and Real Feishu Acceptance

**Files:**
- Create: `test/directory-authorization-e2e.test.mjs`
- Modify: `test/complete-tools-e2e.test.mjs`
- Modify: `test/e2e_test.py`

- [ ] **Step 1: Add a modern HTTP MRTR E2E test**

Create `test/directory-authorization-e2e.test.mjs` and import `startMcpFixture` from `test/helpers/mcp-http-fixture.mjs`. Use two temporary roots: an owner-default root and an outside root.

Test this exact sequence:

```js
const fixture = await startMcpFixture({
  allowedDirs: "",
  ownerUserId: "owner",
  ownerDefaultDirs: ownerDefaultRoot,
  approvalDataDir,
  userId: "owner",
});

const direct = await fixture.callModern("read_file", { path: ownerDefaultFile });
assert.equal(direct.content[0].text, "owner default");

const first = await fixture.callModern("read_file", { path: outsideFile });
assert.equal(first.resultType, "input_required");

const session = await fixture.retryModern("read_file", { path: outsideFile }, first, {
  directory_approval: { action: "accept", content: { decision: "allow_session" } },
});
assert.equal(session.content[0].text, "outside");

const reused = await fixture.callModern("read_file", { path: outsideFile });
assert.equal(reused.content[0].text, "outside");
await fixture.stop();
```

Then test permanent approval across a server restart using the same generated `APPROVAL_DATA_DIR` and identity, revoke it through the local management script, restart again and assert the card reappears.

- [ ] **Step 2: Add unsupported-client and identity E2E cases**

Send a legacy `tools/call` to an outside root and assert `CLIENT_ELICITATION_UNSUPPORTED`. Send a modern request without the configured identity header and assert `DIRECTORY_IDENTITY_REQUIRED`. Confirm neither request reads the file.

- [ ] **Step 3: Extend complete-tools E2E**

Update `test/complete-tools-e2e.test.mjs` environment to configure a temporary owner default instead of relying only on `ALLOWED_DIRS`. Preserve all existing 21-tool, command, Git, patch, question and web-fetch assertions.

- [ ] **Step 4: Extend Python E2E**

In `test/e2e_test.py`, configure generated temporary values:

```py
env["ALLOWED_DIRS"] = ""
env["OWNER_USER_ID"] = "owner"
env["OWNER_DEFAULT_DIRS"] = WORKSPACE
HEADERS["x-aily-user"] = "owner"
```

Assert health reports one owner default and tools/list still reports 21. Keep secrets generated and redact response details on failure.

- [ ] **Step 5: Run all local verification**

Run:

```powershell
npm run typecheck
npm test
py -3 -u test/e2e_test.py
npm audit --registry=https://registry.npmjs.org --omit=dev
git diff --check
```

Expected: every command exits 0, Node output contains no warnings, and audit reports zero production vulnerabilities.

- [ ] **Step 6: Run the real one-click launcher**

Use generated acceptance directories rather than real user files. Start `start-feishu-mcp.bat`, wait for local health and the fixed ngrok inspector, then verify:

```text
https://reptilian-prenatal-spinster.ngrok-free.dev/health
https://reptilian-prenatal-spinster.ngrok-free.dev/mcp
```

Using configured transport auth and a generated test identity, verify public initialize, exact 21-tool list, owner-default access, outside-directory `input_required`, one approved retry and one denial. Do not print credentials or request state.

- [ ] **Step 7: Verify the actual Feishu card**

From the enterprise-internal MCP tool attached to the private agent:

1. Request a disposable file in a temporary directory outside owner defaults.
2. Confirm the card is produced by the original file tool and uses `directory_approval`, not `ask_user`.
3. Choose session allow and confirm the original operation completes automatically.
4. Repeat and confirm no second directory card appears.
5. Revoke the session by restarting, request again, choose permanent, restart and confirm access persists.
6. Revoke with `manage-feishu-mcp-approvals.bat` and confirm the card returns.

Record only pass/fail and timestamps; do not capture secrets or full permanent paths in committed artifacts.

- [ ] **Step 8: Scan logs and stop cleanly**

Search launcher and operation logs for configured PIN, Bearer Token, approval secret, Authorization header value and generated secrets. Expected matches: zero. Stop with `Q`, require exit code 0, confirm ports 3000 and 4040 are released, and delete only verified disposable test paths.

- [ ] **Step 9: Commit acceptance coverage**

```powershell
git add test/directory-authorization-e2e.test.mjs test/complete-tools-e2e.test.mjs test/e2e_test.py
git commit -m "test: verify conversational directory authorization"
```

## Task 9: Full Review, Publish, and Handoff

**Files:** No source changes expected unless review finds a defect.

- [ ] **Step 1: Confirm a clean, fully tested implementation branch**

Run:

```powershell
git status -sb
git log --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
```

Expected: clean worktree and only the approved directory-authorization implementation, tests and documentation.

- [ ] **Step 2: Review the full branch against the design**

Verify every acceptance criterion in `docs/superpowers/specs/2026-07-29-conversational-directory-authorization-design.md`. Pay special attention to:

- `owner`-only default roots;
- physical-path binding;
- once/session/permanent isolation;
- no partial multi-path operation;
- no access to approval data;
- no duplicate absolute-path card;
- exact 21-tool inventory;
- no raw directories in health/logs;
- no fallback authorization channel.

Any Critical or Important finding must be fixed, covered by a focused regression test and re-reviewed before publishing.

- [ ] **Step 3: Run final acceptance commands once**

```powershell
npm run typecheck
npm test
py -3 -u test/e2e_test.py
npm audit --registry=https://registry.npmjs.org --omit=dev
git diff --check
```

Expected: all exit 0, audit zero vulnerabilities.

- [ ] **Step 4: Publish without rewriting history**

```powershell
git fetch origin main
git merge-base --is-ancestor origin/main HEAD
git push -u origin kimi/conversational-directory-authorization
```

Only after the user authorizes merge and `origin/main` remains an ancestor:

```powershell
git push origin HEAD:main
```

Never use `--force` or `--force-with-lease`.

- [ ] **Step 5: Verify remote state**

```powershell
git fetch origin main
git rev-parse HEAD
git rev-parse origin/main
git ls-remote origin refs/heads/main
```

Expected: all three SHAs are identical after merge.

- [ ] **Step 6: Handoff report**

Report:

- final branch and commit SHA;
- Node and Python test totals;
- audit result;
- real Feishu card result;
- `OWNER_USER_ID` / `OWNER_DEFAULT_DIRS` usage without secret values;
- permanent-directory revocation command;
- confirmation that tools/list remains 21;
- confirmation that ports and disposable artifacts are cleaned.
