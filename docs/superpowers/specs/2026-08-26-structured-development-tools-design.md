# Structured Development Tools Design

## Goal

Replace common local development uses of generic shell execution with typed,
domain-specific MCP tools that Aily can safely expose: Git workflow operations,
Java Maven/Gradle validation, and Node package-manager validation.

## Scope

This change creates `git_workflow` and `java_development`, extends
`node_development`, and introduces a shared workspace-context preflight for
all three. It does not remove `execute_command`, weaken directory boundaries,
or accept caller-provided executable paths, shell strings, flags, environment
variables, or script names outside declared allowlists.

## Tool contracts

### `git_workflow`

Actions are `status`, `diff`, `add_files`, `commit`, `push`, `branch_list`,
`checkout_branch`, `fetch`, `pull`, and `worktree_add`.

- `status`, `diff`, and `branch_list` are read-only.
- `add_files` accepts a bounded list of project-relative regular-file paths.
- `commit` accepts a UTF-8 message field and uses a temporary UTF-8 no-BOM
  message file; it never passes the message through a shell command line.
- `push`, `fetch`, and `pull` accept only validated remote and branch names.
- `worktree_add` accepts a repository-relative target directory and a validated
  branch or ref, then runs the fixed Git `worktree add` form.
- Git commands use `shell: false`; forced Git configuration prevents implicit
  helpers and interactive prompts.

### `java_development`

Actions are `maven_test`, `maven_package`, `maven_clean_test`, `gradle_test`,
`gradle_build`, and `gradle_assemble_debug`.

- The server resolves Maven from a trusted executable and Gradle only from the
  project wrapper after wrapper validation.
- Every action maps to a fixed argument array; the caller cannot append flags
  or select arbitrary Maven goals/Gradle tasks.
- Operations execute asynchronously through the existing development task
  coordinator and return a task ID.

### `node_development`

The existing PNPM actions remain backward compatible. New actions provide
fixed npm validation: `npm_ci`, `npm_test`, `npm_build`, `npm_lint`, and
`npm_typecheck`.

The server requires a matching `package.json` script for each script action;
it invokes only the fixed script name and never receives user-provided npm
arguments.

## Shared workspace gate

Each structured execution request requires `workspaceId` and `contextId`.
The service verifies that the context belongs to the owner, is fresh against
the trusted catalog digest, identifies the same workspace, and has reached
`instructions_ready` after all declared instruction files were acknowledged.
The requested working directory must be within that workspace and separately
authorized by the directory guard.

This makes different projects safe to use concurrently: a request is bound to
one owner, one catalog workspace, and one context ID. If a local workspace
catalog has not been configured, structured execution returns a deterministic
setup error with `nextAction=workspace_context.bootstrap`; it never guesses a
project.

## Approval and execution policy

Read-only Git actions do not create an approval. Git mutations, package
installation, Maven/Gradle/Node tests and builds, and remote Git operations
use a single-use exact approval. Approval scope binds tool, action, normalized
inputs, workspace context, and directory authorization digest.

All processes use direct executable-and-argument invocation (`shell: false`),
bounded timeout/output/concurrency, cancellation propagation, redacted logs,
and the existing task audit record. No action may launch PowerShell, cmd,
Python, or arbitrary local binaries.

## Architecture

- `src/development/workspaces/preflight.ts` owns the reusable context,
  instruction, catalog, and directory checks.
- `src/development/git/*` owns strict Git input validation and command plans.
- `src/development/java/*` owns trusted Maven/Gradle discovery and fixed plans.
- `src/tools/gitWorkflow.ts` and `src/tools/javaDevelopment.ts` remain thin
  MCP adapters; task execution uses the existing coordinator.
- `src/tools/nodeDevelopment.ts` consumes the same preflight and closed npm
  action map.

No application-specific project value is embedded in these shared modules.

## Acceptance criteria

1. Each tool rejects unknown actions, shell text, untrusted paths, stale or
   wrong-owner context IDs, and contexts with unread declared instructions.
2. Every accepted action, including `worktree_add`, produces a closed executable/argument plan with
   `shell: false`.
3. Read-only Git operations work within the selected context; mutations and
   all build/install/network actions request exact approval.
4. Unit tests cover every action mapping, approval classification, workspace
   isolation, invalid input, and no-shell invariant.
5. Existing tests remain green and `tools/list` / health report the expanded
   inventory.
6. Aily verification invokes a read-only action from each new domain and
   confirms the tools appear as structured actions rather than generic command
   execution.
