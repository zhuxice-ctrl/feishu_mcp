# Complete Local Development Tools Design

**Date:** 2026-07-28

**Status:** Approved for implementation

## Objective

Turn `feishu-mcp` into a complete local development environment exposed through the existing Feishu Aily Streamable HTTP endpoint. Keep the current eleven tools and add the ten missing development capabilities inspired by `Nyaecho/ailycode-mcp`, while preserving this project's stronger request authentication, user isolation, filesystem boundaries, rollback behavior, audit redaction, and one-click fixed ngrok launcher.

The result remains one Node.js process, one `/mcp` endpoint, one `/health` endpoint, and one `start-feishu-mcp.bat` launcher.

## Decisions

- Implement the new capabilities natively in TypeScript. Do not embed or proxy a second MCP server.
- Preserve the existing eleven tool names and behavior. Add ten clearly named tools for a total of twenty-one.
- Use Feishu's in-conversation MCP elicitation UI for approvals and questions. Do not require terminal input.
- If the client cannot perform elicitation, deny operations that require approval. Do not silently fall back to terminal, browser, or plain-text approval.
- Classify shell commands by risk. Strictly recognized read-only commands may run automatically; destructive, state-changing, ambiguous, or unparseable commands require approval.
- Confirm the first request to each web origin and remember approval for the selected duration.
- Approval choices are `allow once`, `allow until restart`, `allow permanently`, and `deny`.
- Permanent approvals use an exact, displayed scope and are revocable through a local management script.
- Long-running work does not need to be internally asynchronous in every function. Resource-consuming operations run behind configurable concurrency gates so independent calls can execute in parallel without exhausting the machine or blocking the HTTP service.

## Tool Inventory

### Existing tools retained

1. `ping`
2. `read_file`
3. `write_file`
4. `edit_file`
5. `create_directory`
6. `list_directory`
7. `move_file`
8. `search_files`
9. `get_file_info`
10. `list_allowed_directories`
11. `auth`

`search_files` remains backward compatible and is enhanced to support complete glob behavior, including `**`, brace alternatives, character classes, result limits, and modification-time ordering.

### New tools

1. `execute_command` — execute a command with a bounded working directory, timeout, process-tree cleanup, and output limits.
2. `search_content` — regular-expression content search with glob inclusion, limits, and a time budget.
3. `git_status` — inspect repository branch and working-tree status without a shell.
4. `git_diff` — inspect staged or unstaged changes without a shell.
5. `compare_files` — produce a unified diff between two files.
6. `apply_patch` — apply unified or structured multi-file patches transactionally.
7. `web_fetch` — access public, local, or LAN HTTP(S) resources with origin approval and redirect checks.
8. `todo_write` — replace the authenticated user's in-memory task list.
9. `todo_read` — read the authenticated user's in-memory task list.
10. `ask_user` — request text or a choice through an MCP elicitation card in Feishu.

## Architecture

The existing `McpServer` remains the single registration and transport surface. Tool implementations are split by responsibility instead of being copied from the reference CommonJS project.

```text
src/tools/
├── filesystem.ts          existing filesystem tools and glob enhancement
├── command.ts             execute_command registration and result shaping
├── commandPolicy.ts       command parsing and risk classification
├── contentSearch.ts       bounded content search
├── git.ts                 git_status and git_diff
├── diff.ts                compare_files
├── patch.ts               apply_patch orchestration
├── patchFormat.ts         structured and unified patch parsing
├── webFetch.ts            HTTP(S), redirects, and response conversion
├── todo.ts                per-user in-memory task lists
├── askUser.ts             Feishu elicitation form
├── processRunner.ts       process execution, timeout, truncation, tree cleanup
└── registry.ts            shared registration and execution wrapper

src/security/
├── approval.ts            approval policy and MCP elicitation flow
├── approvalState.ts       signed retry state, expiry, nonce, replay prevention
├── approvalStore.ts       session and permanent approval storage
├── commandRisk.ts         strict read-only command recognizer
└── networkGuard.ts        URL, DNS, origin, redirect, and metadata checks
```

The shared registry wrapper applies authentication, identity extraction, structured logging, rate limiting, concurrency acquisition, error normalization, and release in one place. Individual tools remain responsible for their schemas and domain-specific validation.

## Request Flow

```text
Feishu tool call
  -> Bearer transport authentication
  -> PIN/header/none tool authorization for x-aily-user
  -> schema validation
  -> path, command, or network risk evaluation
  -> existing approval lookup
  -> MCP input_required response when approval is needed
  -> Feishu renders a supplemental-information card
  -> client retries the same call with its input response and signed request state
  -> server validates user, tool, argument digest, expiry, nonce, and signature
  -> concurrency gate acquisition
  -> tool execution
  -> redacted audit event and structured tool result
```

Modern protocol requests use the SDK's `inputRequired()` and `inputRequired.elicit()` multi-round-trip flow. A legacy client may use `elicitInput()` only when it advertises the matching capability and the transport supports server-to-client requests. If neither safe mechanism is available, the guarded call returns `CLIENT_ELICITATION_UNSUPPORTED` without executing.

## Approval Model

The approval card displays the authenticated user, tool, normalized target, working directory when applicable, risk reasons, and the exact scope that each choice grants.

Approval state is bound to:

```text
user identity + tool name + normalized subject + full argument digest + expiry + random nonce
```

The retry state is integrity-protected with HMAC. It is treated as attacker-controlled input when returned by the client. Any changed argument, changed user, expired state, invalid signature, or replayed one-time nonce is rejected.

Approval durations behave as follows:

- `allow once`: consumes a single nonce and cannot be replayed.
- `allow until restart`: stores an exact subject in memory for the authenticated user.
- `allow permanently`: writes an exact subject for the authenticated user to `%LOCALAPPDATA%\feishu-mcp\approvals.json` using atomic replacement.
- `deny`: performs no action and returns `APPROVAL_DENIED`.

Permanent scopes never become blanket tool authorization:

- Command: normalized command plus canonical working directory.
- Web fetch: scheme, normalized host, and effective port.
- File or patch operation: canonical target path or exact canonical target set.

The approval file is an internal protected path that MCP filesystem, search, command-working-directory, and patch tools must not access even when a broad `ALLOWED_DIRS` includes its parent. The launcher reports the count of loaded permanent approvals without printing their values. A local PowerShell management script lists numbered, redacted summaries and supports removing one entry or clearing all entries.

## Command Risk Policy

`execute_command` accepts a command, optional working directory, and optional timeout. The working directory must resolve inside `ALLOWED_DIRS`.

Automatic execution uses a narrow allowlist, not a blacklist. It only applies when the parser recognizes the full command and finds no shell operators, redirection, substitution, encoding trick, executable indirection, or unsafe option. Initial candidates include directory listing, bounded text viewing, and read-only Git inspection with hardened arguments and paging or external-diff behavior disabled.

The following always require approval:

- pipelines, redirections, command separators, substitutions, and nested shells;
- interpreters and script hosts;
- package managers, build systems, test runners, and arbitrary executables because project scripts can execute code;
- file creation, deletion, movement, permission changes, process control, service control, registry changes, and network configuration;
- Git commands that mutate the working tree, index, refs, configuration, remotes, or history;
- commands that the parser cannot classify with high confidence.

After approval, a command runs as the current Windows account. The result contains stdout, stderr, exit code, duration, timeout status, kill status, and truncation flags. Timeout cleanup kills the full process tree. Output and logs are scrubbed for configured PIN, Bearer token, Authorization values, cookies, passwords, and secrets.

## Filesystem, Search, Git, Diff, and Patch

All path-bearing tools reuse canonical-path and realpath checks. Existing symlink and Windows junction escape protection remains mandatory.

`search_content` performs bounded traversal, skips common generated directories, excludes internal protected paths, and skips sensitive files by default. It exposes files scanned, matches returned, truncation, timeout, and sensitive-file skip counts.

Git tools invoke `git` directly with an argument array and a canonical working directory; they never pass user input through a shell. Paging and external diff programs are disabled. Git timeouts and output caps are independent configuration values.

`compare_files` reads both files only after both pass authorization and size checks, then returns a unified diff.

`apply_patch` supports structured `*** Begin Patch` operations and traditional unified diffs. It parses every operation, canonicalizes every embedded path, checks all targets and approvals, computes new content, and writes temporary replacements before commit. Existing files are backed up. A commit failure restores all touched paths and reports whether rollback succeeded. Sensitive paths and paths outside `ALLOWED_DIRS` cannot be hidden inside patch text.

## Network Fetch

`web_fetch` supports only HTTP and HTTPS. The first access to each origin requires approval, and cross-origin redirects require a new approval. Each redirect is resolved and validated independently.

The implementation enforces connection and total timeouts, redirect limits, response byte limits, supported output formats, credential redaction, and DNS checks. Link-local cloud metadata endpoints remain permanently blocked. Localhost and LAN addresses are allowed only after the normal origin approval; they are intentionally supported because local development services are part of the product goal.

## Todo and User Questions

Todo lists are in-memory and keyed by the authenticated `x-aily-user`. They have item-count and content-length limits and disappear on restart.

`ask_user` produces a Feishu supplemental-information form with a question, optional context, up to ten options, and a timeout. Accepted, declined, cancelled, timed-out, and unsupported-client results are distinct. It does not read from stdin or compete with approval prompts.

## Concurrency and Responsiveness

The service uses a global semaphore plus resource-specific child semaphores. Defaults are conservative and configurable through environment variables:

```env
MAX_CONCURRENT_TOOLS=8
MAX_CONCURRENT_COMMANDS=2
MAX_CONCURRENT_SEARCHES=2
MAX_CONCURRENT_FETCHES=4
TOOL_QUEUE_TIMEOUT_MS=30000
```

Acquisition order is always child gate before global gate so queued commands or searches do not occupy global slots while waiting. Approval requests occur before gate acquisition, because waiting for the user must not consume an execution slot. Todo and user-question bookkeeping do not use a resource gate.

Filesystem implementations may use synchronous steps where atomicity or simplicity benefits correctness, provided those steps are bounded. Long traversal, network, process, and bulk-read operations must yield or use asynchronous APIs sufficiently to keep `/health` and unrelated MCP calls responsive. The acceptance criterion is responsiveness under load, not an absolute prohibition on synchronous code.

The `/health` response reports active, queued, and limit values for each gate without exposing commands, paths, URLs, or user data.

## Error Contract

Tool failures return a consistent machine-readable payload in MCP text content and set `isError: true` where supported:

```json
{
  "ok": false,
  "code": "APPROVAL_DENIED",
  "message": "The user denied this operation.",
  "retryable": false
}
```

Stable codes cover authentication, elicitation support, approval, queue timeout, execution timeout, output truncation, invalid patterns or patches, path boundaries, sensitive paths, process failures, Git failures, network policy, redirect limits, and rollback failures. Error text and audit metadata pass through the existing redaction layer.

## Configuration

New settings are added to `.env.example`, validated at startup, and documented in the README. Besides concurrency, settings cover command timeouts and output size, search traversal and time budget, Git timeout, fetch timeout/redirect/body limits, approval signing-key persistence, and the permanent approval store path.

Unsafe unlimited values are rejected. Missing settings use documented safe defaults. The existing `.env` remains compatible.

## Testing and Acceptance

Implementation follows test-first increments and extends the existing Node and Python suites.

Required coverage includes:

1. All twenty-one tools appear in `tools/list` with stable schemas.
2. Existing eleven-tool behavior and all current security tests remain green.
3. Command classification covers PowerShell and CMD quoting, separators, pipelines, redirection, substitutions, interpreters, package managers, Git reads, Git writes, and ambiguous inputs.
4. Command timeout kills descendants and releases concurrency slots.
5. Concurrency limits, acquisition order, queue timeout, and `/health` watermarks behave under parallel load.
6. Approval state rejects signature changes, argument changes, user changes, expiry, and nonce replay.
7. Once, session, permanent, deny, revoke, and unsupported-client approval paths behave as specified.
8. Content search respects limits, timeouts, exclusions, sensitive files, symlinks, and junctions.
9. Git and diff tools do not invoke a shell or external pager/diff helper.
10. Patch parsing, multi-file success, staged validation, commit failure, rollback, and embedded-path escape attempts are covered.
11. Web fetch covers public, localhost, LAN, metadata denial, redirects, DNS changes, timeout, body truncation, and origin-memory behavior.
12. Todo data is isolated by user and bounded.
13. `ask_user` and guarded tools complete the MCP input-required round trip and distinguish decline, cancel, timeout, and unsupported clients.
14. The real BAT launcher builds and starts the service; local and fixed-ngrok health checks pass; an authenticated public MCP initialize and representative tool calls succeed.
15. Generated launcher and audit logs contain no configured PIN, Bearer token, Authorization header, cookie, or approval secret.

## Documentation and Rollout

The README gains a complete tool table, risk and approval explanation, concurrency configuration, approval-management instructions, and Feishu example prompts. `.env.example` documents every new setting. The launcher banner reports twenty-one tools, confirmation mode, concurrency limits, and approval count with sensitive values hidden.

The feature is implemented on the current feature branch, verified locally and through the fixed ngrok endpoint, and only then fast-forwarded into `main`. Existing one-click launcher commits and the remote `main` history are preserved.

## Non-goals

- Running a second `ailycode-mcp` process.
- Granting unrestricted command execution merely because PIN authentication succeeded.
- Supporting non-HTTP web protocols.
- Persisting todo lists.
- Falling back from verified MCP elicitation to unauthenticated plain-text approval.
- Exposing internal approval records through MCP filesystem tools.
