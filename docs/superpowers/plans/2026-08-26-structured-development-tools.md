# Structured Development Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver safe, Aily-visible structured Git, Java, and Node development actions bound to a selected workspace context rather than generic shell execution.

**Architecture:** A shared preflight validates the owner-scoped workspace context, the trusted catalog digest, read instruction files, and directory access. Git and Java action planners return closed `shell: false` launch specs; thin MCP adapters apply exact approval and route mutating/long operations through the existing development task coordinator. Node retains its existing public actions while adding fixed npm actions under the same preflight.

**Tech Stack:** TypeScript, Zod, Node child-process spawning, existing `DevelopmentTaskCoordinator`, Node test runner.

---

## File map

- Create: `src/development/workspaces/preflight.ts` — reusable selected-context and directory validation.
- Create: `src/development/git/contracts.ts` — Git action schemas and pure closed command plans.
- Create: `src/development/java/contracts.ts` — Java action schemas, Maven lookup, Gradle wrapper plans.
- Create: `src/tools/gitWorkflow.ts` — owner-facing Git MCP adapter.
- Create: `src/tools/javaDevelopment.ts` — owner-facing Java MCP adapter.
- Modify: `src/tools/nodeDevelopment.ts` — npm actions and workspace preflight.
- Modify: `src/index.ts` — construction and registration of the two new tools and inventory.
- Modify: `README.md` — structured Git/Java/Node capability and context-first use.
- Create: `test/workspace-preflight.test.mjs`, `test/git-workflow.test.mjs`, `test/java-development.test.mjs`, `test/node-development-structured.test.mjs`.
- Modify: `test/tools-list.test.mjs`, `test/complete-tools-e2e.test.mjs` — expected inventory.

### Task 1: Context-first shared preflight

**Files:**
- Create: `src/development/workspaces/preflight.ts`
- Test: `test/workspace-preflight.test.mjs`

- [ ] **Step 1: Write failing preflight tests**

```js
test('accepts a fresh instructions_ready context for its workspace only', () => {
  const result = requireWorkspaceExecutionContext(deps, {
    ownerKey: OWNER_A, workspaceId: 'java-app', contextId: CONTEXT_A,
    workdir: 'F:\\work\\java-app',
  });
  assert.equal(result.ok, true);
});

test('rejects a selected context whose instruction files are unread', () => {
  assert.equal(result.code, 'WORKSPACE_INSTRUCTIONS_REQUIRED');
  assert.equal(result.nextAction.tool, 'workspace_context');
  assert.equal(result.nextAction.action, 'mark_instructions_read');
});

test('rejects owner, workspace, digest, and directory mismatches', () => {
  for (const result of results) assert.equal(result.ok, false);
});
```

- [ ] **Step 2: Run the focused test before implementation**

Run: `node --test test/workspace-preflight.test.mjs`  
Expected: FAIL because `preflight.js` does not exist.

- [ ] **Step 3: Implement `requireWorkspaceExecutionContext`**

Export a dependency-injected function that loads the local catalog, gets the
context by `ownerKey + contextId`, compares `workspaceId` and catalog digest,
requires `phase === "instructions_ready"` or a later legal phase, validates
the supplied `workdir` is inside the catalog root, and calls the existing
directory access predicate. Return `toolError`-compatible deterministic
errors:

```ts
type WorkspaceExecutionResult =
  | { ok: true; workspace: TrustedWorkspace; context: WorkspaceContext; workdir: string }
  | { ok: false; result: ReturnType<typeof toolError> };
```

Errors must use `WORKSPACE_CONTEXT_NOT_FOUND`, `WORKSPACE_CONTEXT_STALE`,
`WORKSPACE_MISMATCH`, `WORKSPACE_INSTRUCTIONS_REQUIRED`, or
`WORKSPACE_NOT_AUTHORIZED`, with `nextAction` pointing to
`workspace_context.bootstrap` or `workspace_context.mark_instructions_read`.

- [ ] **Step 4: Run preflight tests**

Run: `node --test test/workspace-preflight.test.mjs`  
Expected: all tests pass.

- [ ] **Step 5: Commit the preflight boundary**

```powershell
git add src/development/workspaces/preflight.ts test/workspace-preflight.test.mjs
git commit -F <utf8-no-bom-message-file>
```

### Task 2: Closed Git contracts and command planning

**Files:**
- Create: `src/development/git/contracts.ts`
- Test: `test/git-workflow.test.mjs`

- [ ] **Step 1: Write failing Git contract tests**

```js
test('buildGitPlan maps status to a non-shell status command', () => {
  assert.deepEqual(buildGitPlan({ action: 'status' }, root).args,
    ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', 'status', '--short', '--branch']);
});

test('add_files accepts only project-relative regular-file names', () => {
  assert.throws(() => parseGitWorkflow({ action: 'add_files', files: ['..\\secret'] }));
});

test('commit message is passed via a server-created message file', () => {
  assert.match(buildGitCommitMessage('feat: import').messagePath, /\.txt$/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/git-workflow.test.mjs`  
Expected: FAIL because the Git contract module does not exist.

- [ ] **Step 3: Implement strict Git schemas and plans**

Define `GitWorkflowInput` as a strict discriminated union with actions
`status`, `diff`, `branch_list`, `add_files`, `commit`, `push`, `fetch`,
`pull`, and `checkout_branch`. Every variant includes `workspaceId`,
`contextId`, and `workdir`; only `add_files`, `commit`, and remote operations
add their fixed fields. Reject absolute paths, traversal, shell metacharacters,
leading options, and more than 64 staged files. Build plans using:

```ts
const GIT_PREFIX = ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'credential.interactive=false'];
```

The `commit` plan uses `git commit -F <temporary UTF-8-no-BOM file>`; create
and delete that file in the adapter, never in caller-controlled paths.

- [ ] **Step 4: Run the contract tests**

Run: `node --test test/git-workflow.test.mjs`  
Expected: all mapping, validation, and no-shell assertions pass.

- [ ] **Step 5: Commit Git planning**

```powershell
git add src/development/git/contracts.ts test/git-workflow.test.mjs
git commit -F <utf8-no-bom-message-file>
```

### Task 3: `git_workflow` MCP adapter

**Files:**
- Create: `src/tools/gitWorkflow.ts`
- Modify: `src/index.ts`
- Modify: `test/tools-list.test.mjs`
- Modify: `test/complete-tools-e2e.test.mjs`
- Test: `test/git-workflow.test.mjs`

- [ ] **Step 1: Add failing adapter tests**

```js
test('git_workflow status is synchronous and does not request approval', async () => {
  const result = await gitWorkflow({ action: 'status', ...context }, deps, ctx);
  assert.equal(result.ok, true);
  assert.equal(requestApproval.calls.length, 0);
});

test('git_workflow push requires exact approval and queues a task', async () => {
  const result = await gitWorkflow({ action: 'push', remote: 'origin', branch: 'main', ...context }, deps, ctx);
  assert.equal(result.state, 'queued');
});
```

- [ ] **Step 2: Run adapter tests before implementation**

Run: `node --test test/git-workflow.test.mjs`  
Expected: FAIL because `git_workflow` is not registered.

- [ ] **Step 3: Implement the adapter and register it**

Call `authorizeOwnerToolCall`, then the shared preflight. Execute `status`,
`diff`, and `branch_list` synchronously via `runProcess` with `shell: false`.
For `add_files`, `commit`, `push`, `fetch`, `pull`, and `checkout_branch`, call
`requestApproval` with the parsed input digest and enqueue a closed launch
spec on the existing `DevelopmentTaskCoordinator`. Remove the temporary commit
message file once the worker has consumed it, including cancellation/error
paths. Add `git_workflow` to the inventory and test expectations.

- [ ] **Step 4: Run focused adapter and inventory tests**

Run: `node --test test/git-workflow.test.mjs test/tools-list.test.mjs test/complete-tools-e2e.test.mjs`  
Expected: pass with the inventory increased from 37 to 38.

- [ ] **Step 5: Commit Git workflow tool**

```powershell
git add src/tools/gitWorkflow.ts src/index.ts test/git-workflow.test.mjs test/tools-list.test.mjs test/complete-tools-e2e.test.mjs
git commit -F <utf8-no-bom-message-file>
```

### Task 4: Closed Java contracts and task adapter

**Files:**
- Create: `src/development/java/contracts.ts`
- Create: `src/tools/javaDevelopment.ts`
- Modify: `src/index.ts`
- Test: `test/java-development.test.mjs`

- [ ] **Step 1: Write failing Java plan tests**

```js
test('maven_clean_test always builds mvn clean test without caller flags', () => {
  assert.deepEqual(buildJavaPlan({ action: 'maven_clean_test' }, root, tools).args, ['clean', 'test']);
});

test('gradle actions require a valid project wrapper', () => {
  assert.throws(() => buildJavaPlan({ action: 'gradle_test' }, rootWithoutWrapper, tools));
});

test('unknown action and executable override are rejected by the strict schema', () => {
  assert.throws(() => parseJavaDevelopment({ action: 'maven_test', executable: 'cmd.exe' }));
});
```

- [ ] **Step 2: Run Java tests before implementation**

Run: `node --test test/java-development.test.mjs`  
Expected: FAIL because Java contracts do not exist.

- [ ] **Step 3: Implement Java contracts**

Use a strict union with six actions and common `workspaceId`, `contextId`, and
`workdir`. Maven resolves only a known `mvn.cmd`/`mvn` executable from trusted
toolchain discovery; actions map to `test`, `package`, and `clean test`.
Gradle resolves only `gradlew.bat` on Windows or `gradlew` elsewhere after
reusing wrapper validation; actions map to `test`, `build`, and
`assembleDebug`. No action accepts a project task, flag, executable, URL, or
environment override.

- [ ] **Step 4: Implement and register `java_development`**

Use owner authorization, shared preflight, exact single-use approval, then
enqueue `DevelopmentLaunchSpec` with class `build`, resource lock equal to the
canonical workspace root, bounded timeout/output, and `shell: false`. Register
the tool and update inventory assertions.

- [ ] **Step 5: Run Java and inventory tests**

Run: `node --test test/java-development.test.mjs test/tools-list.test.mjs test/complete-tools-e2e.test.mjs`  
Expected: pass with inventory increased from 38 to 39.

- [ ] **Step 6: Commit Java adapter**

```powershell
git add src/development/java/contracts.ts src/tools/javaDevelopment.ts src/index.ts test/java-development.test.mjs test/tools-list.test.mjs test/complete-tools-e2e.test.mjs
git commit -F <utf8-no-bom-message-file>
```

### Task 5: Extend Node with closed npm actions

**Files:**
- Modify: `src/tools/nodeDevelopment.ts`
- Test: `test/node-development-structured.test.mjs`

- [ ] **Step 1: Write failing npm action tests**

```js
test('npm_build maps only to npm run build', () => {
  assert.deepEqual(resolveNodeInvocation('npm_build').args, ['/d', '/s', '/c', 'npm.cmd run build']);
});

test('npm_lint rejects a project without a lint script before approval', async () => {
  assert.equal(result.code, 'NPM_SCRIPT_MISSING');
});

test('legacy pnpm actions retain their exact existing argument mapping', () => {
  assert.deepEqual(resolveNodeAction('build'), { executable: 'pnpm', args: ['build'] });
});
```

- [ ] **Step 2: Run Node tests before implementation**

Run: `node --test test/node-development-structured.test.mjs`  
Expected: FAIL because npm actions are absent.

- [ ] **Step 3: Extend the closed action map**

Extend the public action union with `npm_ci`, `npm_test`, `npm_build`,
`npm_lint`, `npm_typecheck`. Map them only to `npm ci`, `npm test`, and
`npm run <fixed-script>`. Parse `package.json` safely and return
`NPM_SCRIPT_MISSING` before approval when `test`, `build`, `lint`, or
`typecheck` is absent. Apply the shared workspace preflight while preserving
existing PNPM action inputs as a backwards-compatible compatibility path until
the next major contract version.

- [ ] **Step 4: Run Node tests**

Run: `node --test test/node-development-structured.test.mjs test/node-development-tool.test.mjs`  
Expected: all legacy and new action tests pass.

- [ ] **Step 5: Commit Node extension**

```powershell
git add src/tools/nodeDevelopment.ts test/node-development-structured.test.mjs
git commit -F <utf8-no-bom-message-file>
```

### Task 6: Documentation, complete validation, and Aily acceptance

**Files:**
- Modify: `README.md`
- Modify: `skills/personal-mcp-onboarding/SKILL.md`
- Modify: `test/tools-list.test.mjs`
- Modify: `test/complete-tools-e2e.test.mjs`

- [ ] **Step 1: Update usage guidance**

Document the context-first call sequence exactly:

```text
workspace_context bootstrap/select → read declared instruction files →
workspace_context mark_instructions_read → git_workflow / java_development /
node_development
```

Describe supported closed actions and state that users must not substitute
`execute_command` for them.

- [ ] **Step 2: Update inventory expectations**

Set the expected server inventory to 39 tools and include
`git_workflow`/`java_development` in the complete list test.

- [ ] **Step 3: Run build and all focused regressions**

Run:

```powershell
npm run build
node --test test/workspace-preflight.test.mjs test/git-workflow.test.mjs test/java-development.test.mjs test/node-development-structured.test.mjs test/node-development-tool.test.mjs test/tools-list.test.mjs test/complete-tools-e2e.test.mjs
```

Expected: TypeScript exits `0`; all tests pass; `/health` reports 39 tools.

- [ ] **Step 4: Perform non-mutating Aily verification**

In a fresh Aily session, call `workspace_context` bootstrap/select, mark the
declared instructions read, then call only `git_workflow.status` and
`java_development` with a deliberately invalid/nonexistent workspace only to
verify schema visibility. Do not stage, commit, fetch, push, install, build,
or run tests during acceptance.

- [ ] **Step 5: Commit documentation and validation updates**

```powershell
git add README.md skills/personal-mcp-onboarding/SKILL.md test/tools-list.test.mjs test/complete-tools-e2e.test.mjs
git commit -F <utf8-no-bom-message-file>
```

- [ ] **Step 6: Push the feature branch and request review**

Run:

```powershell
git push origin feature/structured-development-tools
```

Expected: remote feature branch contains all commits; do not merge to `main`
until user acceptance confirms the structured tools are visible and usable.
