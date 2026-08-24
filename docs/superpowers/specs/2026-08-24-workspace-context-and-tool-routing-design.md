# Workspace Context and Tool Routing Design

## Goal

Make local development work deterministic for MCP clients such as Aily. Once a
caller selects a trusted workspace, later calls must reuse that selection and
must receive a stable, machine-readable route to the correct tool. The client
must not repeatedly scan `F:\`, rediscover a repository root, invent shell
quoting, or use generic command execution for a known structured workflow.

This design introduces a small owner-scoped workspace-session layer. It extends
the existing trusted workspace catalog and development-task system; it does not
replace either one.

## Problem and scope

### Observed failure mode

Agents currently receive many individually safe tools but lack a shared
decision contract. They can therefore take a trial-and-error path:

1. recursively search a drive for a project;
2. attempt a command through a generic shell tool;
3. retry with different quoting or another shell;
4. discover too late that a structured Android or task tool was appropriate;
5. lose the selected project on the next turn and repeat the discovery.

This is inefficient, creates avoidable approval failures, and is difficult to
audit. It is especially unsuitable for Gradle work, whose build scripts and
runtime are intentionally handled by the `android_development` background-task
route.

### In scope

- Selecting a configured trusted workspace once and persisting it per owner.
- Returning a bounded workspace description and deterministic route hints.
- Recording the workflow phase, instruction-read state, and safe last-error
  summary for the current workspace session.
- Standardizing actionable error responses for this layer and selected routed
  tools.
- Documenting client routing rules and testing their invariants.

### Out of scope

- Discovering arbitrary repositories anywhere on a drive.
- Letting a caller create a workspace entry, executable, command, argument,
  environment override, or raw Gradle task.
- Replacing directory grants, approvals, task ownership, or tool-specific
  validation.
- Sharing a selected workspace across owners, devices, or unrelated sessions.
- Changing the behavior of existing tools in the first release.

## Chosen architecture

Three alternatives were considered:

1. **Client-only instructions.** Cheap, but clients can ignore prose and lose
   state after a turn. It does not create an enforceable contract.
2. **A global current-workspace setting.** Simple but unsafe: one caller can
   accidentally influence another caller, and state ownership is unclear.
3. **Static trusted catalog plus owner-scoped session context.** Reuses the
   catalog as the authoritative root allowlist while storing only the active
   selection and derived metadata per owner. This is the chosen approach.

The static catalog remains the only source of an executable workspace root.
The session store holds no authority by itself: every routed operation still
performs its existing directory, owner, approval, and toolchain checks.

```text
trusted workspace catalog ──resolve──> workspace bootstrap
                                         │
                                         ▼
                              owner-scoped context store
                                         │
                         workspaceId + route recommendation
                                         │
                                         ▼
       existing read/file/git tools | existing Android/task/local-workflow tools
```

## Module boundaries

### `src/development/workspaces/catalog.ts` (existing)

Remains responsible for loading, canonicalizing, and resolving trusted static
workspace records. It remains the only component that exposes a catalog root
to internal callers. Its public catalog view remains root-free.

The catalog schema is extended in a backward-compatible versioned manner with
optional declarative metadata:

```ts
type WorkspaceCapability =
  | "file_read" | "content_search" | "git_read" | "node_workflow"
  | "android_development" | "development_tasks";

interface WorkspaceHints {
  ecosystems: Array<"node" | "android" | "dotnet" | "native" | "electron">;
  instructionFiles: string[]; // relative, bounded, no traversal
  capabilities: WorkspaceCapability[];
}
```

Metadata is declarative only. It cannot add a command, path outside the
catalog root, or a capability that is not implemented in the server registry.
Old catalog entries use an empty hint object and remain valid.

### `src/development/workspaces/context.ts` (new)

Owns a persistent `WorkspaceContextStore`, keyed by a one-way owner key rather
than a raw user ID. The store validates expiry, catalog digest, workspace ID,
phase transitions, and bounded error summaries. It cannot execute processes,
read arbitrary files, or grant directory access.

```ts
interface WorkspaceContext {
  version: 1;
  contextId: string;          // UUID, opaque to clients
  ownerKey: string;           // internal only
  workspaceId: string;
  catalogDigest: string;
  phase: WorkspacePhase;
  instructionFilesRead: string[];
  lastError?: RouteErrorSummary;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

type WorkspacePhase =
  | "selected" | "instructions_ready" | "inspected" | "editing"
  | "verification_queued" | "verification_running" | "verification_terminal";
```

Contexts expire after 24 hours of inactivity and are deleted on expiry. A
catalog-digest mismatch invalidates the context rather than silently pointing
at a changed root or recipe. There is one active context per `(ownerKey,
workspaceId)`; selecting it again refreshes the existing context. An owner can
hold contexts for several workspaces, but a call that omits `workspaceId` is
valid only if it has exactly one unexpired context. Otherwise it receives a
bounded selection error.

### `src/development/workspaces/routing.ts` (new)

Contains pure functions only. It converts catalog hints and context phase into
a `RoutePlan`, validates legal phase transitions, and maps stable failures to
the next action. No MCP registration, storage, filesystem access, approval, or
process launch belongs here.

```ts
interface RoutePlan {
  workspaceId: string;
  phase: WorkspacePhase;
  recommended: RouteStep[];
  prohibited: ProhibitedRoute[];
}

interface RouteStep {
  purpose: string;
  tool: string;
  action?: string;
  required: boolean;
  input: Record<string, string | string[]>; // IDs/relative values only
}
```

### `src/tools/workspaceContext.ts` (new)

Is a thin MCP adapter. It authenticates the owner, calls catalog/context/
routing services, and returns public views. It never receives or returns the
absolute root, command text, credentials, worker launch specifications, or
another owner's context.

### Existing execution tools (unchanged authority)

`android_development`, `run_local_workflow`, file/content tools, Git read
tools, and development task tools stay authoritative for their own arguments
and safety policies. They may accept an optional `contextId` in a later
compatible release so they can update phase/error metadata after their normal
validation. Absence of `contextId` preserves every existing caller path.

## Public MCP contract

Register one owner-only tool, `workspace_context`, with strict discriminated
input. `workspace_bootstrap` is a convenient client-facing action name, not a
second state store or duplicate tool.

```ts
type WorkspaceContextRequest =
  | { action: "bootstrap"; workspaceId?: string }
  | { action: "select"; workspaceId: string }
  | { action: "get"; contextId?: string }
  | { action: "mark_instructions_read"; contextId: string; files: string[] }
  | { action: "clear"; contextId: string };
```

All objects are strict. `files` are catalog-declared relative instruction
files only; neither action accepts a filesystem root, a search pattern, a
shell expression, a command, arguments, environment, timeout, URL, or task
identifier.

### `bootstrap`

- With a `workspaceId`, resolves that trusted workspace and creates or refreshes
  the caller's context.
- Without one, returns the context if exactly one remains active; otherwise it
  returns at most 16 public catalog candidates and `WORKSPACE_SELECTION_REQUIRED`.
- It checks the existing directory grant for the resolved internal root. If the
  grant is absent, it returns `WORKSPACE_NOT_AUTHORIZED`; it does not create a
  persistent grant and does not prompt for approval.

Successful output contains `contextId`, `workspaceId`, label, declared
ecosystems, instruction-file names, phase, and a `RoutePlan`. It may include
Git branch/status only after a bounded internal Git read, and only when the
root is authorized. It never returns a disk-wide search result.

### `select`, `get`, `mark_instructions_read`, and `clear`

`select` is explicit selection. `get` returns only the caller's unexpired
context and an updated route plan. `mark_instructions_read` accepts only a
subset of the declared instruction list; it advances from `selected` to
`instructions_ready` when all required files are acknowledged. `clear`
deletes the caller's context and is idempotent.

Acknowledgement does not replace a file read. The client guide requires it to
use `read_file` first. In a later enforcement release, structured work routes
may require the context phase; first release reports the recommendation without
breaking existing tools.

## Deterministic routing policy

The route planner returns the following ordered sequence, adjusted only by
declared workspace capabilities and current phase:

| Situation | Required route | Explicitly avoid |
| --- | --- | --- |
| No selected workspace | `workspace_context.bootstrap` | scanning a drive |
| Instructions not ready | `read_file` for declared files, then `mark_instructions_read` | guessing project rules |
| Inspect source text | `read_file` / `search_content` scoped to the selected workspace | PowerShell quoting for text search |
| Inspect Git state | existing Git read tool | write commands or generic shell |
| Android build/test/install | `android_development` then task-status/log tools | `execute_command`, raw Gradle |
| Fixed Node verification recipe | `run_local_workflow` | raw `pnpm`, shell retries |
| Short unsupported diagnostic | `execute_command` only after a route plan says `generic_command_allowed` | nested `cmd`/PowerShell/bash wrappers |
| Long operation result | `get_development_task`, `read_development_task_logs`, or `cancel_development_task` | starting a second duplicate operation |

The planner must never ask a client to pass an absolute root to an execution
tool if an existing structured tool accepts a stable workspace ID. Where an
existing Android contract still requires a root, its adapter resolves the root
internally from `contextId` in the compatibility extension; it must not trust a
client-provided replacement root.

## Error contract

The existing `{ ok, code, message, retryable }` result shape remains valid.
This feature adds optional `nextAction` and `candidates` fields without
removing existing fields:

```ts
interface ActionableToolError {
  ok: false;
  code: ToolErrorCode;
  message: string;
  retryable: boolean;
  nextAction?: {
    tool: string;
    action?: string;
    reason: string;
  };
  candidates?: Array<{ workspaceId: string; label: string }>;
}
```

| Code | Meaning | Required client next action |
| --- | --- | --- |
| `WORKSPACE_SELECTION_REQUIRED` | No unambiguous active context | Call `workspace_context.bootstrap` with one returned ID. |
| `WORKSPACE_CONTEXT_NOT_FOUND` | Unknown, expired, or cross-owner context | Bootstrap/select again; do not retry another user's ID. |
| `WORKSPACE_CONTEXT_STALE` | Catalog digest changed | Bootstrap the selected workspace again. |
| `WORKSPACE_NOT_AUTHORIZED` | A trusted workspace lacks a directory grant | Use the existing directory authorization route; do not scan elsewhere. |
| `INSTRUCTION_FILE_INVALID` | File is not declared for this workspace | Read only declared files or update the operator catalog. |
| `ROUTE_REQUIRED` | A structured route exists for the request | Call the named tool/action; do not construct shell syntax. |
| `TASK_ALREADY_ACTIVE` | Equivalent background task is running | Read that task's status/logs instead of launching another. |

Candidate lists are root-free, capped, and only visible to the owner. An
error must never offer a raw command as remediation.

## State, safety, and audit rules

- Contexts are owner-scoped with the same derived owner-key mechanism as
  development tasks. Cross-owner lookup returns `WORKSPACE_CONTEXT_NOT_FOUND`.
- The persistent store uses atomic write/replace, a bounded total record count,
  UUID context IDs, UTC timestamps, and expiry cleanup on every read/write.
- Contexts contain stable IDs and safe summaries only. No root, credential,
  approval digest, raw command, command output, or secret enters the store.
- A context is never an authorization grant. Existing directory grants and
  single-use/standard approvals are revalidated before the corresponding work.
- `workspace_context` is owner-only and is included in the normal audit and
  concurrency registry. It does not induce a card/approval prompt for reads or
  selection.
- Catalog IDs and instruction files are limited by strict schemas; relative
  file paths reject traversal and symbolic-link escapes before any read.

## Migration and compatibility

Release in two stages:

1. **Guidance stage.** Add the context tool, catalog metadata, route output,
   error helpers, documentation, and tests. Existing tools and their schemas
   remain callable exactly as before. The Aily integration guide makes the
   context route the default.
2. **Context-aware stage.** Add optional `contextId` to compatible structured
   tools. The tool resolves a workspace internally, verifies ownership and
   catalog freshness, records phase transitions, and rejects conflicting roots.
   Existing calls without `contextId` retain compatibility until a separately
   approved deprecation release.

This staged path avoids breaking existing agents while making the deterministic
route available immediately.

## Testing and acceptance criteria

Add focused unit and integration coverage for:

1. Catalog hint validation, relative instruction paths, duplicate IDs, and
   root-free public views.
2. Context creation, owner isolation, one-context bootstrap behavior, expiry,
   explicit clear, atomic persistence, and catalog-digest staleness.
3. Every legal and illegal phase transition, including partial instruction
   acknowledgement and repeated calls.
4. Routing: Android routes to `android_development` plus task tools; Node
   verification routes to `run_local_workflow`; source inspection routes to
   structured file/search tools; no path routes to drive scanning.
5. Error result shape, bounded root-free candidates, and stable `nextAction`.
6. Existing tool inventory/registration tests and a backward-compatibility test
   proving present tools work without `contextId`.
7. An Aily-script fixture that follows bootstrap → instructions → inspect →
   route and contains no shell expression, disk scan, or alternative-shell
   retry.

The feature is accepted when an owner can select a configured workspace once,
resume the same context in a later call, receive a deterministic next tool for
Android and Node workflows, and get bounded corrective actions instead of
being driven toward arbitrary filesystem discovery or shell trial-and-error.
