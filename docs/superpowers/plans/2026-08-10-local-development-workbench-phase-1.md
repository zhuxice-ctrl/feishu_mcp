# Local Development Workbench — Phase 1

**Date:** 2026-08-10
**Branch:** `codex/local-development-workbench-phase-1`
**Base:** `87fd0a3e2c122069247e00bd1ef54034e314ff27`

## Goal

Provide an owner-approved asynchronous workflow that runs fixed PNPM type-check, lint, selected-test, and build steps for `zeroxcore-web` without accepting shell commands. MCP tool count increases from 32 to 35.

## Tasks

| # | Task | Status |
|---|------|--------|
| 1 | Workspace directory + catalog loader | Done |
| 2 | Extend task contract (kind, steps, directorySummaries) | Done |
| 3 | Worker sequential step execution | Done |
| 4 | Web adapter + MCP tools | Done |
| 5 | Directory artifact summary | Done |
| 6 | Documentation | Done |

## Files Changed

### New files (14)
- `src/development/workspaces/types.ts` — Zod schemas for workspace catalog
- `src/development/workspaces/catalog.ts` — Catalog loader, validation, public views
- `config/local-workspaces.example.json` — Template catalog
- `src/development/web/commands.ts` — Workflow step → pnpm arg mapping
- `src/development/web/testFiles.ts` — Test file path validation
- `src/tools/localWorkflows.ts` — list_local_workspaces + run_local_workflow tools
- `test/fixtures/development-workflow-fixture.mjs` — Test fixture
- `docs/specs/2026-08-10-local-development-workbench-phase-1-design.md` — Design doc
- `docs/aily-local-development-workbench-skill.md` — Operator skill doc
- `test/local-workspace-catalog.test.mjs` — Catalog tests
- `test/local-workflow-tool.test.mjs` — Adapter/tool tests
- `test/development-workflow-store.test.mjs` — Workflow store tests
- `test/development-workflow-worker.test.mjs` — Workflow worker tests

### Modified files (9)
- `src/development/tasks/types.ts` — Added workflow types
- `src/development/tasks/store.ts` — Added workflow spec persistence
- `src/development/tasks/worker.ts` — Added runWorkflowWorker()
- `src/development/tasks/artifacts.ts` — Added summarizeDirectory()
- `src/development/tasks/coordinator.ts` — Added enqueueWorkflow()
- `src/tools/developmentTasks.ts` — Added list_development_tasks tool
- `src/config.ts` — Added LOCAL_WORKSPACE_CATALOG_PATH
- `src/index.ts` — Registered 3 new tools
- `.gitignore` — Added local-workspaces.json

### Updated test files (4)
- `test/tools-list.test.mjs` — 32→35 tools
- `test/complete-tools-e2e.test.mjs` — Added 3 new tool names
- `test/launcher.test.mjs` — 32→35 tools
- `test/development-docs.test.mjs` — 32→35 tools

## New MCP Tools

| Tool | Owner-only | Description |
|------|-----------|-------------|
| `list_local_workspaces` | Yes | Returns public catalog of configured workspaces/recipes |
| `run_local_workflow` | Yes | Enqueues a workflow task with single-use approval |
| `list_development_tasks` | Yes | Lists up to 50 recent development tasks |

## Verification Commands

```bash
# 1. Type check
pnpm typecheck

# 2. Lint
pnpm lint:check

# 3. Run new tests
pnpm test:run -- test/local-workspace-catalog.test.mjs
pnpm test:run -- test/local-workflow-tool.test.mjs
pnpm test:run -- test/development-workflow-store.test.mjs
pnpm test:run -- test/development-workflow-worker.test.mjs

# 4. Run updated tests
pnpm test:run -- test/tools-list.test.mjs
pnpm test:run -- test/complete-tools-e2e.test.mjs
pnpm test:run -- test/launcher.test.mjs
pnpm test:run -- test/development-docs.test.mjs

# 5. Full test suite
pnpm test:run

# 6. Build
pnpm build

# 7. Git
git add -A
git status
git diff --cached --stat
```

## Known Risks

1. **TS first-pass rework likely** — Complex TypeScript ESM with Zod schemas; blind write without compiler feedback.
2. **Test file paths** — 4 new test files need to be placed in `test/` directory (downloaded from Feishu Drive links).
3. **Workflow fixture** — The `development-workflow-fixture.mjs` accepts `--step`, `--exit`, `--stdout`, `--stderr`, `--delay` args; worker tests use `process.execPath` as the "pnpm" executable with fixture args.
4. **README** — Needs manual update: tool count 32→35, add 3 new tool descriptions.
