# Python Development Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with review checkpoints.

**Goal:** Add a registered `python_development` MCP tool that safely runs Python, virtual-environment scripts, and pytest inside authorized workspaces without exposing generic shell execution.

**Architecture:** Follow the existing `node_development`/`java_development` pattern. Keep interpreter discovery, path checks, and argument-vector construction in pure functions; the MCP adapter performs owner authorization, directory proof, bounded process execution, and redacted results. The composition root owns registration and inventory updates.

**Tech Stack:** TypeScript, Zod, Node `child_process` runner already used by the repository, Node test runner, MCP server registration.

---

### Task 1: Pure Python command contract

**Files:**
- Create: `src/tools/pythonDevelopment.ts`
- Test: `test/python-development-tool.test.mjs`

- [ ] **Step 1: Add failing contract tests** for action validation, interpreter selection order (`.venv/Scripts/python.exe`, `.venv/bin/python`, `py`), script/module exclusivity, pytest target/ignore shape, traversal rejection, and direct argument vectors.
- [ ] **Step 2: Run `node --test test/python-development-tool.test.mjs`** and verify the new exports are missing.
- [ ] **Step 3: Implement pure functions and types:** `PythonDevelopmentAction`, `resolvePythonInterpreter`, `buildPythonInvocation`, `validateRelativeTarget`, and `buildPytestArgs`. Use `path.resolve` plus `path.relative` containment checks; reject shell metacharacters and absolute targets outside `workdir`.
- [ ] **Step 4: Run the focused test file** and verify all contract tests pass without requiring Python or pytest.
- [ ] **Step 5: Commit** with `feat: add constrained python command contract`.

### Task 2: MCP execution adapter

**Files:**
- Modify: `src/tools/pythonDevelopment.ts`
- Test: `test/python-development-tool.test.mjs`

- [ ] **Step 1: Add failing adapter tests** for required `workdir`, missing script, owner authorization, directory guard, bounded timeout, cancellation signal, output limit, and no-shell invocation.
- [ ] **Step 2: Implement `pythonDevelopment(args, ctx)`:** resolve and authorize `workdir`, reject internal approval paths, resolve the interpreter, construct an argv array, request the existing single-use development approval, call `runProcess` through `runTool`, and return `toolJson`/`toolError` with the existing redaction behavior.
- [ ] **Step 3: Register `python_development`** with a strict Zod schema. Actions are `python_version`, `script_run`, and `pytest_run`; `pytestArgs` contains only `targets`, `ignore`, and `quiet`; unknown fields and raw flags are rejected.
- [ ] **Step 4: Run the focused tests** and verify adapter behavior and error codes.
- [ ] **Step 5: Commit** with `feat: register constrained python development execution`.

### Task 3: Composition root and inventory

**Files:**
- Modify: `src/index.ts`
- Modify: `test/tools-list.test.mjs`
- Modify: `test/complete-tools-e2e.test.mjs`

- [ ] **Step 1: Add failing inventory assertions** expecting exactly one additional tool named `python_development`.
- [ ] **Step 2: Import and register `registerPythonDevelopmentTool(server)`** beside the existing structured development tools and append the name to `TOOL_NAMES`.
- [ ] **Step 3: Run inventory tests** and verify the count and registration pass.
- [ ] **Step 4: Commit** with `feat: expose python development tool in MCP inventory`.

### Task 4: Documentation and regression verification

**Files:**
- Modify: `README.md`
- Modify: `docs/aily-integration-guide.md`
- Modify: `test/development-docs.test.mjs`

- [ ] **Step 1: Add documentation assertions** for `python_development`, virtual-environment usage, and the prohibition on arbitrary shell strings.
- [ ] **Step 2: Document the Aily call shape:** `action=pytest_run`, `workdir`, structured `targets`/`ignore`; include the image-equivalent example without embedding a shell command.
- [ ] **Step 3: Run `npm run build` and the full relevant test set** (`python-development`, tool inventory, development docs, and existing development tests).
- [ ] **Step 4: Review `git diff --check` and verify no secrets or generic shell execution were introduced.
- [ ] **Step 5: Commit** with `docs: document constrained python validation route`.

### Task 5: Deployment handoff

**Files:**
- No source changes unless verification finds a defect.

- [ ] **Step 1: Build the production bundle** with `npm run build`.
- [ ] **Step 2: Restart only the MCP process after the user confirms a maintenance window; do not alter tunnel configuration.**
- [ ] **Step 3: Refresh the Aily tool discovery and verify `python_development` appears.
- [ ] **Step 4: Run a safe smoke call using `python_version` in an authorized directory; do not run a project script until the user supplies the target project.

