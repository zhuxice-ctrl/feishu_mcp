/**
 * Owner-scoped workspace context store.
 *
 * Persists one JSON file per context. Keys are derived owner keys (never raw
 * user IDs), context IDs are UUIDs, and every context carries an absolute
 * catalog digest so a catalog change invalidates the context instead of
 * silently pointing at a changed root or recipe.
 *
 * The store has no authority on its own: it cannot execute processes, read
 * arbitrary files, or grant directory access. It rejects symlinks, malformed
 * JSON, unrecognized phases, and files outside the store root.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  WORKSPACE_PHASES,
  validateWorkspaceTransition,
  type FreshContextResult,
  type WorkspaceContext,
  type WorkspacePhase,
} from "./contextTypes.js";

export class WorkspaceContextError extends Error {}

const CONTEXT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CONTEXTS_PER_OWNER = 16;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function isIsoTimestamp(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function validateStoredContext(value: unknown): WorkspaceContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspaceContextError("context store file is corrupt");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) {
    throw new WorkspaceContextError("context store file has an unknown version");
  }
  for (const key of [
    "contextId",
    "ownerKey",
    "workspaceId",
    "catalogDigest",
    "phase",
    "createdAt",
    "updatedAt",
    "expiresAt",
  ] as const) {
    if (typeof record[key] !== "string") {
      throw new WorkspaceContextError("context store file is corrupt");
    }
  }
  if (!isUuid(record.contextId as string)) {
    throw new WorkspaceContextError("context store file has an invalid context id");
  }
  if (
    !WORKSPACE_PHASES.includes(record.phase as WorkspacePhase)
  ) {
    throw new WorkspaceContextError("context store file has an unknown phase");
  }
  if (
    !Array.isArray(record.instructionFilesRead) ||
    !(record.instructionFilesRead as unknown[]).every((f) => typeof f === "string")
  ) {
    throw new WorkspaceContextError("context store file is corrupt");
  }
  for (const ts of ["createdAt", "updatedAt", "expiresAt"] as const) {
    if (!isIsoTimestamp(record[ts])) {
      throw new WorkspaceContextError("context store file has an invalid timestamp");
    }
  }
  return record as unknown as WorkspaceContext;
}

export class WorkspaceContextStore {
  private readonly root: string;
  private readonly now: () => number;

  constructor(root: string, now: () => number = () => Date.now()) {
    this.root = path.resolve(root);
    this.now = now;
  }

  upsert(
    ownerKey: string,
    workspaceId: string,
    catalogDigest: string,
  ): WorkspaceContext {
    this.assertOwnerKey(ownerKey);
    this.cleanExpired();
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const existing = this.allContexts().find(
      (ctx) => ctx.ownerKey === ownerKey && ctx.workspaceId === workspaceId,
    );
    if (existing) {
      const digestChanged = existing.catalogDigest !== catalogDigest;
      const next: WorkspaceContext = {
        ...existing,
        catalogDigest,
        phase: digestChanged ? "selected" : existing.phase,
        instructionFilesRead: digestChanged ? [] : existing.instructionFilesRead,
        updatedAt: nowIso,
        expiresAt: new Date(nowMs + CONTEXT_TTL_MS).toISOString(),
      };
      this.write(next);
      return { ...next };
    }
    const ownerContexts = this.allContexts().filter(
      (ctx) => ctx.ownerKey === ownerKey,
    );
    if (ownerContexts.length >= MAX_CONTEXTS_PER_OWNER) {
      const oldest = ownerContexts.reduce((a, b) =>
        a.updatedAt < b.updatedAt ? a : b,
      );
      this.deleteContext(oldest.contextId);
    }
    const created: WorkspaceContext = {
      version: 1,
      contextId: randomUUID(),
      ownerKey,
      workspaceId,
      catalogDigest,
      phase: "selected",
      instructionFilesRead: [],
      createdAt: nowIso,
      updatedAt: nowIso,
      expiresAt: new Date(nowMs + CONTEXT_TTL_MS).toISOString(),
    };
    this.write(created);
    return { ...created };
  }

  get(ownerKey: string, contextId: string): WorkspaceContext | undefined {
    this.assertOwnerKey(ownerKey);
    this.cleanExpired();
    const ctx = this.readContext(contextId);
    if (!ctx || ctx.ownerKey !== ownerKey) return undefined;
    return this.publicCopy(ctx);
  }

  findUnambiguous(ownerKey: string): WorkspaceContext | "none" | "ambiguous" {
    this.assertOwnerKey(ownerKey);
    this.cleanExpired();
    const owned = this.allContexts().filter((ctx) => ctx.ownerKey === ownerKey);
    if (owned.length === 0) return "none";
    if (owned.length > 1) return "ambiguous";
    return this.publicCopy(owned[0]);
  }

  requireFresh(
    ownerKey: string,
    contextId: string,
    digest: string,
  ): FreshContextResult {
    const ctx = this.get(ownerKey, contextId);
    if (!ctx) return { kind: "none" };
    if (ctx.catalogDigest !== digest) return { kind: "stale", context: ctx };
    return { kind: "fresh", context: ctx };
  }

  markInstructionsRead(
    ownerKey: string,
    contextId: string,
    declared: readonly string[],
    files: readonly string[],
  ): WorkspaceContext {
    this.assertOwnerKey(ownerKey);
    this.cleanExpired();
    const ctx = this.readContext(contextId);
    if (!ctx || ctx.ownerKey !== ownerKey) {
      throw new WorkspaceContextError("context not found");
    }
    const unknown = files.filter((file) => !declared.includes(file));
    if (unknown.length > 0) {
      throw new WorkspaceContextError("file is not declared for this workspace");
    }
    const nextFiles = [...new Set([...ctx.instructionFilesRead, ...files])];
    let phase = ctx.phase;
    if (
      phase === "selected" &&
      declared.every((file) => nextFiles.includes(file)) &&
      validateWorkspaceTransition("selected", "instructions_ready")
    ) {
      phase = "instructions_ready";
    }
    const nowMs = this.now();
    const next: WorkspaceContext = {
      ...ctx,
      instructionFilesRead: nextFiles,
      phase,
      updatedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + CONTEXT_TTL_MS).toISOString(),
    };
    this.write(next);
    return this.publicCopy(next);
  }

  clear(ownerKey: string, contextId: string): boolean {
    this.assertOwnerKey(ownerKey);
    this.cleanExpired();
    const ctx = this.readContext(contextId);
    if (!ctx || ctx.ownerKey !== ownerKey) return false;
    this.deleteContext(contextId);
    return true;
  }

  // ------------------------------------------------------------ internals ---

  private assertOwnerKey(ownerKey: string): void {
    if (typeof ownerKey !== "string" || ownerKey.length === 0) {
      throw new WorkspaceContextError("ownerKey must be a non-empty string");
    }
  }

  private filePath(contextId: string): string {
    if (!isUuid(contextId)) {
      throw new WorkspaceContextError("context id is not a UUID");
    }
    return path.join(this.root, `${contextId}.json`);
  }

  private readContext(contextId: string): WorkspaceContext | null {
    const file = this.filePath(contextId);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new WorkspaceContextError("context file must be a regular file");
    }
    let ctx: WorkspaceContext;
    try {
      ctx = validateStoredContext(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch (error) {
      if (error instanceof WorkspaceContextError) throw error;
      throw new WorkspaceContextError("context store file is corrupt");
    }
    if (ctx.contextId !== contextId) {
      throw new WorkspaceContextError("context file id does not match its name");
    }
    return ctx;
  }

  private allContexts(): WorkspaceContext[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.root, { withFileTypes: true });
    } catch {
      return [];
    }
    const contexts: WorkspaceContext[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".json")) continue;
      const contextId = entry.name.slice(0, -".json".length);
      if (!isUuid(contextId)) {
        throw new WorkspaceContextError("unexpected file in the context store");
      }
      const ctx = this.readContext(contextId);
      if (ctx) contexts.push(ctx);
    }
    return contexts;
  }

  private cleanExpired(): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.root, { withFileTypes: true });
    } catch {
      return;
    }
    const nowMs = this.now();
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const contextId = entry.name.slice(0, -".json".length);
      if (!isUuid(contextId)) {
        throw new WorkspaceContextError("unexpected file in the context store");
      }
      const ctx = this.readContext(contextId);
      if (ctx && Date.parse(ctx.expiresAt) <= nowMs) {
        this.deleteContext(contextId);
      }
    }
  }

  private write(ctx: WorkspaceContext): void {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const file = this.filePath(ctx.contextId);
    const temporary = path.join(
      this.root,
      `.context-${process.pid}-${randomUUID()}.tmp`,
    );
    const data = JSON.stringify(this.serialize(ctx), null, 2);
    try {
      const fd = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.writeFileSync(fd, `${data}\n`, "utf8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, file);
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        // Best-effort on platforms without chmod.
      }
    } finally {
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
        // Best-effort cleanup of the temporary file.
      }
    }
  }

  private deleteContext(contextId: string): void {
    try {
      fs.rmSync(this.filePath(contextId), { force: true });
    } catch {
      // Best-effort delete.
    }
  }

  private serialize(ctx: WorkspaceContext): WorkspaceContext {
    const base: WorkspaceContext = {
      version: 1,
      contextId: ctx.contextId,
      ownerKey: ctx.ownerKey,
      workspaceId: ctx.workspaceId,
      catalogDigest: ctx.catalogDigest,
      phase: ctx.phase,
      instructionFilesRead: [...ctx.instructionFilesRead],
      createdAt: ctx.createdAt,
      updatedAt: ctx.updatedAt,
      expiresAt: ctx.expiresAt,
    };
    if (ctx.lastError) {
      base.lastError = {
        code: ctx.lastError.code,
        message: ctx.lastError.message,
        retryable: ctx.lastError.retryable,
        ...(ctx.lastError.nextAction
          ? { nextAction: { ...ctx.lastError.nextAction } }
          : {}),
        ...(ctx.lastError.candidates
          ? {
              candidates: ctx.lastError.candidates
                .slice(0, 16)
                .map((c) => ({ ...c })),
            }
          : {}),
      };
    }
    return base;
  }

  private publicCopy(ctx: WorkspaceContext): WorkspaceContext {
    return this.serialize(ctx);
  }
}