# Resumable Text Transfer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a safe resumable MCP transport for source files that are too large for one upstream request.

**Architecture:** A focused text-transfer service owns durable staging, ordering, limits, expiry, and integrity checks. A thin MCP tool owns schemas, owner authorization, existing filesystem guard calls, and atomic destination replacement. Existing `write_file` and `edit_file` remain unchanged.

**Tech Stack:** TypeScript, Node.js filesystem and crypto APIs, Zod, MCP server, Node test runner.

---

### Task 1: Transfer contracts and durable staging service

**Files:**
- Create: `src/textTransfers/types.ts`
- Create: `src/textTransfers/service.ts`
- Test: `test/text-transfer-service.test.mjs`

- [ ] Write failing tests for a 167 KiB ordered UTF-8 transfer, resume inspection, owner isolation, out-of-order chunks, expiration, size mismatch, and SHA-256 mismatch.
- [ ] Implement versioned session metadata and a service which creates private staging directories, appends bounded UTF-8 chunks, checks expiry and ownership, verifies length/digest, and removes terminal staging state.
- [ ] Run `npm run build && node --test test/text-transfer-service.test.mjs` and commit the isolated service.

### Task 2: MCP tool and guarded atomic commit

**Files:**
- Create: `src/tools/textTransfer.ts`
- Modify: `src/config.ts`
- Modify: `src/index.ts`
- Test: `test/text-transfer-tool.test.mjs`
- Test: `test/tools-list.test.mjs`

- [ ] Write failing MCP tests for begin authorization, chunk/resume/commit behavior, digest failure preserving the existing target, and inventory registration.
- [ ] Add bounded configuration defaults, construct the service in the composition root, register `manage_text_transfer`, and add it to the immutable inventory.
- [ ] Implement the four-action Zod schema. Guard the destination at begin, re-guard it at commit, call `atomicWriteFile` only after verified text is read from staging, and ensure owner-only authorization and ordinary audit envelopes remain in force.
- [ ] Run the focused tests and `npm test`; commit only related files, leaving existing unrelated working-tree changes untouched.

### Task 3: Operator documentation and compatibility validation

**Files:**
- Modify: `README.md`
- Test: `test/development-docs.test.mjs`

- [ ] Document the four calls, 48 KiB chunk bound, required byte count and digest, resume behavior, and explicit rule that small edits continue using `edit_file`.
- [ ] Assert documentation describes the transfer tool without promising arbitrary command execution.
- [ ] Run `npm run build && npm test`; review `git diff`; do not restart the running service or merge the branch.
