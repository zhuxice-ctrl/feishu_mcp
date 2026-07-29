/**
 * Owner-only development task control tools.
 *
 * These tools expose task status, logs, and cancellation to the configured
 * owner. They never return launch specifications, worker handles, resource
 * identifiers, owner keys, or raw owner IDs. Artifact filesystem paths are
 * returned only while they sit inside a currently authorized directory;
 * otherwise a stable, non-reversible artifact ID is returned instead.
 * Cross-owner and unknown-task lookups fail with an identical TASK_NOT_FOUND
 * response so existence is not leaked across owners.
 */

import fs from "node:fs";
import path from "node:path";
import { createHmac } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getRequestUserId } from "../security/requestContext.js";
import { directoryGrantStore } from "../security/directoryGrantStore.js";
import { authorizeOwnerToolCall } from "../security/toolAccess.js";
import type { DevelopmentTaskCoordinator } from "../development/tasks/coordinator.js";
import { developmentOwnerKey } from "../development/tasks/ownerKey.js";
import type {
  DevelopmentArtifact,
  DevelopmentTaskRecord,
} from "../development/tasks/types.js";
import {
  stderrLogPath,
  stdoutLogPath,
} from "../development/tasks/workerProtocol.js";
import { runTool } from "./registry.js";
import { toolError, toolJson } from "./results.js";

export const MAX_LOG_BYTES = 65_536;
export const MAX_LOG_LINES = 500;

const EXIT_MESSAGE_MAX = 500;

export interface DevelopmentTaskToolDeps {
  coordinator: DevelopmentTaskCoordinator;
  userId?: () => string | null;
  hasDirectoryAccess?: (userId: string, absolutePath: string) => boolean;
}

function defaultHasAccess(userId: string, candidate: string): boolean {
  return path.isAbsolute(candidate) && directoryGrantStore.hasAccess(userId, candidate);
}

/** Fetch a task owned by the caller; cross-owner looks exactly like missing. */
function ownedRecord(
  taskId: string,
  deps: DevelopmentTaskToolDeps,
): { record: DevelopmentTaskRecord; userId: string } | { error: ReturnType<typeof toolError> } {
  const userId = (deps.userId ?? getRequestUserId)();
  if (!userId) {
    // authorizeOwnerToolCall normally guarantees an authenticated owner;
    // reaching this branch means the handler was invoked out of band.
    return { error: toolError("AUTHENTICATION_REQUIRED", "An authenticated owner is required.") };
  }
  const record = deps.coordinator.store.get(taskId);
  if (!record || record.ownerKey !== developmentOwnerKey(userId)) {
    return { error: toolError("TASK_NOT_FOUND", "Development task not found.") };
  }
  return { record, userId };
}

function artifactView(
  artifact: DevelopmentArtifact,
  ownerKey: string,
  userId: string,
  deps: DevelopmentTaskToolDeps,
): Record<string, unknown> {
  const view: Record<string, unknown> = { name: artifact.name, kind: artifact.kind };
  if (artifact.size !== undefined) view.size = artifact.size;
  if (artifact.sha256 !== undefined) view.sha256 = artifact.sha256;
  const hasAccess = deps.hasDirectoryAccess ?? defaultHasAccess;
  if (hasAccess(userId, artifact.path)) {
    view.path = artifact.path;
  } else {
    view.artifactId = createHmac("sha256", ownerKey)
      .update(`artifact:${artifact.name}:${artifact.path}`, "utf8")
      .digest("hex")
      .slice(0, 24);
  }
  return view;
}

function publicTask(
  record: DevelopmentTaskRecord,
  userId: string,
  deps: DevelopmentTaskToolDeps,
): Record<string, unknown> {
  const task: Record<string, unknown> = {
    id: record.id,
    tool: record.tool,
    action: record.action,
    class: record.class,
    state: record.state,
    stage: record.stage,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  if (record.startedAt !== undefined) task.startedAt = record.startedAt;
  if (record.endedAt !== undefined) task.endedAt = record.endedAt;
  if (record.exit !== undefined) {
    const exit: Record<string, unknown> = { code: record.exit.code };
    if (record.exit.errorCode !== undefined) exit.errorCode = record.exit.errorCode;
    if (record.exit.message !== undefined) {
      exit.message = record.exit.message.slice(0, EXIT_MESSAGE_MAX);
    }
    task.exit = exit;
  }
  task.artifacts = record.artifacts.map((artifact) =>
    artifactView(artifact, record.ownerKey, userId, deps)
  );
  return task;
}

// ------------------------------------------------------------- get task ---

export interface GetDevelopmentTaskArgs {
  taskId: string;
}

export async function getDevelopmentTask(
  args: GetDevelopmentTaskArgs,
  deps: DevelopmentTaskToolDeps,
) {
  const owned = ownedRecord(args.taskId, deps);
  if ("error" in owned) return owned.error;
  return toolJson({ ok: true, task: publicTask(owned.record, owned.userId, deps) });
}

// -------------------------------------------------------------- log read ---

export interface ReadDevelopmentTaskLogsArgs {
  taskId: string;
  stream?: "stdout" | "stderr" | "both";
  cursorStdout?: number;
  cursorStderr?: number;
  maxBytes?: number;
  maxLines?: number;
}

interface LogSlice {
  text: string;
  nextCursor: number;
  eof: boolean;
  truncated: boolean;
}

/** Advance past UTF-8 continuation bytes so reads never split a character. */
function utf8SafeStart(buffer: Buffer, start: number): number {
  let index = start;
  while (index < buffer.length && (buffer[index] & 0xc0) === 0x80) index += 1;
  return index;
}

/** Trim a trailing incomplete UTF-8 sequence. */
function utf8SafeEnd(buffer: Buffer, start: number, end: number): number {
  for (let i = end - 1; i >= Math.max(start, end - 3); i -= 1) {
    const byte = buffer[i];
    if ((byte & 0xc0) === 0x80) continue;
    const length = byte < 0x80 ? 1 : byte < 0xe0 ? 2 : byte < 0xf0 ? 3 : 4;
    if (i + length > end) return i;
    break;
  }
  return end;
}

function readLogSlice(
  file: string,
  cursor: number,
  maxBytes: number,
  maxLines: number,
): LogSlice | { error: ReturnType<typeof toolError> } {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return { error: toolError("INVALID_ARGUMENT", "Task log is not a regular file.") };
  }
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(file, flags);
  try {
    const size = fs.fstatSync(fd).size;
    const requested = Math.max(0, Math.min(cursor, size));
    const toRead = Math.min(maxBytes, size - requested);
    const buffer = Buffer.alloc(toRead);
    fs.readSync(fd, buffer, 0, toRead, requested);
    const start = utf8SafeStart(buffer, 0);
    let end = toRead;
    if (requested + end < size) end = utf8SafeEnd(buffer, start, end);

    let text = buffer.subarray(start, end).toString("utf8");
    let consumed = end;
    let truncated = requested + end < size;

    const lines = text.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    if (lines.length > maxLines) {
      const kept = `${lines.slice(0, maxLines).join("\n")}\n`;
      consumed = start + Buffer.byteLength(kept, "utf8");
      text = kept;
      truncated = true;
    }

    const nextCursor = requested + consumed;
    return { text, nextCursor, eof: !truncated && nextCursor >= size, truncated };
  } finally {
    fs.closeSync(fd);
  }
}

export async function readDevelopmentTaskLogs(
  args: ReadDevelopmentTaskLogsArgs,
  deps: DevelopmentTaskToolDeps,
) {
  const owned = ownedRecord(args.taskId, deps);
  if ("error" in owned) return owned.error;
  const stream = args.stream ?? "both";
  const maxBytes = Math.min(Math.max(1, args.maxBytes ?? MAX_LOG_BYTES), MAX_LOG_BYTES);
  const maxLines = Math.min(Math.max(1, args.maxLines ?? MAX_LOG_LINES), MAX_LOG_LINES);
  const dir = deps.coordinator.store.taskDir(owned.record.id);

  const body: Record<string, unknown> = { ok: true, taskId: owned.record.id, stream };
  const cursors: Record<string, number> = {};
  const nextCursors: Record<string, number> = {};
  const eof: Record<string, boolean> = {};
  const truncated: Record<string, boolean> = {};

  const readStream = (
    name: "stdout" | "stderr",
    file: string,
    cursor: number,
  ): ReturnType<typeof toolError> | null => {
    cursors[name] = cursor;
    try {
      const slice = readLogSlice(file, cursor, maxBytes, maxLines);
      if ("error" in slice) return slice.error;
      body[name] = slice.text;
      nextCursors[name] = slice.nextCursor;
      eof[name] = slice.eof;
      truncated[name] = slice.truncated;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        body[name] = "";
        nextCursors[name] = cursor;
        eof[name] = true;
        truncated[name] = false;
      } else {
        throw error;
      }
    }
    return null;
  };

  if (stream === "stdout" || stream === "both") {
    const failure = readStream("stdout", stdoutLogPath(dir), Math.max(0, args.cursorStdout ?? 0));
    if (failure) return failure;
  }
  if (stream === "stderr" || stream === "both") {
    const failure = readStream("stderr", stderrLogPath(dir), Math.max(0, args.cursorStderr ?? 0));
    if (failure) return failure;
  }

  // Unrequested streams keep their incoming cursor untouched.
  if (stream === "stdout") {
    cursors.stderr = Math.max(0, args.cursorStderr ?? 0);
    nextCursors.stderr = cursors.stderr;
  }
  if (stream === "stderr") {
    cursors.stdout = Math.max(0, args.cursorStdout ?? 0);
    nextCursors.stdout = cursors.stdout;
  }
  body.cursors = cursors;
  body.nextCursors = nextCursors;
  body.eof = eof;
  body.truncated = truncated;
  return toolJson(body);
}

// ----------------------------------------------------------------- cancel ---

export interface CancelDevelopmentTaskArgs {
  taskId: string;
}

export async function cancelDevelopmentTask(
  args: CancelDevelopmentTaskArgs,
  deps: DevelopmentTaskToolDeps,
) {
  const owned = ownedRecord(args.taskId, deps);
  if ("error" in owned) return owned.error;
  const outcome = deps.coordinator.cancel(owned.record.id, owned.record.ownerKey);
  if ("denied" in outcome) {
    return toolError("TASK_NOT_FOUND", "Development task not found.");
  }
  const current = deps.coordinator.store.get(owned.record.id);
  const state = current?.state ?? owned.record.state;
  if ("alreadyTerminal" in outcome) {
    return toolJson({ ok: true, taskId: owned.record.id, state, alreadyTerminal: true });
  }
  return toolJson({ ok: true, taskId: owned.record.id, state, alreadyTerminal: false });
}

// ----------------------------------------------------------- registration ---

const taskIdSchema = z.string().uuid();

export function registerDevelopmentTaskTools(
  server: McpServer,
  coordinator: DevelopmentTaskCoordinator,
): void {
  server.registerTool(
    "get_development_task",
    {
      description:
        "Get the status of one of your development tasks: state, stage, " +
        "timestamps, exit summary, and artifact names/kinds/sizes/hashes. " +
        "Artifact paths are returned only while they remain inside an " +
        "authorized directory; otherwise a stable artifact ID is returned.",
      inputSchema: { taskId: taskIdSchema },
    },
    async (args) =>
      authorizeOwnerToolCall("get_development_task", args) ??
      runTool(
        {
          name: "get_development_task",
          concurrency: "default",
          subject: { kind: "development", key: "task", display: "development task" },
        },
        async () => getDevelopmentTask(args, { coordinator }),
      ),
  );

  server.registerTool(
    "read_development_task_logs",
    {
      description:
        "Read redacted stdout/stderr logs of one of your development tasks. " +
        "Streams have independent byte cursors; pass the previous nextCursor " +
        "to resume. Responses are capped at 65536 bytes and 500 lines per call.",
      inputSchema: {
        taskId: taskIdSchema,
        stream: z.enum(["stdout", "stderr", "both"]).optional(),
        cursorStdout: z.number().int().nonnegative().optional(),
        cursorStderr: z.number().int().nonnegative().optional(),
        maxBytes: z.number().int().positive().max(MAX_LOG_BYTES).optional(),
        maxLines: z.number().int().positive().max(MAX_LOG_LINES).optional(),
      },
    },
    async (args) =>
      authorizeOwnerToolCall("read_development_task_logs", args) ??
      runTool(
        {
          name: "read_development_task_logs",
          concurrency: "default",
          subject: { kind: "development", key: "task", display: "development task" },
        },
        async () => readDevelopmentTaskLogs(args, { coordinator }),
      ),
  );

  server.registerTool(
    "cancel_development_task",
    {
      description:
        "Cancel one of your development tasks. Queued work is cancelled " +
        "immediately; running work receives a cancel request. Terminal tasks " +
        "return alreadyTerminal: true unchanged.",
      inputSchema: { taskId: taskIdSchema },
    },
    async (args) =>
      authorizeOwnerToolCall("cancel_development_task", args) ??
      runTool(
        {
          name: "cancel_development_task",
          concurrency: "default",
          subject: { kind: "development", key: "task", display: "development task" },
        },
        async () => cancelDevelopmentTask(args, { coordinator }),
      ),
  );
}
