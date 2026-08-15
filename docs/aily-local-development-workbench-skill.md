# Local Development Workbench Skill

## Overview

The local development workbench provides an owner-approved, asynchronous PNPM verification workflow for web projects. It runs fixed typecheck, lint, selected-test, and build steps without accepting a shell command from the AI caller.

## Prerequisites

- `OWNER_USER_ID` must be configured.
- A protected local workspace catalog file must exist at `LOCAL_WORKSPACE_CATALOG_PATH` (defaults to `APPROVAL_DATA_DIR/local-workspaces.json`).
- The catalog must contain at least one workspace with a `verify_web` recipe.
- PNPM must be installed and available on the system PATH.

## Operator setup

1. Copy `config/local-workspaces.example.json` to `APPROVAL_DATA_DIR/local-workspaces.json`.
2. Edit the file to point `root` at the real project directory.
3. Add artifact directories (e.g., `dist`, `.next`) for post-build summaries.
4. Ensure the recipe steps match the project's PNPM scripts.

## Aily workflow

### Step 1: List workspaces

```
list_local_workspaces → { workspaces: [{ id, label, recipes: [...] }] }
```

### Step 2: Run a verification workflow

```
run_local_workflow({ workspaceId, recipeId, testFiles? }) → { ok, taskId, state, workspaceId, recipeId }
```

The owner must approve the single-use request. The approval digest is bound to the catalog recipe digest and the normalized test file list.

### Step 3: Poll for completion

```
get_development_task({ taskId }) → { task: { state, stage, steps?, ... } }
```

Or, if the session was interrupted, rediscover the task ID:

```
list_development_tasks({ state?: "queued" | "running" | "terminal" }) → { tasks: [...] }
```

### Step 4: Read logs

```
read_development_task_logs({ taskId, stream, cursorStdout, cursorStderr }) → { stdout, stderr, nextCursors, eof, truncated }
```

### Step 5: Cancel if needed

```
cancel_development_task({ taskId }) → { ok, state, alreadyTerminal }
```

## Rules

1. **Never claim success before `succeeded`.** The task state must be `succeeded` before reporting verification success.
2. **Never use `execute_command` to bypass the workflow.** The workflow is the only sanctioned verification path.
3. **Never substitute a command block.** The fixed PNPM steps are the only commands that run.
4. **Never expose launch specs, workspace roots, or worker details.** Only the public task view is safe to share.
5. **Report failures honestly.** If a step fails, report which step and its exit code. Do not retry automatically without user awareness.

## Step result states

Each step in a workflow task has one of these states:

- `pending` — Not yet started.
- `running` — Currently executing.
- `succeeded` — Exit code 0.
- `failed` — Nonzero exit or timeout.
- `skipped` — A prior step failed; this step was not executed.
- `cancelled` — The task was cancelled while this step was pending or running.

## Directory summaries

After all workflow steps succeed, the worker publishes aggregate directory summaries for each configured artifact directory. The summary includes:

- `id` — Directory basename.
- `kind` — Always `"directory-summary"`.
- `fileCount` — Number of files (capped at 100,000).
- `byteTotal` — Total bytes (capped at 1 GiB).
- `path` — Only shown when the directory remains inside an authorized root.

## Cancellation and recovery

- Cancelled tasks terminate the active child process and mark pending steps as `skipped`.
- If the session is interrupted, use `list_development_tasks` to rediscover the task ID.
- The coordinator recovers queued and running tasks on restart, marking stale work as `interrupted`.
