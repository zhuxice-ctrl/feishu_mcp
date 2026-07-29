# Legacy Conversational Directory Authorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the private owner-only Feishu agent approve out-of-root directories in conversation even when its MCP client does not support `input_required`, without changing `.env`, restarting, or increasing the 21-tool inventory.

**Architecture:** Keep modern MRTR authorization unchanged. For legacy clients, mint an owner-bound signed directory challenge, submit the user's four-way decision through the existing `auth` tool, and use a short-lived one-shot coordinator for `allow_once` while reusing the existing session/permanent directory store for longer decisions.

**Tech Stack:** Node.js 20+, TypeScript 5.7, MCP TypeScript SDK v2 beta, Zod 4, Express, Node test runner, PowerShell, Python 3.11, ngrok 3.

---

## Global constraints

- Start from `codex/conversational-directory-authorization` after design commit `f09eb98`.
- Do not change the 21-tool public inventory.
- Do not read, print, commit, or expose `.env`, PIN, Bearer Token, approval key, challenge values, or real permanent grants.
- Only `OWNER_USER_ID` may use the fallback, and only when `DIRECTORY_APPROVAL_FALLBACK=owner`.
- Default package behavior remains `deny`.
- Never create a challenge for `APPROVAL_DATA_DIR` or its descendants.
- Modern `input_required` behavior remains unchanged.
- Tests use generated identities and temporary directories only.
- Run `npm run build` before focused Node tests.
- Follow TDD and commit each task separately.

## File map

### New files

- `src/security/legacyDirectoryApproval.ts` — signed legacy challenges, decision submission, and one-shot consumption.
- `test/legacy-directory-approval.test.mjs` — coordinator and auth integration unit tests.
- `test/legacy-directory-authorization-e2e.test.mjs` — legacy HTTP MCP acceptance.

### Existing files to modify

- `src/config.ts`
- `src/security/approvalState.ts`
- `src/security/directoryAuthorization.ts`
- `src/security/directoryRoots.ts`
- `src/auth/authTool.ts`
- `src/auth/pinAuth.ts`
- `src/tools/results.ts`
- `src/index.ts`
- `.env.example`
- `README.md`
- `docs/aily-integration-guide.md`
- `test/directory-config.test.mjs`
- `test/directory-authorization.test.mjs`
- `test/security-auth.test.mjs`
- `test/health-concurrency.test.mjs`
- `test/tools-list.test.mjs`

## Task 1: Configuration, error, and signed-state contracts

**Files:**
- Modify: `src/config.ts`
- Modify: `src/tools/results.ts`
- Modify: `src/security/approvalState.ts`
- Modify: `.env.example`
- Modify: `test/directory-config.test.mjs`
- Create: `test/legacy-directory-approval.test.mjs`

- [ ] **Step 1: Add failing configuration tests**

Extend the child-process projection in `test/directory-config.test.mjs` with:

```js
" directoryApprovalFallback: c.DIRECTORY_APPROVAL_FALLBACK"
```

Set `DIRECTORY_APPROVAL_FALLBACK: ""` in the base environment and add:

```js
test("legacy directory fallback defaults to deny and owner mode requires an owner", () => {
  const defaults = readConfig({});
  assert.equal(defaults.status, 0, defaults.stderr);
  assert.equal(JSON.parse(defaults.stdout).directoryApprovalFallback, "deny");

  const missingOwner = readConfig({ DIRECTORY_APPROVAL_FALLBACK: "owner" });
  assert.notEqual(missingOwner.status, 0);
  assert.match(missingOwner.stderr, /OWNER_USER_ID.*required.*fallback/i);

  const owner = readConfig({
    OWNER_USER_ID: "owner",
    DIRECTORY_APPROVAL_FALLBACK: "owner",
  });
  assert.equal(owner.status, 0, owner.stderr);
  assert.equal(JSON.parse(owner.stdout).directoryApprovalFallback, "owner");
});
```

- [ ] **Step 2: Add failing result/state type coverage**

Create `test/legacy-directory-approval.test.mjs` with imports from `dist/` and assert:

```js
test("legacy directory errors preserve structured approval details", () => {
  const result = toolError(
    "DIRECTORY_APPROVAL_REQUIRED",
    "approval required",
    true,
    { directoryApproval: { challenge: "opaque", decisions: ["allow_once"] } },
  );
  assert.deepEqual(JSON.parse(result.content[0].text), {
    ok: false,
    code: "DIRECTORY_APPROVAL_REQUIRED",
    message: "approval required",
    retryable: true,
    directoryApproval: { challenge: "opaque", decisions: ["allow_once"] },
  });
});
```

Add a compile-time fixture in `src/security/approvalState.ts` through the implementation step; the test should initially fail because the new error code and fourth `toolError` argument do not exist.

- [ ] **Step 3: Run the failing checks**

```powershell
npm run build
node --test test/directory-config.test.mjs test/legacy-directory-approval.test.mjs
```

Expected: failure for missing fallback config and extended error contract.

- [ ] **Step 4: Implement configuration and error details**

In `src/config.ts` add after owner settings:

```ts
export type DirectoryApprovalFallback = "deny" | "owner";
export const DIRECTORY_APPROVAL_FALLBACK: DirectoryApprovalFallback = envEnum(
  "DIRECTORY_APPROVAL_FALLBACK",
  ["deny", "owner"] as const,
  "deny",
);

if (DIRECTORY_APPROVAL_FALLBACK === "owner" && !OWNER_USER_ID) {
  throw new Error("OWNER_USER_ID is required when directory approval fallback is owner");
}
```

Extend `ToolErrorCode` in `src/tools/results.ts`:

```ts
| "DIRECTORY_APPROVAL_REQUIRED" | "DIRECTORY_APPROVAL_EXPIRED"
```

Change `toolError` without changing existing callers:

```ts
export function toolError(
  code: ToolErrorCode,
  message: string,
  retryable = false,
  details: Record<string, unknown> = {},
) {
  const body = { ok: false, code, message, retryable, ...details };
  return { ...toolJson(body), isError: true };
}
```

- [ ] **Step 5: Add the signed payload type**

In `src/security/approvalState.ts` add:

```ts
export interface LegacyDirectoryChallengePayload {
  version: 1;
  kind: "legacy_directory";
  userId: string;
  tool: string;
  argsDigest: string;
  rootsDigest: string;
  roots: CanonicalDirectoryRoot[];
  nonce: string;
  expiresAt: string;
}
```

Import `CanonicalDirectoryRoot` and extend:

```ts
export type SignedRequestStatePayload =
  | ApprovalStatePayload
  | DirectoryApprovalStatePayload
  | LegacyDirectoryChallengePayload;
```

Update type guards in `src/security/approval.ts` so `legacy_directory` is never treated as an ordinary operation approval state; return `APPROVAL_DENIED` if it reaches `requestApproval`.

- [ ] **Step 6: Document the new environment value**

Add to `.env.example` next to owner settings:

```env
# Legacy Feishu clients without MCP input_required: deny | owner
DIRECTORY_APPROVAL_FALLBACK=deny
```

- [ ] **Step 7: Verify and commit**

```powershell
npm run build
node --test test/directory-config.test.mjs test/legacy-directory-approval.test.mjs test/approval-elicitation.test.mjs
npm run typecheck
git add src/config.ts src/tools/results.ts src/security/approvalState.ts src/security/approval.ts .env.example test/directory-config.test.mjs test/legacy-directory-approval.test.mjs
git commit -m "feat: define legacy directory approval contracts"
```

Expected: all focused tests pass and typecheck exits 0.

## Task 2: Signed legacy challenge coordinator and auth submission

**Files:**
- Create: `src/security/legacyDirectoryApproval.ts`
- Modify: `src/security/directoryRoots.ts`
- Modify: `src/auth/authTool.ts`
- Modify: `src/auth/pinAuth.ts`
- Modify: `test/legacy-directory-approval.test.mjs`
- Modify: `test/security-auth.test.mjs`

- [ ] **Step 1: Write coordinator decision tests**

In `test/legacy-directory-approval.test.mjs`, create a temporary `DirectoryGrantStore`, synthetic owner request, and MCP context. Cover this exact table:

```js
const cases = [
  ["allow_once", { once: true, session: 0, permanent: 0 }],
  ["allow_session", { once: false, session: 1, permanent: 0 }],
  ["allow_permanent", { once: false, session: 0, permanent: 1 }],
  ["deny", { denied: true, session: 0, permanent: 0 }],
];
```

For every case, mint a real challenge, submit it through the coordinator, and assert the exact store/one-shot result. Also assert changed user, changed signature, expired timestamp, changed root digest, replay, non-owner, missing authentication, and an internal approval directory all fail without a grant.

- [ ] **Step 2: Write one-shot consumption tests**

Add:

```js
test("allow_once is consumed only by the next completely matching call", async () => {
  // Submit allow_once for owner/read_file/argsDigest/rootDigest.
  assert.deepEqual(consumeLegacyDirectoryOnce(exactRequest), expectedRoots);
  assert.equal(consumeLegacyDirectoryOnce(exactRequest), null);
  assert.equal(consumeLegacyDirectoryOnce({ ...exactRequest, tool: "write_file" }), null);
});
```

Use separate challenges to prove a mismatching call does not consume the valid record, and a fresh coordinator simulates process restart with no one-shot state.

- [ ] **Step 3: Run expected missing-module failures**

```powershell
npm run build
node --test test/legacy-directory-approval.test.mjs
```

Expected: failure because `legacyDirectoryApproval.js` does not exist.

- [ ] **Step 4: Centralize the root digest**

Move `digestDirectoryRoots()` from `src/security/directoryAuthorization.ts` to
`src/security/directoryRoots.ts` with this implementation:

```ts
export function digestDirectoryRoots(roots: CanonicalDirectoryRoot[]): string {
  return createHash("sha256")
    .update(JSON.stringify(deduplicateRoots(roots).map((root) => ({
      logicalRoot: root.logicalRoot,
      physicalRoot: root.physicalRoot,
    }))))
    .digest("hex");
}
```

Import `createHash` and update all existing imports/tests to use the new module.

- [ ] **Step 5: Implement `legacyDirectoryApproval.ts`**

Export these contracts:

```ts
export type LegacyDirectoryDecision =
  | "allow_once" | "allow_session" | "allow_permanent" | "deny";

export interface LegacyDirectoryMatch {
  userId: string;
  tool: string;
  argsDigest: string;
  rootsDigest: string;
}

export async function createLegacyDirectoryChallenge(
  ctx: ServerContext,
  request: DirectoryAuthorizationRequest,
  roots: CanonicalDirectoryRoot[],
): Promise<CallToolResult>;

export async function submitLegacyDirectoryDecision(
  ctx: ServerContext,
  challenge: string,
  decision: LegacyDirectoryDecision,
  store?: DirectoryGrantStore,
): Promise<CallToolResult>;

export function consumeLegacyDirectoryOnce(
  match: LegacyDirectoryMatch,
): CanonicalDirectoryRoot[] | null;
```

Implementation requirements:

- `createLegacyDirectoryChallenge` verifies fallback=`owner`, exact owner identity, non-internal roots, canonical roots, and generates `nonce` plus `expiresAt = now + APPROVAL_TIMEOUT_MS`.
- Mint with `mintApprovalState(payload, ctx)` and return `toolError("DIRECTORY_APPROVAL_REQUIRED", ..., true, { directoryApproval: ... })`.
- `submitLegacyDirectoryDecision` calls `verifyApprovalState(challenge, ctx)` inside try/catch, strictly validates the payload and expiry, re-digests roots, checks `isAuthenticated(userId)`, checks internal paths again, and consumes the nonce once.
- `deny` returns `DIRECTORY_APPROVAL_DENIED` after nonce consumption.
- session/permanent reuse `DirectoryGrantStore` batch methods.
- permanent persistence exceptions return `DIRECTORY_GRANT_PERSIST_FAILED`.
- one-shot keys use `userId + NUL + tool + NUL + argsDigest + NUL + rootsDigest`; values contain cloned roots and expiry.
- `consumeLegacyDirectoryOnce` deletes only a fully matching, unexpired key and returns cloned roots.
- Opportunistically delete expired one-shot entries before inserts and lookups.
- Log only tool name, decision, root count, and source; do not log identity, paths, challenge, or digest.

- [ ] **Step 6: Extend the auth tool**

Export `isAuthenticated` from `src/auth/pinAuth.ts` if not already exported. Change the auth schema in `src/auth/authTool.ts` to:

```ts
inputSchema: {
  pin: z.string().optional(),
  directoryApproval: z.object({
    challenge: z.string().min(1),
    decision: z.enum(["allow_once", "allow_session", "allow_permanent", "deny"]),
  }).optional(),
}
```

Use handler `(args, ctx)`. If `directoryApproval` exists, do not call `attemptAuth`; call `submitLegacyDirectoryDecision(ctx, challenge, decision)`. Otherwise preserve the exact PIN behavior.

- [ ] **Step 7: Verify and commit**

```powershell
npm run build
node --test test/legacy-directory-approval.test.mjs test/security-auth.test.mjs test/approval-elicitation.test.mjs
npm run typecheck
git add src/security/legacyDirectoryApproval.ts src/security/directoryRoots.ts src/security/directoryAuthorization.ts src/auth/authTool.ts src/auth/pinAuth.ts test/legacy-directory-approval.test.mjs test/security-auth.test.mjs
git commit -m "feat: submit owner directory decisions through auth"
```

## Task 3: Directory pipeline integration and legacy HTTP E2E

**Files:**
- Modify: `src/security/directoryAuthorization.ts`
- Modify: `test/directory-authorization.test.mjs`
- Create: `test/legacy-directory-authorization-e2e.test.mjs`
- Modify: `test/helpers/mcp-http-fixture.mjs`

- [ ] **Step 1: Add failing unit behavior**

Extend `test/directory-authorization.test.mjs` with:

```js
test("legacy owner receives a signed fallback challenge when explicitly enabled", async () => {
  // Configure the imported module in a child process or inject fallback dependencies.
  const result = await requestDirectoryAuthorization(legacyContext(), ownerRequest, store);
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.code, "DIRECTORY_APPROVAL_REQUIRED");
  assert.equal(body.retryable, true);
  assert.equal(body.directoryApproval.tool, ownerRequest.tool);
  assert.deepEqual(body.directoryApproval.decisions,
    ["allow_once", "allow_session", "allow_permanent", "deny"]);
});
```

Also assert modern contexts still return `input_required`, fallback deny returns
`CLIENT_ELICITATION_UNSUPPORTED`, and a non-owner legacy request never receives a challenge.

- [ ] **Step 2: Integrate fallback and one-shot consumption**

In `requestDirectoryAuthorization`, after canonical roots and identity checks:

```ts
const onceRoots = consumeLegacyDirectoryOnce({
  userId: request.userId,
  tool: request.tool,
  argsDigest: request.argsDigest,
  rootsDigest,
});
if (onceRoots) {
  return { allowed: true, roots: onceRoots, rootsDigest, decision: "allow_once" };
}
```

Keep modern `input_required` first. Replace only the legacy unsupported branch:

```ts
if (!ctx.mcpReq.envelope) {
  if (DIRECTORY_APPROVAL_FALLBACK === "owner" && request.userId === OWNER_USER_ID) {
    return createLegacyDirectoryChallenge(ctx, request, roots);
  }
  return toolError("CLIENT_ELICITATION_UNSUPPORTED", ...);
}
```

One-shot roots continue through the existing request-local additional-root verification before any file operation.

- [ ] **Step 3: Extend the HTTP fixture**

Add to `startMcpFixture`:

```js
directoryApprovalFallback = "deny"
```

and pass `DIRECTORY_APPROVAL_FALLBACK` into the child environment. Add helpers:

```js
const callLegacy = (name, args, identity = userId) =>
  rpc("tools/call", { name, arguments: args }, false, identity);
```

Return `callLegacy` from the fixture.

- [ ] **Step 4: Create the legacy HTTP E2E test**

In `test/legacy-directory-authorization-e2e.test.mjs`, use temporary owner-default, outside, and approval-data roots. Run this sequence over actual HTTP:

```js
const first = await fixture.callLegacy("read_file", { path: outsideFile });
const required = JSON.parse(first.content[0].text);
assert.equal(required.code, "DIRECTORY_APPROVAL_REQUIRED");

const approved = await fixture.callLegacy("auth", {
  directoryApproval: {
    challenge: required.directoryApproval.challenge,
    decision: "allow_once",
  },
});
assert.equal(JSON.parse(approved.content[0].text).directoryApproval.retryOriginalCall, true);

assert.equal(
  (await fixture.callLegacy("read_file", { path: outsideFile })).content[0].text,
  "outside",
);
assert.equal(
  JSON.parse((await fixture.callLegacy("read_file", { path: outsideFile })).content[0].text).code,
  "DIRECTORY_APPROVAL_REQUIRED",
);
```

Add session reuse, permanent restart/revoke, deny/no-side-effect, non-owner, tamper, replay, expiry, and internal-directory cases. Assert no challenge or credential appears in captured server output.

- [ ] **Step 5: Run focused and full regression**

```powershell
npm run build
node --test test/legacy-directory-authorization-e2e.test.mjs test/directory-authorization.test.mjs test/directory-authorization-e2e.test.mjs test/tools-list.test.mjs
npm run typecheck
npm test
```

Expected: focused tests pass, full suite passes, and tools/list remains 21.

- [ ] **Step 6: Commit**

```powershell
git add src/security/directoryAuthorization.ts test/directory-authorization.test.mjs test/legacy-directory-authorization-e2e.test.mjs test/helpers/mcp-http-fixture.mjs
git commit -m "feat: fall back to owner conversation approvals"
```

## Task 4: Health, launcher, documentation, and deployment config

**Files:**
- Modify: `src/index.ts`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/aily-integration-guide.md`
- Modify: `test/health-concurrency.test.mjs`
- Modify: `test/launcher.test.mjs`
- Modify: `test/tools-list.test.mjs`

- [ ] **Step 1: Add failing health and launcher expectations**

In `test/health-concurrency.test.mjs`, set fallback owner and expect:

```js
assert.equal(health.directoryAuthorization.fallback, "owner");
```

Continue asserting the serialized health body contains neither configured identity nor paths.

In `test/launcher.test.mjs`, add `DIRECTORY_APPROVAL_FALLBACK: "owner"` and assert check-only JSON reports only:

```js
directoryApprovalFallback: "owner"
```

Add a failure case for owner fallback without owner identity.

- [ ] **Step 2: Update health and banner**

In `src/index.ts` add to the directory summary:

```ts
fallback: DIRECTORY_APPROVAL_FALLBACK,
```

Add banner line:

```ts
`Directory fallback: ${DIRECTORY_APPROVAL_FALLBACK}`
```

Do not print `OWNER_USER_ID`.

- [ ] **Step 3: Update the launcher**

Read `DIRECTORY_APPROVAL_FALLBACK` after loading `.env`; validate `deny|owner`, require owner identity for owner mode, and add the fallback mode to check-only JSON. Do not output any challenge or identity value.

- [ ] **Step 4: Update documentation**

Document in README and the Feishu guide:

```env
DIRECTORY_APPROVAL_FALLBACK=owner
```

Explain the legacy flow, the exact four decisions, immediate agent retry, owner-only trust tradeoff, fallback default deny, permanent revocation commands, modern MRTR preservation, and unchanged 21-tool inventory. Explicitly tell agents never to suggest editing `ALLOWED_DIRS` after `DIRECTORY_APPROVAL_REQUIRED`.

- [ ] **Step 5: Verify and commit**

```powershell
npm run build
node --test test/health-concurrency.test.mjs test/launcher.test.mjs test/tools-list.test.mjs test/legacy-directory-authorization-e2e.test.mjs
npm run typecheck
git diff --check
git add src/index.ts .env.example README.md docs/aily-integration-guide.md test/health-concurrency.test.mjs test/launcher.test.mjs test/tools-list.test.mjs scripts/start-feishu-mcp.ps1
git commit -m "docs: expose owner conversation fallback"
```

## Task 5: Full acceptance, restart, and publish

**Files:** No tracked source changes expected unless acceptance finds a defect.

- [ ] **Step 1: Run final local acceptance once**

```powershell
npm run typecheck
npm test
py -3 -u test/e2e_test.py
npm audit --registry=https://registry.npmjs.org --omit=dev
git diff --check
git status -sb
```

Expected: every command exits 0, audit reports zero production vulnerabilities, and the worktree is clean.

- [ ] **Step 2: Configure only the active deployment `.env`**

Without printing its contents, set in the active implementation worktree:

```env
DIRECTORY_APPROVAL_FALLBACK=owner
```

Preserve the existing Bearer Token, fixed domain, owner identity, and owner root. Do not modify the old deployment `.env`.

- [ ] **Step 3: Restart the one-click service safely**

Stop the current launcher with `Q`, confirm ports 3000/4040 are released, then run:

```powershell
.\start-feishu-mcp.bat
```

Require local and public health success, 21 tools, owner default count 1, and fallback owner.

- [ ] **Step 4: Smoke-test the fixed tunnel without exposing credentials**

Using the configured Bearer and `x-aily-user=owner` from local variables, verify:

```text
GET  /health
POST /mcp initialize
POST /mcp tools/list
POST /mcp tools/call read_file against a generated C:\...\Temp directory
POST /mcp tools/call auth with the returned challenge and allow_once
POST /mcp tools/call read_file retry
```

Only print status, tool count, error code, decision, and pass/fail. Never print the challenge or token.

- [ ] **Step 5: Verify in the actual Feishu conversation**

Ask the private agent to read the generated outside-root test file. Confirm it asks the user, submits the auth challenge after the choice, retries the original read, and does not suggest editing `ALLOWED_DIRS` or restarting. Record only pass/fail and time.

- [ ] **Step 6: Push the branch and update PR #1**

```powershell
git fetch origin main
git merge-base --is-ancestor origin/main HEAD
git push origin codex/conversational-directory-authorization
gh pr view 1 --json url,state,isDraft,headRefName,baseRefName
```

Do not merge main until the user approves after real Feishu acceptance.
