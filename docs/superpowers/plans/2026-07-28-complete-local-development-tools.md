# Complete Local Development Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the existing authenticated Feishu MCP server from 11 filesystem-oriented tools to 21 complete local-development tools with Feishu elicitation approvals, permanent exact-scope grants, bounded concurrency, and real ngrok verification.

**Architecture:** Keep one TypeScript MCP server and one `/mcp` endpoint. Add focused tool modules behind shared error, approval, process, and concurrency primitives; retrofit existing file consent from terminal prompts to MCP `input_required` elicitation. The coordinator owns edits to shared registration/configuration files and serializes commits so parallel agents never race on the Git index.

**Tech Stack:** Node.js 20+, TypeScript 5.7, MCP TypeScript SDK v2 beta, Express, Zod 4, Node test runner, Python HTTP E2E, PowerShell launcher, ngrok 3.

---

## Working Rules

- Work on `codex/one-click-tunnel`; never reset or overwrite existing commits.
- Never print `.env`, PIN, Bearer Token, approval secrets, or ngrok credentials.
- Parallel workers may create and edit only the files assigned to their task. They do not run `git add` or `git commit`; the coordinator reviews and commits each logical batch.
- Every path and command test uses temporary directories. Tests must not modify `D:\AilyWorkspace` or user projects.
- Run `npm run build` before targeted Node tests because tests import `dist/`.
- Use the existing GitHub noreply identity for commits.

## Task 1: Shared Result, Configuration, and Concurrency Foundation

**Files:**
- Create: `src/tools/results.ts`
- Create: `src/tools/concurrency.ts`
- Create: `src/tools/registry.ts`
- Modify: `src/config.ts`
- Create: `test/concurrency.test.mjs`
- Create: `test/tool-results.test.mjs`

- [ ] **Step 1: Write failing tests for structured results and semaphore behavior**

Add tests that require stable JSON error payloads, FIFO acquisition, queue timeout, release after exceptions, and separate global/resource statistics:

```js
test("toolError exposes stable machine-readable fields", () => {
  const result = toolError("QUEUE_TIMEOUT", "busy", true);
  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    ok: false, code: "QUEUE_TIMEOUT", message: "busy", retryable: true,
  });
});

test("semaphore rejects a queued waiter after its timeout", async () => {
  const gate = new Semaphore(1, "commands");
  const release = await gate.acquire(100);
  await assert.rejects(gate.acquire(5), /commands.*queue timeout/i);
  release();
});
```

- [ ] **Step 2: Run the focused tests and verify the missing-module failure**

Run: `npm run build; node --test test/tool-results.test.mjs test/concurrency.test.mjs`

Expected: FAIL because `dist/tools/results.js` and `dist/tools/concurrency.js` do not exist.

- [ ] **Step 3: Implement the shared result builders**

`src/tools/results.ts` must export these exact contracts:

```ts
export type ToolErrorCode =
  | "AUTHENTICATION_REQUIRED" | "CLIENT_ELICITATION_UNSUPPORTED"
  | "APPROVAL_REQUIRED" | "APPROVAL_DENIED" | "APPROVAL_EXPIRED"
  | "QUEUE_TIMEOUT" | "EXECUTION_TIMEOUT" | "OUTSIDE_ALLOWED_DIRS"
  | "SENSITIVE_PATH" | "INVALID_ARGUMENT" | "INVALID_PATTERN"
  | "INVALID_PATCH" | "PROCESS_FAILED" | "GIT_FAILED"
  | "NETWORK_DENIED" | "RESPONSE_TOO_LARGE" | "ROLLBACK_FAILED"
  | "INTERNAL_ERROR";

export function toolJson(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }],
           structuredContent: value as Record<string, unknown> };
}

export function toolError(code: ToolErrorCode, message: string, retryable = false) {
  const body = { ok: false, code, message, retryable };
  return { ...toolJson(body), isError: true };
}
```

- [ ] **Step 4: Implement FIFO semaphores and the execution wrapper**

`src/tools/concurrency.ts` exposes `Semaphore`, `ConcurrencyClass`, `withConcurrency()`, and `concurrencySummary()`. Acquire child gates before the global gate and always release in reverse order:

```ts
export type ConcurrencyClass = "default" | "command" | "search" | "fetch" | "ungated";

export async function withConcurrency<T>(kind: ConcurrencyClass, run: () => Promise<T>): Promise<T> {
  if (kind === "ungated") return run();
  const child = childGate(kind);
  const releaseChild = child ? await child.acquire(TOOL_QUEUE_TIMEOUT_MS) : null;
  try {
    const releaseGlobal = await globalGate.acquire(TOOL_QUEUE_TIMEOUT_MS);
    try { return await run(); } finally { releaseGlobal(); }
  } finally { releaseChild?.(); }
}
```

`src/tools/registry.ts` exports `runTool({ name, concurrency, subject }, body)`, calls `withConcurrency`, catches typed queue errors, emits redacted start/end audit events, and normalizes unexpected errors to `INTERNAL_ERROR`.

- [ ] **Step 5: Add validated configuration**

Export these values from `src/config.ts`, all using bounded positive-integer validation:

```ts
MAX_CONCURRENT_TOOLS=8
MAX_CONCURRENT_COMMANDS=2
MAX_CONCURRENT_SEARCHES=2
MAX_CONCURRENT_FETCHES=4
TOOL_QUEUE_TIMEOUT_MS=30000
COMMAND_TIMEOUT_MS=30000
COMMAND_MAX_TIMEOUT_MS=300000
COMMAND_MAX_OUTPUT_BYTES=1048576
SEARCH_TIMEOUT_MS=30000
SEARCH_MAX_FILES=10000
SEARCH_MAX_RESULTS=1000
GIT_TIMEOUT_MS=30000
FETCH_TIMEOUT_MS=30000
FETCH_MAX_TIMEOUT_MS=120000
FETCH_MAX_BYTES=5242880
FETCH_MAX_REDIRECTS=5
APPROVAL_TIMEOUT_MS=600000
APPROVAL_STATE_SECRET=""
APPROVAL_DATA_DIR=<LOCALAPPDATA>/feishu-mcp
```

Reject concurrency limits over 64, timeout values over one hour, and response limits over 100 MiB.

- [ ] **Step 6: Run foundation tests**

Run: `npm run build; node --test test/tool-results.test.mjs test/concurrency.test.mjs`

Expected: PASS.

- [ ] **Step 7: Coordinator review and commit**

Run: `git diff --check; npm run typecheck`

Commit: `feat: add tool execution foundation`

## Task 2: Feishu Elicitation Approval and Permanent Grants

**Files:**
- Create: `src/security/approvalStore.ts`
- Create: `src/security/approvalState.ts`
- Create: `src/security/approval.ts`
- Modify: `src/security/consent.ts`
- Modify: `src/security/toolAccess.ts`
- Modify: `src/tools/helpers.ts`
- Create: `scripts/manage-approvals.ps1`
- Create: `manage-feishu-mcp-approvals.bat`
- Create: `test/approval-state.test.mjs`
- Create: `test/approval-store.test.mjs`
- Create: `test/approval-elicitation.test.mjs`
- Modify: `test/consent-terminal.test.mjs`

- [ ] **Step 1: Write failing request-state and approval-store tests**

Cover HMAC tampering, expiry, user binding, argument changes, one-time nonce replay, session grants, permanent exact-scope grants, atomic persistence, internal-path protection, revoke-one, and clear-all.

The core request shape is fixed:

```ts
export interface ApprovalRequest {
  tool: string;
  userId: string | null;
  subject: { kind: "command" | "origin" | "path" | "paths"; key: string; display: string };
  argsDigest: string;
  reasons: string[];
}

export interface ApprovalStatePayload {
  version: 1;
  tool: string;
  userId: string | null;
  subjectKey: string;
  argsDigest: string;
  nonce: string;
}
```

- [ ] **Step 2: Verify the approval tests fail**

Run: `npm run build; node --test test/approval-state.test.mjs test/approval-store.test.mjs test/approval-elicitation.test.mjs`

Expected: FAIL with missing approval modules.

- [ ] **Step 3: Implement the process-wide request-state codec**

`src/security/approvalState.ts` loads `APPROVAL_STATE_SECRET` or atomically creates a 32-byte random key under `APPROVAL_DATA_DIR`. Construct one module-scope SDK codec so fresh per-request `McpServer` instances share it:

```ts
export const approvalStateCodec = createRequestStateCodec<ApprovalStatePayload>({
  key: loadOrCreateApprovalKey(),
  ttlSeconds: Math.ceil(APPROVAL_TIMEOUT_MS / 1000),
  bind: () => getRequestUserId() ?? "__anonymous__",
});
```

Expose `mintApprovalState(payload, ctx)` and `verifyApprovalState` for `McpServer` options.

- [ ] **Step 4: Implement exact-scope session and permanent storage**

`approvalStore.ts` keeps `userId|tool|subjectKey` session keys in memory and a versioned JSON file for permanent decisions. Use write-temp, fsync, rename, and mode `0o600` where supported. Never persist raw PIN, Bearer Token, request-state secret, full HTTP headers, or file contents.

Permanent records contain:

```ts
interface StoredApproval {
  id: string;
  userId: string;
  tool: string;
  subjectKind: ApprovalRequest["subject"]["kind"];
  subjectKey: string;
  display: string;
  createdAt: string;
}
```

- [ ] **Step 5: Implement the elicitation gate**

Use one input key, `approval`, and this schema:

```ts
const approvalInput = inputRequired.elicit({
  message: renderApprovalMessage(request),
  requestedSchema: {
    type: "object",
    properties: {
      decision: {
        type: "string",
        title: "Authorization",
        enum: ["allow_once", "allow_session", "allow_permanent", "deny"],
      },
    },
    required: ["decision"],
  },
});
```

`requestApproval(ctx, request)` returns `true`, a structured denial, or an SDK `InputRequiredResult`. On first round it checks stored exact grants, mints signed state, and returns `inputRequired`. On re-entry it reads `acceptedContent`, validates the verified state against current user/tool/arguments/subject, consumes the nonce, and stores session/permanent grants only after a valid human response.

- [ ] **Step 6: Replace terminal path confirmation with elicitation**

Keep `inspectPath()` and the existing `CONSENT_ABSOLUTE_PATH` / `CONSENT_SENSITIVE_FILE` policies, but remove terminal prompting from the production file path. Change `authorizeFilePath` and `resolveGuardAndAuthorize` to accept `ServerContext`; every filesystem callback accepts `(args, ctx)` and returns `InputRequiredResult` unchanged when approval is required.

The old terminal unit remains only as an isolated utility test if another component still imports it; otherwise remove the production singleton and update the test to assert there is no terminal fallback.

- [ ] **Step 7: Add local approval management scripts**

`manage-feishu-mcp-approvals.bat` delegates to PowerShell without embedding secrets. `scripts/manage-approvals.ps1` supports `-List`, `-Remove <id>`, and `-Clear`, uses the same default data path, prints redacted summaries, and atomically rewrites the file.

- [ ] **Step 8: Run approval and existing security tests**

Run: `npm run build; node --test test/approval-*.test.mjs test/consent-terminal.test.mjs test/auth-modes.test.mjs test/security-auth.test.mjs`

Expected: PASS; no test reads stdin.

- [ ] **Step 9: Coordinator review and commit**

Run: `git diff --check; npm run typecheck`

Commit: `feat: add Feishu elicitation approvals`

## Task 3: Command Risk Policy and Process Execution

**Files:**
- Create: `src/tools/commandPolicy.ts`
- Create: `src/tools/processRunner.ts`
- Create: `src/tools/command.ts`
- Create: `test/command-policy.test.mjs`
- Create: `test/process-runner.test.mjs`
- Create: `test/command-tool.test.mjs`

- [ ] **Step 1: Write failing command-classification tests**

Assert that narrow reads such as `dir`, `type README.md`, `git status`, `git log -5`, `git show HEAD`, and safe `rg pattern src` are read-only. Assert that pipes, redirects, `&`, `&&`, `||`, substitutions, PowerShell/CMD nesting, interpreters, package managers, build/test runners, arbitrary executables, `rg --pre`, and Git mutations require approval.

```ts
export interface CommandRisk {
  level: "read_only" | "approval_required";
  reasons: string[];
  normalized: string;
}
```

- [ ] **Step 2: Run the command tests and verify failure**

Run: `npm run build; node --test test/command-policy.test.mjs test/process-runner.test.mjs test/command-tool.test.mjs`

Expected: FAIL with missing command modules.

- [ ] **Step 3: Implement conservative full-command classification**

Parse the complete command. Automatic reads are allowed only if there are no metacharacters and the executable/arguments match an explicit rule. Unknown input returns `approval_required`; it never defaults to safe.

- [ ] **Step 4: Implement bounded process execution**

`runProcess(executable, args, options)` captures stdout/stderr separately, applies a combined byte budget, respects `AbortSignal`, and returns:

```ts
interface ProcessResult {
  stdout: string; stderr: string; exitCode: number | null;
  killed: boolean; timedOut: boolean; truncated: boolean; durationMs: number;
}
```

On Windows, timeout invokes `taskkill.exe /PID <numeric pid> /T /F`; on POSIX, use a detached process group and kill the negative PID. No user string is interpolated into the cleanup command.

- [ ] **Step 5: Register `execute_command`**

Schema:

```ts
{
  command: z.string().min(1).max(32768),
  workdir: z.string().optional(),
  timeout: z.number().int().positive().optional(),
}
```

Canonicalize `workdir` through `validatePath`, reject internal protected paths, classify risk, request approval when required, acquire the command semaphore, and run using `cmd.exe /d /s /c` on Windows or `/bin/sh -c` on POSIX. Return process fields and risk classification without logging command output.

- [ ] **Step 6: Run command tests**

Run: `npm run build; node --test test/command-policy.test.mjs test/process-runner.test.mjs test/command-tool.test.mjs`

Expected: PASS, including descendant cleanup on the current OS.

- [ ] **Step 7: Coordinator review and commit**

Commit: `feat: add risk-aware command execution`

## Task 4: Glob, Content Search, Git, and File Diff

**Files:**
- Create: `src/tools/globPattern.ts`
- Create: `src/tools/contentSearch.ts`
- Create: `src/tools/git.ts`
- Create: `src/tools/diff.ts`
- Modify: `src/tools/filesystem.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `test/glob-pattern.test.mjs`
- Create: `test/content-search.test.mjs`
- Create: `test/git-tools.test.mjs`
- Create: `test/diff-tool.test.mjs`

- [ ] **Step 1: Write failing behavior tests**

Cover `**`, braces, character classes, Windows separator normalization, file-name versus relative-path matching, modification-time sorting, limits, excluded directories, sensitive-file skipping, regex errors, search timeout, Git staged/unstaged behavior, disabled pagers/external diffs, equal files, and unified diffs.

- [ ] **Step 2: Verify missing behavior**

Run: `npm run build; node --test test/glob-pattern.test.mjs test/content-search.test.mjs test/git-tools.test.mjs test/diff-tool.test.mjs`

Expected: FAIL.

- [ ] **Step 3: Implement shared glob matching and enhance `search_files`**

Expose:

```ts
export function compileGlob(pattern: string): (relativePath: string, baseName?: string) => boolean;
export function normalizeGlobPath(value: string): string;
```

Preserve existing `search_files(path, pattern, excludePatterns?)` parameters and add optional `limit`. Return results sorted newest-first with a `truncated` flag.

- [ ] **Step 4: Implement `search_content`**

Schema contains `pattern`, optional `path`, optional `include`, and optional `maxResults`. Traverse asynchronously in bounded batches, use the search semaphore, stop at file/result/time limits, skip internal and sensitive paths, and return line-numbered matches plus `filesScanned`, `skippedSensitive`, `timedOut`, and `truncated`.

- [ ] **Step 5: Implement Git tools without a shell**

Use `runProcess("git", args, { cwd, env: hardenedGitEnv })`. Add `--no-ext-diff` where supported and set `GIT_PAGER=cat`, `PAGER=cat`, `GIT_EXTERNAL_DIFF=`. Parse porcelain status into branch and file records. `git_diff` accepts `path`, `staged`, and `file`; validate `file` as a repository-relative path that resolves inside the allowed root.

- [ ] **Step 6: Implement `compare_files`**

Add the audited `diff` npm package and use `createTwoFilesPatch`. Validate and authorize both paths before reading. Enforce `MAX_READ_BYTES` for each file and return `{ identical, diff, exitCode }`.

- [ ] **Step 7: Run focused tests and audit dependencies**

Run: `npm run build; node --test test/glob-pattern.test.mjs test/content-search.test.mjs test/git-tools.test.mjs test/diff-tool.test.mjs; npm audit --omit=dev`

Expected: PASS and zero production vulnerabilities.

- [ ] **Step 8: Coordinator review and commit**

Commit: `feat: add search git and diff tools`

## Task 5: Transactional Multi-file Patch

**Files:**
- Create: `src/tools/patchFormat.ts`
- Create: `src/tools/patch.ts`
- Create: `test/patch-format.test.mjs`
- Create: `test/patch-tool.test.mjs`

- [ ] **Step 1: Write failing parser and transaction tests**

Test structured add/update/delete/move, unified add/update, duplicate anchors, malformed hunks, target collisions, embedded absolute paths, traversal, symlink/junction escape, sensitive paths, multi-file success, commit failure, and complete rollback.

- [ ] **Step 2: Verify tests fail before implementation**

Run: `npm run build; node --test test/patch-format.test.mjs test/patch-tool.test.mjs`

Expected: FAIL.

- [ ] **Step 3: Implement pure patch parsing and in-memory application**

The parser returns explicit operations and never touches disk:

```ts
type PatchOperation =
  | { kind: "add"; path: string; content: string }
  | { kind: "update"; path: string; moveTo?: string; hunks: PatchHunk[] }
  | { kind: "delete"; path: string };
```

Reject ambiguous anchors instead of selecting the first occurrence.

- [ ] **Step 4: Implement authorization and transactional commit**

Parse first, collect every source/destination, canonicalize and guard all paths, then request one exact target-set approval when policy requires it. Stage all new contents in sibling temp files. Preserve originals before commit. On any failure, restore every original and delete every staged or partially-created path. A failed rollback returns `ROLLBACK_FAILED` and logs only target counts and redacted path summaries.

- [ ] **Step 5: Register `apply_patch`**

Schema contains required `patch` and optional `path` for traditional unified diffs. Return format, operations, changed paths, file count, applied state, and rollback state.

- [ ] **Step 6: Run patch and existing atomic-write tests**

Run: `npm run build; node --test test/patch-format.test.mjs test/patch-tool.test.mjs test/atomic-write.test.mjs`

Expected: PASS.

- [ ] **Step 7: Coordinator review and commit**

Commit: `feat: add transactional patch tool`

## Task 6: Origin-approved Web Fetch

**Files:**
- Create: `src/security/networkGuard.ts`
- Create: `src/tools/html.ts`
- Create: `src/tools/webFetch.ts`
- Create: `test/network-guard.test.mjs`
- Create: `test/web-fetch.test.mjs`

- [ ] **Step 1: Write failing URL and fetch tests**

Use local ephemeral HTTP servers. Cover HTTP/HTTPS-only parsing, credential rejection, normalized origins, localhost/LAN approval, metadata denial, same-origin redirects, cross-origin redirects, redirect loops, DNS result re-checking, timeout, abort, response truncation, text/HTML/Markdown conversion, and redacted headers.

- [ ] **Step 2: Verify tests fail**

Run: `npm run build; node --test test/network-guard.test.mjs test/web-fetch.test.mjs`

Expected: FAIL.

- [ ] **Step 3: Implement network validation**

`validateNetworkTarget(url)` rejects credentials and non-HTTP protocols, resolves all addresses, permanently denies IPv4/IPv6 link-local cloud metadata targets, and returns normalized origin plus resolved addresses. Localhost and private LAN addresses are not blocked; they still require normal origin approval.

- [ ] **Step 4: Implement bounded fetch and conversion**

Perform redirects manually so each target is validated. Same-origin hops reuse the current approval; new origins call `requestApproval`. Stream the body up to `FETCH_MAX_BYTES`, abort at timeout, and convert HTML with small dependency-free `htmlToText` / `htmlToMarkdown` helpers.

- [ ] **Step 5: Register `web_fetch`**

Schema:

```ts
{
  url: z.string().url(),
  format: z.enum(["text", "markdown", "html"]).optional(),
  timeout: z.number().int().positive().optional(),
}
```

Return original/final URL, status, content type, format, content, byte count, redirects, duration, and truncation.

- [ ] **Step 6: Run fetch tests**

Run: `npm run build; node --test test/network-guard.test.mjs test/web-fetch.test.mjs`

Expected: PASS.

- [ ] **Step 7: Coordinator review and commit**

Commit: `feat: add origin-approved web fetch`

## Task 7: Per-user Todos and Feishu Questions

**Files:**
- Create: `src/tools/todo.ts`
- Create: `src/tools/askUser.ts`
- Create: `test/todo-tools.test.mjs`
- Create: `test/ask-user.test.mjs`

- [ ] **Step 1: Write failing todo and elicitation tests**

Cover user isolation, replacement semantics, status/priority validation, 100-item and 500-character limits, restart volatility, free-text questions, numbered choices, accepted/declined/cancelled/timeout results, and unsupported elicitation.

- [ ] **Step 2: Verify tests fail**

Run: `npm run build; node --test test/todo-tools.test.mjs test/ask-user.test.mjs`

Expected: FAIL.

- [ ] **Step 3: Implement per-user todo state**

Use `getRequestUserId() ?? "__anonymous__"` as the in-memory key. `todo_write` replaces the entire list and returns counts. Allow at most one `in_progress` item without warning; multiple in-progress items are accepted with a warning.

- [ ] **Step 4: Implement `ask_user` through input-required elicitation**

Create a dynamic requested schema: one string field for free text, or one enum field for options. Use signed request state to bind the question/options digest. On re-entry return `{ answered, answer, selectedIndex?, reason? }`. Do not read stdin.

- [ ] **Step 5: Run todo and question tests**

Run: `npm run build; node --test test/todo-tools.test.mjs test/ask-user.test.mjs`

Expected: PASS.

- [ ] **Step 6: Coordinator review and commit**

Commit: `feat: add todo and user question tools`

## Task 8: Server Integration, Health, Launcher, and Documentation

**Files:**
- Modify: `src/index.ts`
- Modify: `src/config.ts`
- Modify: `src/security/logger.ts`
- Modify: `src/security/fileGuard.ts`
- Modify: `src/security/pathGuard.ts`
- Modify: `src/tools/filesystem.ts`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `scripts/start-feishu-mcp.ps1`
- Modify: `test/security-auth.test.mjs`
- Modify: `test/launcher.test.mjs`
- Create: `test/tools-list.test.mjs`
- Create: `test/health-concurrency.test.mjs`

- [ ] **Step 1: Write failing integration assertions**

Require this exact public tool set:

```js
const expected = [
  "ping", "read_file", "write_file", "edit_file", "create_directory",
  "list_directory", "move_file", "search_files", "get_file_info",
  "list_allowed_directories", "auth", "execute_command", "search_content",
  "git_status", "git_diff", "compare_files", "apply_patch", "web_fetch",
  "todo_write", "todo_read", "ask_user",
];
```

Assert `/health` reports 21 tools and global/command/search/fetch gate watermarks. Assert the banner contains `Tools: 21` and no terminal-interactive claim. Assert launcher check mode validates new numeric settings without printing secret values.

- [ ] **Step 2: Configure the MCP server for signed multi-round-trip input**

Construct every per-request server with shared verification:

```ts
const server = new McpServer(
  { name: SERVER_NAME, version: SERVER_VERSION },
  {
    instructions: SERVER_INSTRUCTIONS,
    inputRequired: { maxRounds: 4, roundTimeoutMs: APPROVAL_TIMEOUT_MS, legacyShim: true },
    requestState: { verify: approvalStateCodec.verify },
  }
);
```

Register all modules exactly once and keep `auth` exempt from pre-tool authorization.

- [ ] **Step 3: Retrofit shared execution and internal path protection**

Route all existing filesystem operations through the shared result/registry helpers without changing their schemas. Add the approval data directory and key/store paths to an internal-deny predicate checked before normal allowed-root logic. Preserve rollback, trash, symlink, junction, size, and sensitive-file behavior.

- [ ] **Step 4: Update health and logging**

Expose tool names, count, auth summary, approval counts, policy names, concurrency statistics, and timestamp. Do not expose stored approval subjects, commands, paths, URLs, or user IDs. Add new secret field names to redaction and verify both keys and values are scrubbed.

- [ ] **Step 5: Update launcher and environment documentation**

Add every setting from Task 1 to `.env.example`. Launcher check mode validates them, creates the approval data directory if needed, and reports only non-sensitive limits and counts. README documents the 21 tools, Feishu card choices, permanent grant management, risk policy, concurrency tuning, and example prompts.

- [ ] **Step 6: Run all Node tests and audit**

Run: `npm test; npm audit --omit=dev`

Expected: all tests PASS and zero production vulnerabilities.

- [ ] **Step 7: Coordinator review and commit**

Commit: `feat: expose complete local development environment`

## Task 9: Protocol, Security, and Real Tunnel Acceptance

**Files:**
- Modify: `test/e2e_test.py`
- Modify: `test/debug_mcp.py`
- Create: `test/complete-tools-e2e.test.mjs`
- Modify: `docs/aily-integration-guide.md`

- [ ] **Step 1: Extend local E2E coverage**

Add temporary-workspace tests for initialize/discover compatibility, `tools/list`, PIN authentication, read-only command execution, approved command retry, content search, Git status/diff, file diff, patch write/read, local web fetch, per-user todos, and elicitation question flow. Tests must use generated credentials and must redact them from failures.

- [ ] **Step 2: Run all local verification**

Run:

```powershell
npm run typecheck
npm test
python test/e2e_test.py
npm audit --omit=dev
```

Expected: every command exits 0.

- [ ] **Step 3: Run the real one-click launcher**

Start `start-feishu-mcp.bat`, wait for local health and the fixed ngrok inspector, then verify:

```text
https://reptilian-prenatal-spinster.ngrok-free.dev/health
https://reptilian-prenatal-spinster.ngrok-free.dev/mcp
```

Use the configured Bearer Token and a generated test identity without printing either. Verify authenticated initialize and `tools/list` over the public endpoint.

- [ ] **Step 4: Perform representative public tool calls**

Inside an isolated directory under `ALLOWED_DIRS`, authenticate, run `ping`, list files, create/read/edit a disposable file, run a read-only Git inspection, and verify that a high-risk command returns elicitation instead of executing without approval. Delete test artifacts through the service's safe mechanisms or local cleanup after the server stops.

- [ ] **Step 5: Scan logs and stop cleanly**

Search launcher and operation logs for the configured PIN, Bearer Token, approval secret, Authorization value, and generated test secrets. Expected matches: zero. Stop with `Q`, verify exit code 0, and confirm ports 3000 and 4040 are released.

- [ ] **Step 6: Final review and commit**

Run: `git diff --check; git status --short; git log --oneline -12`

Commit: `test: verify complete development environment`

## Task 10: Merge and Remote Verification

**Files:** No source changes expected.

- [ ] **Step 1: Confirm clean branch and complete test evidence**

Require a clean working tree, all local checks passing, zero leaked secrets, and the real tunnel stopped.

- [ ] **Step 2: Review the full branch delta against `origin/main`**

Run: `git diff --stat origin/main...HEAD; git log --oneline origin/main..HEAD`

Expected: only the one-click launcher, approved design/plan, complete tool implementation, tests, and documentation.

- [ ] **Step 3: Publish through the GitHub workflow**

Use the `github:yeet` skill, push `codex/one-click-tunnel`, fast-forward `main`, and verify the remote SHA. Never force-push.

- [ ] **Step 4: Report usage**

Provide the one-click BAT path, public MCP URL, Feishu headers, PIN authentication prompt, tool count, approval-card behavior, permanent approval management command, concurrency knobs, test totals, and final remote commit.
