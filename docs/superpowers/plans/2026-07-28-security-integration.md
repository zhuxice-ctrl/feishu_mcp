# Feishu MCP Security Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate the Phase 6 PIN/multi-user and consent features into the current code-quality branch so they enforce real request boundaries, then merge the verified result into `main`.

**Architecture:** Extend the existing `AsyncLocalStorage` request context to carry validated transport credentials and request identity. Every MCP tool except `auth` passes through one centralized access guard that enforces PIN/header authentication before inspecting arguments and applies hard directory boundaries plus configurable consent policies. Keep Bearer authentication as an optional transport perimeter, while PIN/header authentication controls tool authorization.

**Tech Stack:** Node.js 22+, TypeScript, Express, MCP Streamable HTTP SDK, Node built-in test runner.

---

## Global Constraints

- Base all work on `b58a848` (`origin/refactor/code-quality`), not the divergent local `main`.
- Preserve the nine filesystem tools, `ping`, Bearer authentication, rate limiting, audit logging, allowed-directory hard boundaries, blocked executable extensions, and soft-delete behavior.
- `auth` is the only tool callable before PIN authentication. In `header` mode, a non-empty trusted identity is sufficient. In `none` mode, all tools remain available.
- Request identity must never live in a module-level mutable variable. Resolve it per HTTP request from configurable header/query names and propagate it with `AsyncLocalStorage`.
- Directory escape is always denied. Consent cannot override it.
- Consent occurs before filesystem access and supports `allow`, `deny`, and `confirm`; no-TTY behavior defaults to deny.
- Fixed PIN values shorter than eight characters and invalid enum/integer configuration values must fail startup with a clear message.
- CORS preflight must allow configured identity headers and MCP protocol/session headers.
- No raw PIN, Bearer token, authorization header, password, or cookie may be logged.
- All new tests use temporary directories and ports and must clean up spawned server processes.

### Task 1: Per-Request Identity and Enforced Tool Authentication

**Files:**
- Modify: `src/config.ts`
- Modify: `src/security/requestContext.ts`
- Modify: `src/security/auth.ts`
- Modify: `src/security/logger.ts`
- Modify: `src/tools/helpers.ts`
- Modify: `src/tools/filesystem.ts`
- Modify: `src/index.ts`
- Create: `src/auth/pinAuth.ts`
- Create: `src/auth/authTool.ts`
- Create: `src/security/toolAccess.ts`
- Modify: `.env.example`
- Modify: `package.json`
- Create: `test/security-auth.test.mjs`

- [ ] **Step 1: Add a failing subprocess integration test**

Create a Node test that starts `dist/index.js` with `AUTH_MODE=pin`, a fixed eight-character PIN, no Bearer token, a temporary allowed directory, and a free localhost port. It must assert:

```js
assert.equal((await callTool("list_allowed_directories", {}, "alice")).isError, true);
assert.equal((await callTool("auth", { pin: "12345678" }, "alice")).isError, undefined);
assert.equal((await callTool("list_allowed_directories", {}, "alice")).isError, undefined);
assert.equal((await callTool("list_allowed_directories", {}, "bob")).isError, true);
```

Run `npm test`; the first assertion must fail against the current branch because PIN state is not enforced.

- [ ] **Step 2: Extend configuration with validated auth and identity settings**

Add validated exports with these effective defaults:

```ts
export const AUTH_MODE: "pin" | "header" | "none" = envEnum("AUTH_MODE", ["pin", "header", "none"], "pin");
export const AUTH_PIN = process.env.AUTH_PIN || "";
export const AUTH_USER_HEADER = process.env.AUTH_USER_HEADER || "x-aily-user";
export const AUTH_EMAIL_HEADER = process.env.AUTH_EMAIL_HEADER || "x-aily-email";
export const AUTH_USER_QUERY_PARAM = process.env.AUTH_USER_QUERY_PARAM || "";
export const AUTH_MULTI_USER = envBoolean("AUTH_MULTI_USER", false);
export const AUTH_MAX_USERS = envPositiveInt("AUTH_MAX_USERS", 8);
```

Throw during module initialization when `AUTH_PIN` is non-empty and shorter than eight characters, or when an enum/boolean/integer value is invalid. Export `SERVER_NAME` and `SERVER_VERSION` as the single identity used by MCP, health, tests, and the Banner.

- [ ] **Step 3: Extend request context**

Replace the token-only context with:

```ts
export interface RequestContext {
  token: string;
  userId: string | null;
  email: string | null;
}

export function runWithRequestContext<T>(context: RequestContext, fn: () => T | Promise<T>): T | Promise<T>;
export function getRequestToken(): string;
export function getRequestUserId(): string | null;
export function getRequestEmail(): string | null;
```

Extract identity from the current Express request using the configured header first and configured query parameter as fallback, then wrap the complete `handler.fetch()` call in `runWithRequestContext`.

- [ ] **Step 4: Port PIN state and central tool authorization**

Port timing-safe PIN validation and LRU multi-user state from commit `b8eb394`, but make all identity reads use `getRequestUserId()`. Add `authorizeToolCall(toolName, args)` in `toolAccess.ts`; before Task 2 it must enforce authentication and return a standard MCP error result when unauthorized. `auth` bypasses this check.

Call the authorization helper as the first statement of every filesystem handler and `ping`, before path validation, existence checks, or other observable behavior.

- [ ] **Step 5: Register the auth tool and make CORS dynamic**

Register `auth` as the eleventh tool. CORS preflight must include:

```text
Content-Type, Authorization, MCP-Protocol-Version, MCP-Method, MCP-Name, Mcp-Session-Id,
<AUTH_USER_HEADER>, <AUTH_EMAIL_HEADER>
```

Deduplicate empty or repeated header names. Keep `Access-Control-Allow-Origin: *` because the service does not use browser cookies.

- [ ] **Step 6: Make structured logging configuration real**

Retain the append-only operation audit log. Add level-aware `error`, `warn`, `info`, `debug`, and `trace` event methods honoring validated `LOG_LEVEL` and `LOG_FORMAT`, with recursive redaction for sensitive field names. Replace security-relevant `console.error` calls with the logger; the human-readable startup Banner may still write directly to stderr.

- [ ] **Step 7: Verify and commit**

Run:

```text
npm ci
npm run typecheck
npm test
```

Expected: all commands exit zero and the integration test proves unauthenticated Alice/Bob isolation. Commit as `fix: enforce per-request tool authentication`.

### Task 2: Consent Enforcement and Correct Terminal Serialization

**Files:**
- Create: `src/security/consent.ts`
- Create: `src/security/terminal.ts`
- Modify: `src/security/toolAccess.ts`
- Modify: `src/security/fileGuard.ts`
- Modify: `src/index.ts`
- Modify: `.env.example`
- Create: `test/consent-terminal.test.mjs`
- Modify: `test/security-auth.test.mjs`

- [ ] **Step 1: Add failing policy and queue tests**

Extend the server integration test so an authenticated user with `CONSENT_ABSOLUTE_PATH=deny` receives `isError: true` for an absolute `read_file` path but can read the same file through a relative path. Add a terminal unit test with injected streams that starts two prompts and asserts the second prompt is not rendered until the first answer resolves.

Run `npm test`; both behaviors must fail before implementation.

- [ ] **Step 2: Implement an injectable serialized terminal**

Port the source queue structure with one lazily-created readline instance. `prompt()` must enqueue an async `run` function that awaits `readLine(timeoutMs)` before resolving the chain. Support injected `input`, `output`, and `interactive` options for deterministic tests. Timeout or EOF returns `{ answer: null, timedOut: true }`.

- [ ] **Step 3: Implement consent policies**

Add validated configuration defaults:

```ts
CONSENT_ABSOLUTE_PATH = "confirm"
CONSENT_SENSITIVE_FILE = "confirm"
CONSENT_TIMEOUT_MS = 60000
NON_INTERACTIVE = "deny"
```

The gate remembers decisions by combined kind set and resolved subject until restart. It must log allow/deny/timeout/non-interactive decisions without sensitive contents.

- [ ] **Step 4: Integrate consent into the centralized tool guard**

For declared path arguments, call `validatePath` first as the non-overridable hard boundary. Apply absolute-path policy to absolute input. Apply sensitive-file policy only to `read_file`, `write_file`, and `edit_file`. If any applicable policy is `deny`, reject without prompting; if all are `allow`, continue; otherwise request one combined terminal decision.

Remove unconditional sensitive-file rejection from `checkFileAccess`; retain blocked executable-extension rejection. Ensure every filesystem handler reaches this centralized check before its original body.

- [ ] **Step 5: Surface truthful status**

Health and Banner must report the active policies and actual TTY state. Do not mention `local_ask_user`, because this project does not expose that tool.

- [ ] **Step 6: Verify and commit**

Run `npm run typecheck` and `npm test`. Expected: policy, no-TTY, remembered-decision, and serialized-queue tests pass. Commit as `fix: enforce consent policies for file tools`.

### Task 3: Transaction-Safe Writes, Regression Coverage, and Main Integration

**Files:**
- Modify: `src/tools/atomicWrite.ts`
- Modify: `src/security/trash.ts` if restoration support is needed
- Create: `test/atomic-write.test.mjs`
- Modify: `test/security-auth.test.mjs`
- Modify: `README.md`
- Modify: `docs/aily-integration-guide.md`

- [ ] **Step 1: Add rollback regression tests**

Use a temporary allowed directory and a controllable filesystem adapter or Node test mock. Assert all three cases:

```js
// Temp write fails: original target remains unchanged.
// Moving the original to trash fails: operation throws and original remains unchanged.
// Final temp rename fails: trashed original is restored and no partial target/temp remains.
```

Run `npm test`; the current implementation must fail at least the temp-write rollback assertion reproduced during review.

- [ ] **Step 2: Make write replacement transactional**

Write and flush the sibling temp file before touching the original. If preserving an original, require `moveToTrash()` to return a path or abort. Rename the sibling temp into place; because it is a sibling, do not use a cross-device copy fallback. On any finalization failure, remove partial output, restore the trash copy to the original path, clean the temp file, and rethrow an error preserving the primary failure. Return only after the new target exists.

- [ ] **Step 3: Complete integration coverage and documentation**

The subprocess suite must cover PIN success/failure, two-user isolation, header mode, none mode, absolute path deny, no-TTY confirm fallback, dynamic CORS headers, and clean process shutdown. Update documentation to distinguish optional Bearer perimeter authentication from tool-level PIN/header authorization and describe trusted-header requirements for public ngrok deployments.

- [ ] **Step 4: Run the full verification matrix**

Run:

```text
npm ci
npm run typecheck
npm test
python test/e2e_test.py
python test/e2e_test_windows.py
git diff --check origin/main...HEAD
```

If a platform-specific Python test cannot run, record the exact environmental reason; do not silently skip it. All runnable checks must pass.

- [ ] **Step 5: Commit, review, and integrate**

Commit as `fix: make file replacement rollback safe`. Perform a whole-branch code review against `origin/main`, resolve all correctness or security findings, push `codex/security-integration`, merge it into `main` without force-pushing, push `main`, and verify the remote `main` SHA and comparison status.
