# Workspace Context and Tool Routing Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Add an owner-scoped selected-workspace context and deterministic tool-routing contract so MCP clients no longer scan drives or guess shell syntax.

**Architecture:** Extend the trusted workspace catalog with root-free hints, then add a durable owner-scoped context store and a pure route planner. A thin workspace_context MCP tool composes those modules; directory grants, approvals, and execution adapters retain their authority.

**Tech Stack:** TypeScript, Node.js, Zod, MCP SDK, Node test runner.

---

## File structure

- Create: src/development/workspaces/contextTypes.ts — versioned context and route contracts.
- Create: src/development/workspaces/context.ts — TTL-backed atomic owner context store.
- Create: src/development/workspaces/routing.ts — pure capability/phase route planner.
- Create: src/tools/workspaceContext.ts — strict owner-only MCP adapter.
- Modify: src/development/workspaces/types.ts, catalog.ts, src/config.ts, src/tools/results.ts, and src/index.ts.
- Create: test/workspace-context-store.test.mjs, test/workspace-routing.test.mjs, test/workspace-context-tool.test.mjs.
- Modify: inventory tests and Aily/README guidance.

### Task 1: Extend trusted catalog metadata

**Files:**
- Modify: src/development/workspaces/types.ts
- Modify: src/development/workspaces/catalog.ts
- Test: test/local-workspace-catalog.test.mjs

- [ ] **Step 1: Write failing hint-validation tests**

    test("catalog accepts root-free declarative hints", () => {
      const loaded = loadLocalWorkspaceCatalog(fixtureWithHints);
      const view = publicCatalog(loaded.catalog);
      assert.deepEqual(view.workspaces[0].hints.capabilities, ["android_development"]);
      assert.equal(JSON.stringify(view).includes(workspaceRoot), false);
    });
    test("catalog rejects traversal and unsupported capability", () => {
      assert.throws(() => loadLocalWorkspaceCatalog(fixtureWithInstruction("../secret.md")));
      assert.throws(() => loadLocalWorkspaceCatalog(fixtureWithCapability("shell")));
    });

- [ ] **Step 2: Run:** node --test test/local-workspace-catalog.test.mjs  
Expected: FAIL because workspace hints do not exist.

- [ ] **Step 3: Add closed Zod contracts**

    export const WORKSPACE_CAPABILITIES = [
      "file_read", "content_search", "git_read", "node_workflow",
      "android_development", "development_tasks",
    ] as const;
    const relativeInstructionFile = z.string().min(1).max(512)
      .refine((p) => !path.isAbsolute(p) && !p.split(/[\\/]/).includes(".."));
    export const workspaceHintsSchema = z.object({
      ecosystems: z.array(z.enum(["node", "android", "dotnet", "native", "electron"])).max(5).default([]),
      instructionFiles: z.array(relativeInstructionFile).max(16).default([]),
      capabilities: z.array(z.enum(WORKSPACE_CAPABILITIES)).max(6).default([]),
    }).strict().default({ ecosystems: [], instructionFiles: [], capabilities: [] });

Add hints to workspaceSchema, defaulting old catalog entries; copy it into PublicWorkspace. Preserve catalog version 1 and never publish roots.

- [ ] **Step 4: Run:** node --test test/local-workspace-catalog.test.mjs  
Expected: PASS.

- [ ] **Step 5: Commit**

    git add src/development/workspaces/types.ts src/development/workspaces/catalog.ts test/local-workspace-catalog.test.mjs
    git commit -m "feat: add trusted workspace routing hints"

### Task 2: Define context and routing contracts

**Files:**
- Create: src/development/workspaces/contextTypes.ts
- Test: test/workspace-routing.test.mjs

- [ ] **Step 1: Write failing transition tests**

    test("only declared workspace phase transitions are valid", () => {
      assert.equal(validateWorkspaceTransition("selected", "instructions_ready"), true);
      assert.equal(validateWorkspaceTransition("verification_running", "verification_terminal"), true);
      assert.equal(validateWorkspaceTransition("selected", "verification_terminal"), false);
    });

- [ ] **Step 2: Run:** node --test test/workspace-routing.test.mjs  
Expected: FAIL because the contract module is absent.

- [ ] **Step 3: Add the versioned state contract**

    export const WORKSPACE_PHASES = [
      "selected", "instructions_ready", "inspected", "editing",
      "verification_queued", "verification_running", "verification_terminal",
    ] as const;
    export type WorkspacePhase = (typeof WORKSPACE_PHASES)[number];
    export interface WorkspaceContext {
      version: 1; contextId: string; ownerKey: string; workspaceId: string;
      catalogDigest: string; phase: WorkspacePhase; instructionFilesRead: string[];
      createdAt: string; updatedAt: string; expiresAt: string;
    }
    export const VALID_WORKSPACE_TRANSITIONS: Record<WorkspacePhase, readonly WorkspacePhase[]> = {
      selected: ["instructions_ready"], instructions_ready: ["inspected", "editing"],
      inspected: ["editing", "verification_queued"], editing: ["inspected", "verification_queued"],
      verification_queued: ["verification_running", "verification_terminal"],
      verification_running: ["verification_terminal"], verification_terminal: ["editing", "verification_queued"],
    };
    export const validateWorkspaceTransition = (from: WorkspacePhase, to: WorkspacePhase) =>
      VALID_WORKSPACE_TRANSITIONS[from].includes(to);

Also define public context, RoutePlan, RouteStep, and RouteErrorSummary. No public type may contain an absolute root or raw user ID.

- [ ] **Step 4: Run:** node --test test/workspace-routing.test.mjs  
Expected: PASS.

- [ ] **Step 5: Commit**

    git add src/development/workspaces/contextTypes.ts test/workspace-routing.test.mjs
    git commit -m "feat: define workspace context contracts"

### Task 3: Implement durable owner-scoped contexts

**Files:**
- Create: src/development/workspaces/context.ts
- Modify: src/config.ts
- Test: test/workspace-context-store.test.mjs

- [ ] **Step 1: Write failing persistence/isolation tests**

    test("context is owner-isolated and expires after 24h inactivity", () => {
      const store = new WorkspaceContextStore(tempDir, () => now);
      const saved = store.upsert(ownerA, "android-game", "catalog-a");
      assert.equal(store.get(ownerA, saved.contextId)?.workspaceId, "android-game");
      assert.equal(store.get(ownerB, saved.contextId), undefined);
      now += 86_400_001;
      assert.equal(store.get(ownerA, saved.contextId), undefined);
    });
    test("changed catalog digest marks context stale", () => {
      const saved = store.upsert(ownerA, "android-game", "before");
      assert.equal(store.requireFresh(ownerA, saved.contextId, "after").kind, "stale");
    });

- [ ] **Step 2: Run:** node --test test/workspace-context-store.test.mjs  
Expected: FAIL because WorkspaceContextStore does not exist.

- [ ] **Step 3: Implement atomic storage**

    export class WorkspaceContextStore {
      constructor(private readonly root: string, private readonly now = () => Date.now()) {}
      upsert(ownerKey: string, workspaceId: string, catalogDigest: string): WorkspaceContext;
      get(ownerKey: string, contextId: string): WorkspaceContext | undefined;
      findUnambiguous(ownerKey: string): WorkspaceContext | "none" | "ambiguous";
      requireFresh(ownerKey: string, contextId: string, digest: string): FreshContextResult;
      markInstructionsRead(ownerKey: string, contextId: string, declared: readonly string[], files: readonly string[]): WorkspaceContext;
      clear(ownerKey: string, contextId: string): boolean;
    }

Store regular JSON files under WORKSPACE_CONTEXT_STORE_PATH; clean expiry on every read/write, cap records to 16 per owner, write a same-directory temporary file then rename, and serialize only derived owner keys. Reject symlinks, malformed JSON, unrecognized phases, and files outside the store root.

- [ ] **Step 4: Run:** node --test test/workspace-context-store.test.mjs  
Expected: PASS for expiry, owner isolation, stale catalog, clear idempotence, and corrupt-file rejection.

- [ ] **Step 5: Commit**

    git add src/development/workspaces/context.ts src/config.ts test/workspace-context-store.test.mjs
    git commit -m "feat: persist owner workspace contexts"

### Task 4: Implement pure route planning and actionable results

**Files:**
- Create: src/development/workspaces/routing.ts
- Modify: src/tools/results.ts
- Test: test/workspace-routing.test.mjs
- Test: test/workspace-context-tool.test.mjs

- [ ] **Step 1: Write failing deterministic-route tests**

    test("Android work routes to background adapter, never generic shell", () => {
      const plan = planWorkspaceRoute(androidHints, "instructions_ready");
      assert.equal(plan.recommended.some((s) => s.tool === "android_development"), true);
      assert.equal(plan.prohibited.some((s) => s.tool === "execute_command"), true);
    });
    test("workspace selection error gives bounded next action", () => {
      const result = toolError("WORKSPACE_SELECTION_REQUIRED", "Select workspace.", false, {}, {
        tool: "workspace_context", action: "bootstrap", reason: "No active workspace.",
      }, [{ workspaceId: "demo", label: "Demo" }]);
      assert.equal(result.structuredContent.nextAction.tool, "workspace_context");
    });

- [ ] **Step 2: Run:** node --test test/workspace-routing.test.mjs test/workspace-context-tool.test.mjs  
Expected: FAIL because planner/codes/nextAction are absent.

- [ ] **Step 3: Implement the pure route table and additive error fields**

    export function planWorkspaceRoute(hints: WorkspaceHints, phase: WorkspacePhase): RoutePlan {
      const recommended: RouteStep[] = phase === "selected"
        ? [{ purpose: "Read declared instructions", tool: "read_file", required: true, input: { files: hints.instructionFiles } }]
        : [{ purpose: "Read source", tool: "read_file", required: false, input: {} },
           { purpose: "Search source", tool: "search_content", required: false, input: {} }];
      if (hints.capabilities.includes("android_development")) recommended.push(androidStep());
      if (hints.capabilities.includes("node_workflow")) recommended.push(nodeWorkflowStep());
      return { phase, recommended, prohibited: prohibitedRoutes(hints) };
    }

Add the seven workspace error codes from the design. Extend toolError with optional nextAction and root-free candidates capped at 16, preserving every existing call signature. The planner has no filesystem, process, shell, or task-store imports.

- [ ] **Step 4: Run:** node --test test/workspace-routing.test.mjs test/workspace-context-tool.test.mjs  
Expected: PASS.

- [ ] **Step 5: Commit**

    git add src/development/workspaces/routing.ts src/tools/results.ts test/workspace-routing.test.mjs test/workspace-context-tool.test.mjs
    git commit -m "feat: add deterministic workspace routes"

### Task 5: Register the strict workspace_context MCP tool

**Files:**
- Create: src/tools/workspaceContext.ts
- Modify: src/index.ts
- Modify: test/tools-list.test.mjs and test/complete-tools-e2e.test.mjs
- Test: test/workspace-context-tool.test.mjs

- [ ] **Step 1: Write failing tool-flow tests**

    test("bootstrap returns selected authorized workspace and Android route", async () => {
      const result = await workspaceContext({ action: "bootstrap", workspaceId: "android-game" }, deps);
      assert.equal(result.structuredContent.ok, true);
      assert.equal(result.structuredContent.workspaceId, "android-game");
      assert.equal(result.structuredContent.route.recommended.some((s) => s.tool === "android_development"), true);
    });
    test("ambiguous bootstrap returns root-free candidates", async () => {
      const result = await workspaceContext({ action: "bootstrap" }, depsWithTwoContexts);
      assert.equal(result.structuredContent.code, "WORKSPACE_SELECTION_REQUIRED");
      assert.equal(JSON.stringify(result.structuredContent).includes(workspaceRoot), false);
    });

- [ ] **Step 2: Run:** node --test test/workspace-context-tool.test.mjs  
Expected: FAIL because the MCP handler is absent.

- [ ] **Step 3: Implement strict actions and registration**

    export const workspaceContextInputSchema = z.discriminatedUnion("action", [
      z.object({ action: z.literal("bootstrap"), workspaceId: z.string().min(1).max(64).optional() }).strict(),
      z.object({ action: z.literal("select"), workspaceId: z.string().min(1).max(64) }).strict(),
      z.object({ action: z.literal("get"), contextId: z.string().uuid().optional() }).strict(),
      z.object({ action: z.literal("mark_instructions_read"), contextId: z.string().uuid(), files: z.array(z.string().min(1).max(512)).max(16) }).strict(),
      z.object({ action: z.literal("clear"), contextId: z.string().uuid() }).strict(),
    ]);

Use existing owner authorization and developmentOwnerKey; load the catalog, check directoryGrantStore before context creation, and return root-free views. Register through authorizeOwnerToolCall and runTool; add one tool name and update exact inventory from 36 to 37. Do not prompt, grant a directory, execute a process, or accept any path/command/URL field.

- [ ] **Step 4: Run:** npm run build && node --test test/workspace-context-tool.test.mjs test/tools-list.test.mjs test/complete-tools-e2e.test.mjs  
Expected: build passes and inventory reports exactly 37 tools.

- [ ] **Step 5: Commit**

    git add src/tools/workspaceContext.ts src/index.ts test/workspace-context-tool.test.mjs test/tools-list.test.mjs test/complete-tools-e2e.test.mjs
    git commit -m "feat: add workspace context MCP tool"

### Task 6: Document, regression-test, and audit boundaries

**Files:**
- Modify: README.md and existing Aily integration/onboarding guide
- Test: test/workspace-context-tool.test.mjs

- [ ] **Step 1: Write a failing protocol fixture test**

    test("Aily guidance prescribes bootstrap and forbids shell trial-and-error", () => {
      const guide = fs.readFileSync(guidePath, "utf8");
      assert.match(guide, /workspace_context[\s\S]*android_development/);
      assert.doesNotMatch(guide, /scan F:\\|gradlew .*execute_command/i);
    });

- [ ] **Step 2: Update the guide with this exact sequence**

    1. Call workspace_context.bootstrap; select an offered workspace ID if needed.
    2. Read every declared instruction file with read_file.
    3. Acknowledge those files using mark_instructions_read.
    4. Follow route.recommended: Android uses android_development and task tools; fixed Node verification uses run_local_workflow.
    5. Follow error.nextAction. Never scan a drive or retry the same work via a different shell.

State that contexts are owner-scoped, expire after inactivity, convey no directory grant, and are optional for existing callers in this first release.

- [ ] **Step 3: Run final checks**

Run: npm run build && node --test test/local-workspace-catalog.test.mjs test/workspace-context-store.test.mjs test/workspace-routing.test.mjs test/workspace-context-tool.test.mjs test/tools-list.test.mjs test/complete-tools-e2e.test.mjs  
Expected: all targeted tests pass; inventory is exactly 37.

Run: rg -n "child_process|spawn\\(|exec\\(|cmd.exe|powershell|gradlew" src/development/workspaces src/tools/workspaceContext.ts  
Expected: no execution or shell use in the new context/routing modules.

- [ ] **Step 4: Commit documentation and final integration**

    git add README.md docs test/workspace-context-tool.test.mjs
    git commit -m "docs: prescribe workspace routing protocol"
