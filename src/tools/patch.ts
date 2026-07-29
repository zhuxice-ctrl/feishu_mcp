import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import {
  CONSENT_ABSOLUTE_PATH,
  CONSENT_SENSITIVE_FILE,
  MAX_READ_BYTES,
  MAX_WRITE_BYTES,
  TOOL_QUEUE_TIMEOUT_MS,
} from "../config.js";
import { getRequestUserId } from "../security/requestContext.js";
import { inspectPath } from "../security/consent.js";
import { requestApproval, digestArguments } from "../security/approval.js";
import { isInternalApprovalPath } from "../security/approvalStore.js";
import { authorizeToolCall } from "../security/toolAccess.js";
import { resolvePathsGuardAndAuthorize } from "./helpers.js";
import {
  applyStructuredHunks,
  applyUnifiedHunks,
  detectPatchFormat,
  parseStructuredPatch,
  parseUnifiedDiff,
  type PatchOperation,
} from "./patchFormat.js";
import { runTool } from "./registry.js";
import { toolError, toolJson } from "./results.js";
import { QueueTimeoutError, Semaphore } from "./concurrency.js";

interface ApplyPatchArgs { patch: string; path?: string }
interface PlannedChange { target: string; displayPath: string; content: string | null }
export interface PatchRuntime {
  commitRename?: typeof fs.rename;
}

const pathLocks = new Map<string, Semaphore>();

async function withPathLocks<T>(targets: string[], run: () => Promise<T>): Promise<T> {
  const keys = [...new Set(targets.map((target) =>
    process.platform === "win32" ? target.toLowerCase() : target
  ))].sort();
  const acquired: Array<{ key: string; gate: Semaphore; release: () => void }> = [];
  try {
    for (const key of keys) {
      const gate = pathLocks.get(key) ?? new Semaphore(1, "patch target");
      pathLocks.set(key, gate);
      acquired.push({ key, gate, release: await gate.acquire(TOOL_QUEUE_TIMEOUT_MS) });
    }
    return await run();
  } finally {
    for (const item of acquired.reverse()) {
      item.release();
      const stats = item.gate.summary();
      if (stats.active === 0 && stats.queued === 0) pathLocks.delete(item.key);
    }
  }
}

async function readExisting(target: string): Promise<string | null> {
  try {
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error(`Patch target is not a file: ${target}`);
    if (stat.size > MAX_READ_BYTES) throw new Error(`Patch target exceeds ${MAX_READ_BYTES} bytes: ${target}`);
    return await fs.readFile(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function rawTargets(format: "structured" | "unified", operations: PatchOperation[], fallback?: string): string[] {
  if (format === "unified") return fallback ? [fallback] : [];
  return operations.flatMap((operation) =>
    operation.kind === "update" && operation.moveTo
      ? [operation.path, operation.moveTo]
      : [operation.path]
  );
}

async function guardTargets(args: ApplyPatchArgs, targets: string[], ctx: ServerContext) {
  if (!targets.length) return toolError("INVALID_PATCH", "A unified patch requires the path parameter.");
  const authorization = await resolvePathsGuardAndAuthorize(
    "apply_patch",
    targets.map((target) => ({
      argName: "path",
      inputPath: target,
      operation: "write" as const,
      scope: "file" as const,
      access: "patch" as const,
    })),
    args,
    ctx,
  );
  if (!authorization.ok) {
    return authorization.result ?? toolError("OUTSIDE_ALLOWED_DIRS", authorization.error ?? "Invalid patch targets.");
  }
  const resolved: Array<{
    raw: string;
    path: string;
    kinds: ReturnType<typeof inspectPath>;
  }> = [];
  const seen = new Set<string>();
  for (const item of authorization.paths) {
    if (isInternalApprovalPath(item.resolvedPath)) {
      return toolError("OUTSIDE_ALLOWED_DIRS", "Patch targets cannot access the internal approval directory.");
    }
    const key = process.platform === "win32" ? item.resolvedPath.toLowerCase() : item.resolvedPath;
    if (seen.has(key)) return toolError("INVALID_PATCH", `Patch target appears more than once: ${item.inputPath}`);
    seen.add(key);
    const kinds = inspectPath("apply_patch", item.inputPath, item.resolvedPath)
      .filter((kind) => !(item.boundarySource !== "static" && kind === "absolute_path"));
    resolved.push({ raw: item.inputPath, path: item.resolvedPath, kinds });
  }
  const kinds = new Set(resolved.flatMap((item) => item.kinds));
  if ((kinds.has("absolute_path") && CONSENT_ABSOLUTE_PATH === "deny") ||
      (kinds.has("sensitive_file") && CONSENT_SENSITIVE_FILE === "deny")) {
    return toolError("APPROVAL_DENIED", "Patch targets are denied by the configured consent policy.");
  }
  const confirm = (kinds.has("absolute_path") && CONSENT_ABSOLUTE_PATH === "confirm") ||
    (kinds.has("sensitive_file") && CONSENT_SENSITIVE_FILE === "confirm");
  if (confirm) {
    const sorted = resolved.map((item) => item.path).sort();
    const approval = await requestApproval(ctx, {
      tool: "apply_patch",
      userId: getRequestUserId(),
      subject: {
        kind: "paths",
        key: createHash("sha256").update(sorted.join("\u0000")).digest("hex"),
        display: sorted.join("\n"),
      },
      argsDigest: digestArguments(args),
      reasons: [
        ...(kinds.has("absolute_path") ? ["The patch contains absolute target paths."] : []),
        ...(kinds.has("sensitive_file") ? ["The patch touches sensitive files."] : []),
      ],
      authorizedDirectoryRootsDigest: authorization.directoryProof?.rootsDigest,
    });
    if (approval !== true) return approval;
  }
  return resolved;
}

async function planStructured(operations: PatchOperation[], resolved: Map<string, string>): Promise<PlannedChange[]> {
  const changes: PlannedChange[] = [];
  for (const operation of operations) {
    const target = resolved.get(operation.path)!;
    const existing = await readExisting(target);
    if (operation.kind === "add") {
      if (existing !== null) throw new Error(`Add target already exists: ${operation.path}`);
      changes.push({ target, displayPath: operation.path, content: operation.content });
      continue;
    }
    if (operation.kind === "delete") {
      if (existing === null) throw new Error(`Delete target does not exist: ${operation.path}`);
      changes.push({ target, displayPath: operation.path, content: null });
      continue;
    }
    if (existing === null) throw new Error(`Update target does not exist: ${operation.path}`);
    const updated = applyStructuredHunks(existing, operation.hunks, operation.path);
    if (operation.moveTo) {
      const destination = resolved.get(operation.moveTo)!;
      if (await readExisting(destination) !== null) throw new Error(`Move destination already exists: ${operation.moveTo}`);
      changes.push({ target: destination, displayPath: operation.moveTo, content: updated });
      changes.push({ target, displayPath: operation.path, content: null });
    } else changes.push({ target, displayPath: operation.path, content: updated });
  }
  return changes;
}

async function planUnified(patchText: string, target: string, displayPath: string): Promise<PlannedChange[]> {
  const hunks = parseUnifiedDiff(patchText);
  if (!hunks.length) throw new Error("Unified patch contains no hunks.");
  const existing = await readExisting(target);
  if (existing === null && hunks.some((hunk) => hunk.lines.some((line) => line.type !== "add"))) {
    throw new Error(`Unified patch target does not exist: ${displayPath}`);
  }
  return [{ target, displayPath, content: applyUnifiedHunks(existing ?? "", hunks) }];
}

async function ensureParent(parent: string, created: string[]): Promise<void> {
  const missing: string[] = [];
  let cursor = parent;
  for (;;) {
    try { await fs.access(cursor); break; }
    catch {
      missing.push(cursor);
      const next = path.dirname(cursor);
      if (next === cursor) throw new Error(`Cannot create parent directory: ${parent}`);
      cursor = next;
    }
  }
  await fs.mkdir(parent, { recursive: true });
  created.push(...missing);
}

async function commitChanges(changes: PlannedChange[], runtime: PatchRuntime = {}) {
  const commitRename = runtime.commitRename ?? fs.rename;
  const staged = new Map<string, string>();
  const backups = new Map<string, string>();
  const createdDirectories: string[] = [];
  const touched = new Set<string>();
  try {
    for (const change of changes) {
      if (change.content === null) continue;
      if (Buffer.byteLength(change.content, "utf8") > MAX_WRITE_BYTES) {
        throw new Error(`Patched content exceeds ${MAX_WRITE_BYTES} bytes: ${change.displayPath}`);
      }
      await ensureParent(path.dirname(change.target), createdDirectories);
      const temporary = path.join(path.dirname(change.target), `.${path.basename(change.target)}.patch-${randomUUID()}.tmp`);
      const handle = await fs.open(temporary, "wx", 0o600);
      try { await handle.writeFile(change.content, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      try { await fs.chmod(temporary, (await fs.stat(change.target)).mode); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      staged.set(change.target, temporary);
    }
  } catch (error) {
    for (const temporary of staged.values()) {
      try { await fs.rm(temporary, { force: true }); } catch {}
    }
    for (const directory of createdDirectories) {
      try { await fs.rmdir(directory); } catch {}
    }
    throw error;
  }

  try {
    for (const change of changes) {
      try {
        await fs.access(change.target);
        const backup = path.join(path.dirname(change.target), `.${path.basename(change.target)}.patch-${randomUUID()}.bak`);
        await fs.rename(change.target, backup);
        backups.set(change.target, backup);
        touched.add(change.target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (change.content !== null) {
        await commitRename(staged.get(change.target)!, change.target);
        touched.add(change.target);
      }
    }
    await Promise.allSettled([...backups.values()].map((backup) => fs.rm(backup, { force: true })));
    return { rolledBack: false };
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const change of [...changes].reverse()) {
      if (!touched.has(change.target)) continue;
      try { await fs.rm(change.target, { force: true }); } catch (item) { rollbackErrors.push(String(item)); }
      const backup = backups.get(change.target);
      if (backup) {
        try { await fs.rename(backup, change.target); } catch (item) { rollbackErrors.push(String(item)); }
      }
    }
    for (const temporary of staged.values()) {
      try { await fs.rm(temporary, { force: true }); } catch (item) { rollbackErrors.push(String(item)); }
    }
    for (const directory of createdDirectories) {
      try { await fs.rmdir(directory); } catch {}
    }
    if (rollbackErrors.length) {
      throw new Error(`Patch failed and rollback was incomplete (${rollbackErrors.length} errors).`);
    }
    throw error;
  } finally {
    for (const temporary of staged.values()) {
      try { await fs.rm(temporary, { force: true }); } catch {}
    }
  }
}

export async function applyPatch(args: ApplyPatchArgs, ctx: ServerContext, runtime: PatchRuntime = {}) {
  if (Buffer.byteLength(args.patch, "utf8") > MAX_WRITE_BYTES) {
    return toolError("INVALID_PATCH", `Patch exceeds ${MAX_WRITE_BYTES} bytes.`);
  }
  let format: "structured" | "unified";
  let operations: PatchOperation[] = [];
  try {
    format = detectPatchFormat(args.patch);
    if (format === "structured") operations = parseStructuredPatch(args.patch);
  } catch (error) { return toolError("INVALID_PATCH", (error as Error).message); }
  const targets = rawTargets(format, operations, args.path);
  const guarded = await guardTargets(args, targets, ctx);
  if (!Array.isArray(guarded)) return guarded;
  const pathMap = new Map(guarded.map((item) => [item.raw, item.path]));
  const guardedTargets = guarded.map((item) => item.path);
  const subjectKey = createHash("sha256").update([...guardedTargets].sort().join("\u0000")).digest("hex");
  try {
    return await withPathLocks(guardedTargets, async () => runTool(
      { name: "apply_patch", concurrency: "default", subject: { kind: "paths", key: subjectKey, display: `${guardedTargets.length} paths` } },
      async () => {
        let changes: PlannedChange[];
        try {
          changes = format === "structured"
            ? await planStructured(operations, pathMap)
            : await planUnified(args.patch, guarded[0].path, args.path!);
        } catch (error) { return toolError("INVALID_PATCH", (error as Error).message); }
      try {
        const transaction = await commitChanges(changes, runtime);
        return toolJson({
          ok: true,
          applied: true,
          format,
          operations: format === "structured" ? operations : [{ kind: "update", path: args.path }],
          changed: changes.map((item) => ({ path: item.displayPath, action: item.content === null ? "deleted" : "written" })),
          fileCount: new Set(changes.map((item) => item.target)).size,
          rolledBack: transaction.rolledBack,
        });
      } catch (error) {
        const message = (error as Error).message;
        return toolError(message.includes("rollback was incomplete") ? "ROLLBACK_FAILED" : "INVALID_PATCH", message);
      }
      },
    ));
  } catch (error) {
    if (error instanceof QueueTimeoutError) return toolError("QUEUE_TIMEOUT", error.message, true);
    throw error;
  }
}

export function registerPatchTool(server: McpServer): void {
  server.registerTool("apply_patch", {
    description: "Apply a unified or structured multi-file patch transactionally inside allowed directories.",
    inputSchema: { patch: z.string().min(1), path: z.string().optional() },
  }, async (args, ctx) => authorizeToolCall("apply_patch", args) ?? applyPatch(args, ctx));
}
