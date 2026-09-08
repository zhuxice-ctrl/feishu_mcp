import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  COMMAND_MAX_OUTPUT_BYTES,
  COMMAND_MAX_TIMEOUT_MS,
  COMMAND_TIMEOUT_MS,
} from "../config.js";
import { digestArguments, requestApproval } from "../security/approval.js";
import {
  containsInternalApprovalPath,
  isInternalApprovalPath,
} from "../security/approvalStore.js";
import { getRequestUserId } from "../security/requestContext.js";
import { authorizeOwnerToolCall } from "../security/toolAccess.js";
import { resolvePathsGuardAndAuthorize } from "./helpers.js";
import { runProcess } from "./processRunner.js";
import { runTool } from "./registry.js";
import { toolError, toolJson } from "./results.js";

export type PythonDevelopmentAction = "python_version" | "script_run" | "pytest_run";

export interface PythonPytestArgs {
  targets?: string[];
  ignore?: string[];
  quiet?: boolean;
}

export interface PythonDevelopmentArgs {
  action: PythonDevelopmentAction;
  workdir: string;
  python?: string;
  script?: string;
  module?: string;
  pytestArgs?: PythonPytestArgs;
  timeout?: number;
}

export interface PythonDevelopmentDeps {
  runProcess?: typeof runProcess;
  requestApproval?: typeof requestApproval;
  resolvePathsGuardAndAuthorize?: typeof resolvePathsGuardAndAuthorize;
  userId?: () => string | null;
  maxOutputBytes?: number;
}

const PYTHON_LAUNCHERS = new Set([
  "py",
  "py.exe",
  "python",
  "python.exe",
  "python3",
  "python3.exe",
]);

const MODULE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const baseSchema = z.object({
  workdir: z.string().min(1),
  python: z.string().min(1).optional(),
  timeout: z.number().int().positive().optional(),
});

const pytestArgsSchema = z.object({
  targets: z.array(z.string().min(1)).optional(),
  ignore: z.array(z.string().min(1)).optional(),
  quiet: z.boolean().optional(),
}).strict();

const pythonVersionSchema = baseSchema.extend({
  action: z.literal("python_version"),
}).strict();

const scriptRunSchema = baseSchema.extend({
  action: z.literal("script_run"),
  script: z.string().min(1).optional(),
  module: z.string().min(1).optional(),
}).strict().refine((value) => Boolean(value.script) !== Boolean(value.module), {
  message: "script_run requires exactly one of script or module.",
});

const pytestRunSchema = baseSchema.extend({
  action: z.literal("pytest_run"),
  pytestArgs: pytestArgsSchema.optional(),
}).strict();

export const pythonDevelopmentInputSchema = z.discriminatedUnion("action", [
  pythonVersionSchema,
  scriptRunSchema,
  pytestRunSchema,
]);

function isShellLauncher(candidate: string): boolean {
  return PYTHON_LAUNCHERS.has(candidate.trim().toLowerCase());
}

function isInsideWorkdir(workdir: string, candidate: string): boolean {
  const resolvedWorkdir = path.resolve(workdir);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedWorkdir, resolvedCandidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeLauncher(candidate: string): string {
  const trimmed = candidate.trim().toLowerCase();
  if (trimmed === "python.exe" || trimmed === "python3.exe") return trimmed.slice(0, -4);
  if (trimmed === "py.exe") return "py";
  return trimmed;
}

export function validateRelativeTarget(workdir: string, target: string): string {
  const trimmed = target.trim();
  if (!trimmed) {
    throw new Error("Target path is required.");
  }
  if (trimmed.startsWith("-")) {
    throw new Error("Target path must not look like a pytest flag.");
  }
  if (/[\u0000\r\n]/.test(trimmed)) {
    throw new Error("Target path contains an invalid character.");
  }
  const resolved = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(workdir, trimmed);
  if (!isInsideWorkdir(workdir, resolved)) {
    throw new Error("Target path must stay inside the authorized workdir.");
  }
  return resolved;
}

function validateModuleName(module: string): string {
  const trimmed = module.trim();
  if (!MODULE_NAME_RE.test(trimmed)) {
    throw new Error("Module name must be a dotted Python module name.");
  }
  return trimmed;
}

export function resolvePythonInterpreter(workdir: string, python?: string): string {
  const requested = python?.trim();
  if (requested) {
    if (isShellLauncher(requested)) {
      return normalizeLauncher(requested);
    }
    if (requested.startsWith("-")) {
      throw new Error("Python interpreter must be a launcher name or a path.");
    }
    const resolved = path.isAbsolute(requested)
      ? path.resolve(requested)
      : path.resolve(workdir, requested);
    if (!isInsideWorkdir(workdir, resolved)) {
      throw new Error("Python interpreter must stay inside the authorized workdir.");
    }
    return resolved;
  }

  const candidates = [
    path.join(workdir, ".venv", "Scripts", "python.exe"),
    path.join(workdir, ".venv", "bin", "python"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return process.platform === "win32" ? "py" : "python3";
}

export function buildPytestArgs(pytestArgs: PythonPytestArgs | undefined, workdir: string): string[] {
  const args: string[] = [];
  if (pytestArgs?.quiet) {
    args.push("-q");
  }
  for (const ignore of pytestArgs?.ignore ?? []) {
    args.push("--ignore", validateRelativeTarget(workdir, ignore));
  }
  for (const target of pytestArgs?.targets ?? []) {
    args.push(validateRelativeTarget(workdir, target));
  }
  return args;
}

export function buildPythonInvocation(args: PythonDevelopmentArgs): { executable: string; args: string[] } {
  const executable = resolvePythonInterpreter(args.workdir, args.python);
  switch (args.action) {
    case "python_version":
      return { executable, args: ["--version"] };
    case "script_run": {
      if (args.script && args.module) {
        throw new Error("script_run accepts either script or module, not both.");
      }
      if (args.script) {
        return { executable, args: [validateRelativeTarget(args.workdir, args.script)] };
      }
      if (args.module) {
        return { executable, args: ["-m", validateModuleName(args.module)] };
      }
      throw new Error("script_run requires script or module.");
    }
    case "pytest_run":
      return {
        executable,
        args: ["-m", "pytest", ...buildPytestArgs(args.pytestArgs, args.workdir)],
      };
  }
}

function makeSubjectKey(args: PythonDevelopmentArgs, timeoutMs: number): string {
  return createHash("sha256")
    .update(`${digestArguments(args)}\u0000${timeoutMs}`)
    .digest("hex");
}

function requireOwner(deps: PythonDevelopmentDeps): { userId: string } | { error: ReturnType<typeof toolError> } {
  const userId = (deps.userId ?? getRequestUserId)();
  if (!userId) {
    return { error: toolError("AUTHENTICATION_REQUIRED", "An authenticated owner is required.") };
  }
  return { userId };
}

export async function pythonDevelopment(
  args: PythonDevelopmentArgs,
  ctx: ServerContext,
  deps: PythonDevelopmentDeps = {},
) {
  const owner = requireOwner(deps);
  if ("error" in owner) return owner.error;

  if (!args.workdir?.trim()) {
    return toolError("INVALID_ARGUMENT", "workdir is required.");
  }
  if (!Object.hasOwn({ python_version: true, script_run: true, pytest_run: true }, args.action)) {
    return toolError("INVALID_ARGUMENT", "action must be python_version, script_run, or pytest_run.");
  }

  const guard = await (deps.resolvePathsGuardAndAuthorize ?? resolvePathsGuardAndAuthorize)(
    "python_development",
    [{
      argName: "workdir",
      inputPath: args.workdir,
      operation: "read",
      scope: "directory",
      access: "command",
    }],
    args,
    ctx,
  );
  if (!guard.ok) {
    return guard.result ?? toolError("OUTSIDE_ALLOWED_DIRS", guard.error ?? "Invalid working directory.");
  }

  const workdir = guard.paths[0].resolvedPath;
  if (isInternalApprovalPath(workdir) || containsInternalApprovalPath(workdir)) {
    return toolError(
      "OUTSIDE_ALLOWED_DIRS",
      "The internal approval directory cannot be used as a working directory.",
    );
  }
  if (!fs.existsSync(workdir) || !fs.statSync(workdir).isDirectory()) {
    return toolError("INVALID_ARGUMENT", "The working directory does not exist or is not a directory.");
  }

  let invocation: { executable: string; args: string[] };
  try {
    invocation = buildPythonInvocation({ ...args, workdir });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("authorized workdir")) {
      return toolError("OUTSIDE_ALLOWED_DIRS", message);
    }
    return toolError("INVALID_ARGUMENT", message);
  }

  const timeoutMs = Math.min(args.timeout ?? COMMAND_TIMEOUT_MS, COMMAND_MAX_TIMEOUT_MS);
  const subjectKey = makeSubjectKey({ ...args, workdir }, timeoutMs);
  const approval = await (deps.requestApproval ?? requestApproval)(ctx, {
    tool: "python_development",
    userId: owner.userId,
    subject: {
      kind: "development",
      key: subjectKey,
      display: `${args.action}\nWorking directory: ${workdir}`,
    },
    argsDigest: digestArguments({ ...args, workdir }),
    reasons: [`Run approved Python action ${args.action}.`],
    authorizedDirectoryRootsDigest: guard.directoryProof?.rootsDigest,
  });
  if (approval !== true) return approval;

  const maxOutputBytes = deps.maxOutputBytes ?? COMMAND_MAX_OUTPUT_BYTES;
  return runTool(
    {
      name: "python_development",
      concurrency: "command",
      subject: {
        kind: "development",
        key: subjectKey,
        display: `${args.action}\nWorking directory: ${workdir}`,
      },
    },
    async () => {
      const result = await (deps.runProcess ?? runProcess)(
        invocation.executable,
        invocation.args,
        {
          cwd: workdir,
          timeoutMs,
          maxOutputBytes,
          signal: ctx.mcpReq.signal,
          env: { ...process.env },
        },
      );
      return toolJson({ ok: true, action: args.action, ...result });
    },
  );
}

export function registerPythonDevelopmentTool(server: McpServer): void {
  server.registerTool(
    "python_development",
    {
      description:
        "Owner-only Python development tool. Runs Python version checks, scripts, and pytest inside an authorized workdir using a fixed interpreter selection order and structured pytest targets. Raw shell strings and arbitrary flags are not accepted.",
      inputSchema: pythonDevelopmentInputSchema,
    },
    async (args, ctx) =>
      authorizeOwnerToolCall("python_development", args) ??
      pythonDevelopment(args as PythonDevelopmentArgs, ctx),
  );
}
