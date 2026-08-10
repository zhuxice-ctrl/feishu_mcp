# Restricted Node Development Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a structured `node_development` MCP tool for four approved PNPM actions in an explicitly authorized working directory.

**Architecture:** A new focused tool module owns the allowlist, directory guard, approval, and shell-free process execution. `src/index.ts` registers the tool and exposes it in the inventory; existing concurrency, process, approval, and directory-authorization primitives remain the enforcement points.

**Tech Stack:** TypeScript, Zod, `@modelcontextprotocol/server`, Node.js built-in test runner.

---

### Task 1: Define the restricted PNPM action contract with tests

**Files:**
- Create: `test/node-development-tool.test.mjs`
- Create: `src/tools/nodeDevelopment.ts`
- Test: `test/node-development-tool.test.mjs`

- [ ] **Step 1: Write the failing unit tests for the public action mapping**

Create `test/node-development-tool.test.mjs` with a direct import from the compiled tool module and these mapping assertions:

```js
import assert from "node:assert/strict";
import test from "node:test";

const { NODE_ACTIONS, resolveNodeAction } = await import("../dist/tools/nodeDevelopment.js");

test("exports exactly the four approved PNPM actions", () => {
  assert.deepEqual(Object.keys(NODE_ACTIONS), [
    "pnpm_version", "test_run", "build", "typecheck",
  ]);
  assert.deepEqual(resolveNodeAction("pnpm_version"), { executable: "pnpm", args: ["--version"] });
  assert.deepEqual(resolveNodeAction("test_run"), { executable: "pnpm", args: ["test:run"] });
  assert.deepEqual(resolveNodeAction("build"), { executable: "pnpm", args: ["build"] });
  assert.deepEqual(resolveNodeAction("typecheck"), { executable: "pnpm", args: ["typecheck"] });
});
```

- [ ] **Step 2: Run the test to verify it fails before implementation**

Run:

```powershell
npm run build; node --test test/node-development-tool.test.mjs
```

Expected: the build or test fails because `dist/tools/nodeDevelopment.js` does not exist.

- [ ] **Step 3: Add the minimal immutable action map**

Create `src/tools/nodeDevelopment.ts` with these exported definitions before adding execution logic:

```ts
export type NodeDevelopmentAction = "pnpm_version" | "test_run" | "build" | "typecheck";

export const NODE_ACTIONS: Readonly<Record<NodeDevelopmentAction, {
  executable: "pnpm";
  args: readonly string[];
}>> = {
  pnpm_version: { executable: "pnpm", args: ["--version"] },
  test_run: { executable: "pnpm", args: ["test:run"] },
  build: { executable: "pnpm", args: ["build"] },
  typecheck: { executable: "pnpm", args: ["typecheck"] },
};

export function resolveNodeAction(action: NodeDevelopmentAction) {
  const resolved = NODE_ACTIONS[action];
  return { executable: resolved.executable, args: [...resolved.args] };
}
```

- [ ] **Step 4: Run the mapping test to verify it passes**

Run:

```powershell
npm run build; node --test test/node-development-tool.test.mjs
```

Expected: the mapping test passes and no string-valued arbitrary-command input exists.

- [ ] **Step 5: Commit the contract**

```powershell
git add src/tools/nodeDevelopment.ts test/node-development-tool.test.mjs
git commit -m "feat: define restricted pnpm action contract"
```

### Task 2: Add guarded approval and shell-free execution

**Files:**
- Modify: `src/tools/nodeDevelopment.ts`
- Modify: `test/node-development-tool.test.mjs`
- Test: `test/node-development-tool.test.mjs`

- [ ] **Step 1: Add failing tests for required workdir and approval**

Extend the test file with a temporary allowed directory, an approval-data directory, and a modern MCP context. Assert that an action without `workdir` returns `INVALID_ARGUMENT`, and that a first valid action returns `input_required` instead of starting PNPM:

```js
const result = await nodeDevelopment({ action: "pnpm_version" }, context());
assert.equal(JSON.parse(result.content[0].text).code, "INVALID_ARGUMENT");

const pending = await nodeDevelopment(
  { action: "pnpm_version", workdir: workspace },
  context(),
);
assert.equal(pending.resultType, "input_required");
assert.ok(pending.requestState);
```

Use the same environment setup and `context()` shape as `test/command-tool.test.mjs`, with `ALLOWED_DIRS` set to the temporary workspace and `AUTH_MODE=none`.

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
npm run build; node --test test/node-development-tool.test.mjs
```

Expected: failure because `nodeDevelopment` is not exported yet.

- [ ] **Step 3: Implement validation, directory authorization, approval, and execution**

Add these imports and public input type to `src/tools/nodeDevelopment.ts`:

```ts
import fs from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { COMMAND_MAX_OUTPUT_BYTES, COMMAND_MAX_TIMEOUT_MS, COMMAND_TIMEOUT_MS } from "../config.js";
import { getRequestUserId } from "../security/requestContext.js";
import { containsInternalApprovalPath, isInternalApprovalPath } from "../security/approvalStore.js";
import { digestArguments, requestApproval } from "../security/approval.js";
import { authorizeToolCall } from "../security/toolAccess.js";
import { resolvePathsGuardAndAuthorize } from "./helpers.js";
import { runProcess } from "./processRunner.js";
import { runTool } from "./registry.js";
import { toolError, toolJson } from "./results.js";

export interface NodeDevelopmentArgs {
  action: NodeDevelopmentAction;
  workdir: string;
  timeout?: number;
}
```

Implement `nodeDevelopment(args, ctx)` in this order:

```ts
if (!args.workdir?.trim()) {
  return toolError("INVALID_ARGUMENT", "workdir is required.");
}
const guard = await resolvePathsGuardAndAuthorize(
  "node_development",
  [{ argName: "workdir", inputPath: args.workdir, operation: "read", scope: "directory", access: "command" }],
  args,
  ctx,
);
if (!guard.ok) return guard.result ?? toolError("OUTSIDE_ALLOWED_DIRS", guard.error ?? "Invalid working directory.");
const workdir = guard.paths[0].resolvedPath;
if (isInternalApprovalPath(workdir) || containsInternalApprovalPath(workdir)) {
  return toolError("OUTSIDE_ALLOWED_DIRS", "The internal approval directory cannot be used as a working directory.");
}
if (!fs.existsSync(workdir) || !fs.statSync(workdir).isDirectory()) {
  return toolError("INVALID_ARGUMENT", "The working directory does not exist or is not a directory.");
}
```

Request standard approval using `tool: "node_development"`, `kind: "development"`, a SHA-256 key over `action`, `workdir`, and `timeoutMs`, `digestArguments(args)`, and the directory-proof digest. On approval, resolve a fixed invocation and call `runProcess(invocation.executable, invocation.args, { cwd: workdir, timeoutMs, maxOutputBytes: COMMAND_MAX_OUTPUT_BYTES, signal: ctx.mcpReq.signal, env: { ...process.env } })` inside `runTool` with `concurrency: "command"` and a `development` subject. Return `toolJson({ ok: true, action: args.action, ...result })`.

On Windows, `resolveNodeInvocation` must use `cmd.exe /d /s /c` with a command fragment assembled only from `pnpm.cmd` and the closed action map, because Node cannot directly spawn `.cmd` files with `shell: false`. On non-Windows hosts, call `pnpm` directly. Do not call `executeCommand`, and do not add a `command`, `args`, `script`, `executable`, or environment field to the schema.

- [ ] **Step 4: Register the restricted MCP schema**

Add `registerNodeDevelopmentTool(server)` to `src/tools/nodeDevelopment.ts`:

```ts
server.registerTool("node_development", {
  description: "Run one approved PNPM development action in an authorized working directory. " +
    "Supported actions are pnpm_version, test_run, build, and typecheck; arbitrary commands and arguments are not accepted.",
  inputSchema: {
    action: z.enum(["pnpm_version", "test_run", "build", "typecheck"]),
    workdir: z.string().min(1),
    timeout: z.number().int().positive().optional(),
  },
}, async (args, ctx) => authorizeToolCall("node_development", args) ?? nodeDevelopment(args, ctx));
```

- [ ] **Step 5: Run the unit test to verify guarded behavior**

Run:

```powershell
npm run build; node --test test/node-development-tool.test.mjs
```

Expected: the missing-workdir assertion returns `INVALID_ARGUMENT`, and a valid first call returns an Aily `input_required` approval request without starting PNPM.

- [ ] **Step 6: Commit the guarded executor**

```powershell
git add src/tools/nodeDevelopment.ts test/node-development-tool.test.mjs
git commit -m "feat: add approved pnpm development tool"
```

### Task 3: Publish the tool in the server inventory

**Files:**
- Modify: `src/index.ts:63-103,223-252`
- Modify: `test/tools-list.test.mjs:10-65`
- Test: `test/tools-list.test.mjs`

- [ ] **Step 1: Update the inventory test before registration**

Insert `"node_development"` after `"windows_development"` in the `expected` array, change the test title to `production MCP advertises exactly the 32-tool inventory`, and change the uniqueness assertion from `31` to `32`.

- [ ] **Step 2: Run the inventory test to verify it fails**

Run:

```powershell
npm run build; node --test test/tools-list.test.mjs
```

Expected: the actual inventory lacks `node_development` and has 31 tools.

- [ ] **Step 3: Register the tool and update health inventory**

In `src/index.ts`, add:

```ts
import { registerNodeDevelopmentTool } from "./tools/nodeDevelopment.js";
```

Add `"node_development"` to `TOOL_NAMES` immediately after `"windows_development"`, and call:

```ts
registerNodeDevelopmentTool(server);
```

after `registerWindowsDevelopmentTool(...)` and before `registerDevelopmentProjectTool(...)`.

- [ ] **Step 4: Run the inventory test to verify it passes**

Run:

```powershell
npm run build; node --test test/tools-list.test.mjs
```

Expected: the spawned production server returns exactly 32 unique tools, including `node_development`.

- [ ] **Step 5: Commit server registration**

```powershell
git add src/index.ts test/tools-list.test.mjs
git commit -m "feat: register node development MCP tool"
```

### Task 4: Update user-facing documentation and onboarding guidance

**Files:**
- Modify: `README.md`
- Modify: `docs/aily-integration-guide.md`
- Modify: `skills/personal-mcp-onboarding/SKILL.md`
- Test: `npm run build`, targeted text searches

- [ ] **Step 1: Update README inventory and Node workflow**

Change every current 31-tool claim to 32. Add `node_development` to the development-tool group. Replace the statement that `execute_command` is the only command-execution tool with a distinction: `execute_command` remains the generic local capability, while `node_development` is the Aily-compatible structured route for `pnpm_version`, `test_run`, `build`, and `typecheck`.

Add this Aily prompt example:

```text
请调用 node_development，action 为 typecheck，workdir 为已授权 Node 项目目录。
如需审批，请在当前窗口展示审批卡；不要改用任意 shell 命令。
```

State that Aily registration for this personal MCP must use a fixed `Authorization` request header to permit server-side tool discovery, and that the actual `Bearer` token belongs only in its fixed parameter value—not in a description, display name, image, or ordinary conversation.

- [ ] **Step 2: Update the Aily integration guide**

Change the stated inventory to 32. In the registration section, change `Authorization` transmission from `用户输入` to `固定值` for this owner-only personal MCP and warn that the value is `Bearer <the user's own MCP_AUTH_TOKEN>` and must not be copied into the optional description. Keep `x-aily-user=owner` as a fixed header and “仅自己” scope.

In the test checklist, add `node_development` with all four action names and required `workdir`; explain that it is the preferred Aily route when generic `execute_command` is not attached to the agent.

- [ ] **Step 3: Update the personal onboarding skill**

Add Node/PNPM to the base detection checklist. In the Aily registration guidance, require a fixed Authorization header for tool discovery on this personal MCP, maintain owner-only scope, and never print a real token. Add a teaching example that asks Aily to call `node_development` with one of the four approved actions and an authorized project directory.

- [ ] **Step 4: Verify documentation consistency**

Run:

```powershell
rg -n "31 个工具|31-tool|30 个工具|30-tool|唯一的命令执行工具|用户输入" README.md docs/aily-integration-guide.md skills/personal-mcp-onboarding/SKILL.md
npm run build
```

Expected: no obsolete inventory or user-input registration claim remains for the personal Aily configuration, and the TypeScript build succeeds.

- [ ] **Step 5: Commit documentation**

```powershell
git add README.md docs/aily-integration-guide.md skills/personal-mcp-onboarding/SKILL.md
git commit -m "docs: document structured pnpm development workflow"
```

### Task 5: Run the complete verification suite and publish

**Files:**
- Test: `test/node-development-tool.test.mjs`
- Test: `test/tools-list.test.mjs`
- Test: all `test/*.test.mjs`

- [ ] **Step 1: Run focused behavior and inventory checks**

Run:

```powershell
npm run build
node --test test/node-development-tool.test.mjs test/tools-list.test.mjs
```

Expected: both focused test files pass.

- [ ] **Step 2: Run type checking and the full regression suite**

Run:

```powershell
npm run typecheck
npm test
```

Expected: TypeScript exits with code 0 and all Node tests pass.

- [ ] **Step 3: Inspect the final change set**

Run:

```powershell
git status --short
git diff --check HEAD~4..HEAD
git log --oneline -5
```

Expected: only the planned code, tests, documentation, specification, and plan commits are present; whitespace validation reports no errors.

- [ ] **Step 4: Push the completed commits to the current branch’s upstream remote**

Run:

```powershell
git push
```

Expected: Git reports that the commits were accepted by the configured upstream branch.
