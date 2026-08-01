# Git Soft Approval Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the configured owner execute ordinary Git commands directly from Aily while high-impact Git commands require a signed conversational retry.

**Architecture:** `commandPolicy.ts` will classify directly invoked Git commands as ordinary or confirmation-required. `gitSoftApproval.ts` will mint and verify short-lived one-time signed retry tokens using the established request-state codec. `command.ts` will invoke that compatibility layer only for the configured owner and only when `GIT_COMMAND_POLICY=soft_owner`; all other commands retain their current approval path.

**Tech Stack:** Node.js 22, TypeScript, Zod, `@modelcontextprotocol/server`, Node test runner, existing signed approval-state codec.

---

## File structure

- Modify: `src/config.ts` — parse and validate `GIT_COMMAND_POLICY`.
- Modify: `src/security/approvalState.ts` — add the signed Git-confirmation payload to the codec union.
- Create: `src/security/gitSoftApproval.ts` — mint, validate, and consume exact one-time Git retry tokens.
- Modify: `src/tools/commandPolicy.ts` — classify a direct Git invocation as `ordinary` or `confirmation_required` without weakening non-Git classification.
- Modify: `src/tools/command.ts` — accept `confirmationToken`, route eligible Git calls through the soft-policy flow, and retain the native approval flow elsewhere.
- Modify: `src/tools/results.ts` — expose the Git-confirmation error code.
- Modify: `src/index.ts` — document the Aily retry protocol and expose only the effective Git policy in health.
- Modify: `.env.example`, `README.md`, `docs/aily-integration-guide.md` — document opt-in deployment and the exact Aily conversation/retry contract.
- Modify: `test/directory-config.test.mjs`, `test/command-policy.test.mjs`, `test/command-tool.test.mjs`, `test/health-concurrency.test.mjs` — configuration, unit, and direct-tool regression coverage.
- Create: `test/git-soft-approval.test.mjs` — token binding, expiry, and replay unit coverage.
- Create: `test/git-soft-approval-e2e.test.mjs` — legacy Aily-compatible HTTP flow coverage.

### Task 1: Lock down configuration and Git classification

**Files:**

- Modify: `src/config.ts:235-252`
- Modify: `src/tools/commandPolicy.ts:1-93`
- Modify: `test/directory-config.test.mjs:7-66`
- Modify: `test/command-policy.test.mjs:1-50`

- [ ] **Step 1: Write failing configuration and classifier tests**

Add a config probe field and assertions for the default and explicit policy:

```js
" gitCommandPolicy: c.GIT_COMMAND_POLICY"
// default: "approval"
// GIT_COMMAND_POLICY=soft_owner: "soft_owner"
// GIT_COMMAND_POLICY=invalid: non-zero exit and /GIT_COMMAND_POLICY.*approval.*soft_owner/i
```

Add classifier cases that assert `gitCategory` is `"ordinary"` for
`git add README.md`, `git commit -m message`, `git merge topic`, and
`git push origin topic`; assert `"confirmation_required"` for `git reset --hard`,
`git clean -fdx`, `git commit --amend`, `git push --force`, `git remote set-url`,
`git -C C:\\other status`, `git -c alias.x=!cmd status`, and `git frobnicate`.
Assert shell operators and `cmd /c git status` retain `approval_required` and
have no Git category.

- [ ] **Step 2: Run the focused tests to prove the new behavior is absent**

Run:

```powershell
npm run build; node --test test/directory-config.test.mjs test/command-policy.test.mjs
```

Expected: the new assertions fail because `GIT_COMMAND_POLICY` and `gitCategory`
do not exist.

- [ ] **Step 3: Implement the configuration and classifier**

In `src/config.ts`, add immediately after `OWNER_USER_ID`:

```ts
export type GitCommandPolicy = "approval" | "soft_owner";
export const GIT_COMMAND_POLICY: GitCommandPolicy = envEnum(
  "GIT_COMMAND_POLICY",
  ["approval", "soft_owner"] as const,
  "approval",
);
if (GIT_COMMAND_POLICY === "soft_owner" && !OWNER_USER_ID) {
  throw new Error("OWNER_USER_ID is required when GIT_COMMAND_POLICY is soft_owner");
}
```

Extend `CommandRisk` with `gitCategory?: "ordinary" | "confirmation_required"`.
After tokenization identifies `git` or `git.exe`, parse only direct global
options and a single subcommand. Return `ordinary` only for the narrow list
covered by the tests. Return `confirmation_required` for every other direct Git
form, including all global `-c`, `-C`, `--git-dir`, `--work-tree`, helpers,
external programs, unknown options, and unknown subcommands. Keep the existing
`approval_required` level for every Git result so the normal path remains
unchanged unless Task 3 explicitly opts in.

- [ ] **Step 4: Run the focused tests**

Run:

```powershell
npm run build; node --test test/directory-config.test.mjs test/command-policy.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit the isolated change**

```powershell
git add src/config.ts src/tools/commandPolicy.ts test/directory-config.test.mjs test/command-policy.test.mjs
git commit -m "feat: classify Git commands for soft approval"
```

### Task 2: Add signed, exact, one-time Git confirmation tokens

**Files:**

- Modify: `src/security/approvalState.ts:22-45`
- Create: `src/security/gitSoftApproval.ts`
- Create: `test/git-soft-approval.test.mjs`

- [ ] **Step 1: Write failing token tests**

Create tests that run the helper inside `runWithRequestContext` and assert:

```js
const issued = await createGitConfirmation(context(), request);
assert.equal(issued.ok, false);
assert.equal(issued.code, "GIT_CONFIRMATION_REQUIRED");
assert.match(issued.gitConfirmation.token, /\S+/);

assert.equal(await consumeGitConfirmation(context(), issued.gitConfirmation.token, request), true);
assert.equal(await consumeGitConfirmation(context(), issued.gitConfirmation.token, request), false);
assert.equal(await consumeGitConfirmation(context(), issued.gitConfirmation.token, {
  ...request, command: "git reset --hard HEAD~1",
}), false);
```

Also test different owner identity, workdir, timeout, malformed token, and
expired `expiresAt` payload all return `false` without throwing.

- [ ] **Step 2: Run the new test to verify it fails**

Run:

```powershell
npm run build; node --test test/git-soft-approval.test.mjs
```

Expected: FAIL because `gitSoftApproval.js` does not exist.

- [ ] **Step 3: Implement the signed token helper**

Add this payload to `src/security/approvalState.ts` and include it in
`SignedRequestStatePayload`:

```ts
export interface GitConfirmationStatePayload {
  version: 1;
  kind: "git_confirmation";
  userId: string;
  commandDigest: string;
  workdirDigest: string;
  timeoutMs: number;
  nonce: string;
  expiresAt: string;
}
```

Create `src/security/gitSoftApproval.ts`. It must:

- hash exact command and resolved workdir with SHA-256;
- mint a `git_confirmation` state with `mintApprovalState(payload, ctx)`;
- return `toolError("GIT_CONFIRMATION_REQUIRED", ..., true, { gitConfirmation: { token, expiresAt, retryOriginalCall: true } })`;
- verify through `verifyApprovalState(token, ctx)`;
- check every payload field, expiry, and `getRequestUserId()`;
- consume the nonce only after all checks pass using `consumeSignedNonce`;
- log only `git_soft_confirmation` and a digest, never command, path, identity,
  or token.

The exact request object is:

```ts
export interface GitConfirmationRequest {
  userId: string;
  command: string;
  workdir: string;
  timeoutMs: number;
}
```

- [ ] **Step 4: Run the token tests**

Run:

```powershell
npm run build; node --test test/git-soft-approval.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit the isolated change**

```powershell
git add src/security/approvalState.ts src/security/gitSoftApproval.ts test/git-soft-approval.test.mjs
git commit -m "feat: add signed Git confirmation tokens"
```

### Task 3: Route eligible commands through the soft policy

**Files:**

- Modify: `src/tools/results.ts:1-28`
- Modify: `src/tools/command.ts:22-118`
- Modify: `src/index.ts:101-108,367-378`
- Modify: `test/command-tool.test.mjs:13-59`
- Create: `test/git-soft-approval-e2e.test.mjs`

- [ ] **Step 1: Write failing direct-tool and HTTP tests**

Use `startMcpFixture` with `GIT_COMMAND_POLICY: "soft_owner"`, an owner
identity, a temporary Git repository, and a legacy (non-elicitation) client.
Assert all of the following:

```js
assert.equal(body(await fixture.callLegacy("execute_command", {
  command: "git status --short", workdir: repository,
})).ok, true);

const initial = body(await fixture.callLegacy("execute_command", {
  command: "git reset --hard HEAD", workdir: repository,
}));
assert.equal(initial.code, "GIT_CONFIRMATION_REQUIRED");
assert.equal(initial.retryable, true);
assert.ok(initial.gitConfirmation.token);

const completed = body(await fixture.callLegacy("execute_command", {
  command: "git reset --hard HEAD", workdir: repository,
  confirmationToken: initial.gitConfirmation.token,
}));
assert.equal(completed.ok, true);
```

Before the confirmed retry, compare a marker file or repository state to prove
the destructive command did not start. Retry the same token and retry with a
changed command; both must return a denial. Add a non-owner case and a Node
command case asserting the existing unsupported-client error remains.

- [ ] **Step 2: Run the new tests to verify they fail**

Run:

```powershell
npm run build; node --test test/command-tool.test.mjs test/git-soft-approval-e2e.test.mjs
```

Expected: FAIL because `confirmationToken` is not accepted and the Git
confirmation error code does not exist.

- [ ] **Step 3: Implement routing and public contract**

Add `"GIT_CONFIRMATION_REQUIRED"` to `ToolErrorCode`. Extend
`ExecuteCommandArgs` and the Zod schema with:

```ts
confirmationToken: z.string().min(1).max(16_384).optional(),
```

After `workdir` resolves and before `requestApproval`, calculate `timeoutMs`
and apply this ordered branch:

```ts
const softGit = GIT_COMMAND_POLICY === "soft_owner" &&
  getRequestUserId() === OWNER_USER_ID && risk.gitCategory !== undefined;
if (softGit && risk.gitCategory === "confirmation_required") {
  const request = { userId: OWNER_USER_ID, command: risk.normalized, workdir, timeoutMs };
  if (!args.confirmationToken) return createGitConfirmation(ctx, request);
  if (!(await consumeGitConfirmation(ctx, args.confirmationToken, request))) {
    return toolError("APPROVAL_DENIED", "Git confirmation token is invalid, expired, changed, or already used.");
  }
}
if (!softGit && risk.level === "approval_required") {
  const approval = await requestApproval(ctx, {
    tool: "execute_command",
    userId: getRequestUserId(),
    subject: {
      kind: "command",
      key: commandSubject(risk.normalized, workdir),
      display: `${risk.normalized}\nWorking directory: ${workdir}`,
    },
    argsDigest: digestArguments({ command: args.command, workdir: args.workdir, timeout: args.timeout }),
    reasons: risk.reasons,
    authorizedDirectoryRootsDigest: workdirGuard.directoryProof?.rootsDigest,
  });
  if (approval !== true) return approval;
}
```

Ordinary eligible Git calls skip `requestApproval`; confirmation-required calls
execute only after a consumed token. Ensure `confirmationToken` is excluded
from `digestArguments` and process arguments. Add a server instruction that
tells Aily to show `gitConfirmation` details, wait for an explicit owner
message, and retry the original call with the returned token. Add
`gitCommandPolicy: GIT_COMMAND_POLICY` under the health approval summary.

- [ ] **Step 4: Run focused tests**

Run:

```powershell
npm run build; node --test test/command-tool.test.mjs test/git-soft-approval-e2e.test.mjs test/health-concurrency.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit the isolated change**

```powershell
git add src/tools/results.ts src/tools/command.ts src/index.ts test/command-tool.test.mjs test/git-soft-approval-e2e.test.mjs test/health-concurrency.test.mjs
git commit -m "feat: support conversational Git confirmation"
```

### Task 4: Document, run complete regression, and activate the owner policy

**Files:**

- Modify: `.env.example`
- Modify: `README.md:37`
- Modify: `docs/aily-integration-guide.md:160`

- [ ] **Step 1: Update deployment and Aily instructions**

Document these settings and the exact protocol:

```dotenv
# Default keeps every Git command on the normal approval path.
# Set only for the configured owner when Aily cannot render inputRequired.
GIT_COMMAND_POLICY=approval
```

State that `soft_owner` directly executes ordinary Git commands but returns
`GIT_CONFIRMATION_REQUIRED` for high-impact commands. Aily must display the
message, wait for the owner’s explicit confirmation, and retry exactly the same
tool call with `confirmationToken`; it must never reuse, alter, log, or invent
a token.

- [ ] **Step 2: Run complete automated regression**

Run:

```powershell
npm test
dotnet test broker\FeishuMcp.AdminBroker.Tests\FeishuMcp.AdminBroker.Tests.csproj
python test\e2e_test.py
npm audit --omit=dev
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/scan-development-secrets.ps1
git diff --check
```

Expected: all Node, Broker, and Python tests PASS; production audit and secret
scan report zero findings; `git diff --check` has no output.

- [ ] **Step 3: Commit documentation and final verification**

```powershell
git add .env.example README.md docs/aily-integration-guide.md
git commit -m "docs: explain Git soft approval policy"
git status --short
```

Expected: clean working tree.

- [ ] **Step 4: Activate and verify the current local deployment**

Set `GIT_COMMAND_POLICY=soft_owner` in the local runtime configuration without
printing any existing secret values, restart via
`scripts/start-feishu-mcp.ps1`, and call `/health`. Verify only that
`approval.gitCommandPolicy` is `soft_owner`. From Aily, run one harmless
ordinary Git command and request one high-impact Git command; verify it returns
the conversational confirmation challenge, then decline rather than executing
a destructive action.

## Plan self-review

- Spec coverage: Tasks 1–3 implement explicit opt-in, owner scope, exact Git
  parsing, fail-soft confirmation, signed one-time tokens, health, logging, and
  unchanged non-Git behavior. Task 4 documents, tests, activates, and rolls
  back by restoring `approval`.
- Placeholder scan: no unfinished design markers or unspecified test actions.
- Type consistency: `GitConfirmationRequest`, `GitConfirmationStatePayload`,
  `GIT_COMMAND_POLICY`, `confirmationToken`, and `GIT_CONFIRMATION_REQUIRED`
  use the same names in every task.
