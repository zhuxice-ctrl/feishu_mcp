# Local Development Workbench Phase 1 Design

## Goal

Provide a single owner-approved, asynchronous `zeroxcore-web / verify_web` workflow that runs fixed PNPM typecheck, lint, selected-test, and build steps without accepting a shell command.

## Architecture

A protected operator-owned catalog maps stable workspace and recipe IDs to a closed Node workflow adapter. The adapter validates the small public schema, constructs a persisted workflow launch spec, and uses the existing coordinator. The existing Worker executes its validated steps serially and persists safe per-step results for the current task-query tools.

### Trust model

- The catalog file is operator-owned, stored inside `APPROVAL_DATA_DIR`, and never writable by an MCP caller.
- Only `pnpm` is permitted as the package manager.
- Only `typecheck`, `lint`, `test_selected`, and `build` step kinds are accepted.
- The exact first-phase recipe sequence is `typecheck → lint → test_selected → build`.
- Test file paths are restricted to safe relative tokens (no `..`, no absolute paths, no symlinks, recognized extensions only).
- No caller-supplied command, argument, environment, workdir, or timeout is accepted.

### Security boundaries

- Workspace roots and artifact directories are canonicalized through `realpathSync.native` to reject symlinks and path escapes.
- The public catalog view exposes only IDs and labels — never absolute roots.
- The workflow launch spec is persisted in a separate 0600 file and never returned to MCP callers.
- Output is redacted by the existing `StreamingTaskRedactor` before reaching disk.
- Step boundary markers are written by the worker, not the caller.
- Directory artifact summaries traverse only configured real directories without following links, cap entries and bytes, and return aggregates only.
- Approval is single-use, bound to the catalog recipe digest and normalized test paths.

## Components

### Workspace catalog (`src/development/workspaces/`)

- `types.ts` — Zod schemas with `.strict()` for catalog, workspace, recipe, step, and test-selection objects.
- `catalog.ts` — `loadLocalWorkspaceCatalog()`, `publicCatalog()`, `findWorkspace()`, `findRecipe()`, `recipeDigest()`, `catalogDigest()`.

### Workflow adapter (`src/development/web/`)

- `commands.ts` — Maps step kinds to fixed PNPM invocations. Reuses the Windows `cmd.exe /d /s /c pnpm.cmd` compatibility approach.
- `testFiles.ts` — Validates caller-supplied test file paths against the workspace root.

### Task persistence (`src/development/tasks/`)

- `types.ts` — `DevelopmentWorkflowLaunchSpec`, `DevelopmentWorkflowStep`, `DevelopmentTaskStepResult`, `DevelopmentDirectorySummary`, `DevelopmentTaskKind`, `DevelopmentStepState`.
- `store.ts` — `saveWorkflowSpec()`, `loadWorkflowSpec()`, `loadLaunchSpecForTask()`, and validators for all new types.
- `worker.ts` — `runWorkflowWorker()` executes steps serially with `shell: false`, enforces per-step and total timeouts, appends worker-owned log markers, and CAS-updates safe step results.
- `artifacts.ts` — `summarizeDirectory()`, `collectDirectorySummaries()`.

### MCP tools (`src/tools/`)

- `localWorkflows.ts` — `list_local_workspaces`, `run_local_workflow`.
- `developmentTasks.ts` — `list_development_tasks` (new), updated `publicTask` for workflow fields.

### Coordinator (`src/development/tasks/coordinator.ts`)

- `enqueueWorkflow()` — Creates a `kind: "workflow"` task, saves the workflow spec, and dispatches the worker.

## Tool inventory

The MCP tool count increases from 32 to 35:

1. `list_local_workspaces` — Public catalog view (owner-only).
2. `run_local_workflow` — Enqueue a fixed verification workflow (owner-only, single-use approval).
3. `list_development_tasks` — List the caller's safe task views (owner-only).

## Aily behavior contract

1. Call `list_local_workspaces` to discover workspace and recipe IDs.
2. Call `run_local_workflow` with the workspace ID, recipe ID, and optional test files.
3. The tool returns `{ ok, taskId, state, workspaceId, recipeId }` after the owner approves.
4. Poll `get_development_task` (or recover via `list_development_tasks`) until the state is terminal.
5. Use `read_development_task_logs` to cursor through redacted stdout/stderr.
6. Never claim verification success before the task state is `succeeded`.
7. Never substitute a command block or use `execute_command` to bypass the workflow.
