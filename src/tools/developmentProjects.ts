/**
 * Owner-only development project management tool.
 *
 * A single strict `manage_development_project` tool aggregates the closed
 * project-provider registry. It exposes three actions:
 *
 * - `list_templates` — enumerate reviewed templates for a given ecosystem.
 * - `inspect` — inspect an existing project root behind a directory-access check.
 * - `create` — scaffold a new project from a reviewed template into an
 *   authorized destination, behind single-use exact approval.
 *
 * The caller never supplies a template path, executable, command, URL, or
 * free-form package-manager switch. The provider is resolved from the closed
 * registry; templates carry no remote scripts, credentials, or binary files.
 */

import path from "node:path";
import fs from "node:fs";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getRequestUserId } from "../security/requestContext.js";
import { directoryGrantStore } from "../security/directoryGrantStore.js";
import { authorizeOwnerToolCall } from "../security/toolAccess.js";
import { digestArguments, requestApproval } from "../security/approval.js";
import { developmentOwnerKey } from "../development/tasks/ownerKey.js";
import type { ProjectRegistry } from "../development/projects/registry.js";
import type {
  DevelopmentEcosystem,
  ProjectCreateRequest,
  ProjectTemplateProfile,
} from "../development/projects/types.js";
import { runTool } from "./registry.js";
import { toolError, toolJson } from "./results.js";

// --------------------------------------------------------------- schema ---

const hostPath = z.string().min(1).max(4096);

const ecosystemEnum = z.enum(["android", "dotnet", "native", "electron"]);

/**
 * Strict per-ecosystem profile schemas. Each variant uses `.strict()` to
 * reject unknown fields — the caller cannot smuggle in a template path,
 * executable, command, URL, or free-form package-manager switch.
 */
const androidProfileSchema = z.object({
  compileSdk: z.number().int().min(1),
  minSdk: z.number().int().min(1),
  targetSdk: z.number().int().min(1),
  agp: z.string().min(1),
  kotlin: z.string().min(1),
  gradle: z.string().min(1),
  composeCompiler: z.string().optional(),
}).strict();

const dotnetProfileSchema = z.object({
  compileSdk: z.number().int().min(1),
  minSdk: z.number().int().min(1),
  targetSdk: z.number().int().min(1),
  agp: z.string().min(1),
  kotlin: z.string().min(1),
  gradle: z.string().min(1),
  composeCompiler: z.string().optional(),
  framework: z.string().min(1),
  configuration: z.enum(["Debug", "Release"]),
  platform: z.string().min(1),
}).strict();

const nativeProfileSchema = z.object({
  compileSdk: z.number().int().min(1),
  minSdk: z.number().int().min(1),
  targetSdk: z.number().int().min(1),
  agp: z.string().min(1),
  kotlin: z.string().min(1),
  gradle: z.string().min(1),
  composeCompiler: z.string().optional(),
  cppStandard: z.enum(["17", "20"]),
  buildType: z.enum(["executable", "library"]),
  withTests: z.boolean(),
}).strict();

const electronProfileSchema = z.object({
  compileSdk: z.number().int().min(1),
  minSdk: z.number().int().min(1),
  targetSdk: z.number().int().min(1),
  agp: z.string().min(1),
  kotlin: z.string().min(1),
  gradle: z.string().min(1),
  composeCompiler: z.string().optional(),
  packageManager: z.enum(["npm", "pnpm", "yarn"]),
}).strict();

const listTemplatesSchema = z.object({
  action: z.literal("list_templates"),
  ecosystem: ecosystemEnum,
}).strict();

const inspectSchema = z.object({
  action: z.literal("inspect"),
  ecosystem: ecosystemEnum,
  root: hostPath,
}).strict();

const createSchemaBase = z.object({
  action: z.literal("create"),
  ecosystem: ecosystemEnum,
  templateId: z.string().min(1).max(128),
  projectName: z.string().min(1).max(256),
  packageId: z.string().min(1).max(256),
  destination: hostPath,
});

const createSchemas = [
  createSchemaBase.extend({ ecosystem: z.literal("android"), profile: androidProfileSchema }).strict(),
  createSchemaBase.extend({ ecosystem: z.literal("dotnet"), profile: dotnetProfileSchema }).strict(),
  createSchemaBase.extend({ ecosystem: z.literal("native"), profile: nativeProfileSchema }).strict(),
  createSchemaBase.extend({ ecosystem: z.literal("electron"), profile: electronProfileSchema }).strict(),
] as const;

export const manageDevelopmentProjectInputSchema = z.union([
  listTemplatesSchema,
  inspectSchema,
  ...createSchemas,
]);

export type ManageDevelopmentProjectAction = z.infer<typeof manageDevelopmentProjectInputSchema>;

// ------------------------------------------------------------- deps ---

export interface DevelopmentProjectDeps {
  registry: ProjectRegistry;
  userId?: () => string | null;
  hasDirectoryAccess?: (userId: string, hostPath: string) => boolean;
  /** Override staging root for tests; production uses the destination parent. */
  stagingRoot?: (destination: string) => string;
}

function resolveUserId(deps: DevelopmentProjectDeps): string | null {
  return (deps.userId ?? getRequestUserId)();
}

function requireOwner(
  deps: DevelopmentProjectDeps,
): { userId: string } | { error: ReturnType<typeof toolError> } {
  const userId = resolveUserId(deps);
  if (!userId) {
    return { error: toolError("AUTHENTICATION_REQUIRED", "An authenticated owner is required.") };
  }
  return { userId };
}

function defaultHasAccess(userId: string, candidate: string): boolean {
  return path.isAbsolute(candidate) && directoryGrantStore.hasAccess(userId, candidate);
}

function hasAccess(deps: DevelopmentProjectDeps, userId: string, candidate: string): boolean {
  return (deps.hasDirectoryAccess ?? defaultHasAccess)(userId, candidate);
}

function defaultStagingRoot(destination: string): string {
  return path.dirname(destination);
}

// ------------------------------------------------------------- actions ---

async function listTemplatesAction(
  args: { ecosystem: DevelopmentEcosystem },
  deps: DevelopmentProjectDeps,
) {
  const owner = requireOwner(deps);
  if ("error" in owner) return owner.error;

  if (!deps.registry.has(args.ecosystem)) {
    return toolError("DEVELOPMENT_PROJECT_UNKNOWN", `No provider registered for ecosystem: ${args.ecosystem}`);
  }

  const provider = deps.registry.get(args.ecosystem);
  const templates = provider.templates();
  return toolJson({ ok: true, ecosystem: args.ecosystem, templates });
}

async function inspectAction(
  args: { ecosystem: DevelopmentEcosystem; root: string },
  deps: DevelopmentProjectDeps,
) {
  const owner = requireOwner(deps);
  if ("error" in owner) return owner.error;

  if (!hasAccess(deps, owner.userId, args.root)) {
    return toolError("OUTSIDE_ALLOWED_DIRS", `Path is outside allowed directories: ${args.root}`);
  }

  if (!deps.registry.has(args.ecosystem)) {
    return toolError("DEVELOPMENT_PROJECT_UNKNOWN", `No provider registered for ecosystem: ${args.ecosystem}`);
  }

  const provider = deps.registry.get(args.ecosystem);
  try {
    const inspection = await provider.inspect(args.root);
    return toolJson({ ok: true, ...inspection });
  } catch (err) {
    return toolError("INVALID_ARGUMENT", (err as Error).message);
  }
}

async function createAction(
  args: {
    ecosystem: DevelopmentEcosystem;
    templateId: string;
    projectName: string;
    packageId: string;
    destination: string;
    profile: ProjectTemplateProfile;
  },
  deps: DevelopmentProjectDeps,
  ctx: ServerContext,
) {
  const owner = requireOwner(deps);
  if ("error" in owner) return owner.error;

  // Directory approval: the destination's parent must be in allowed dirs.
  const parentDir = path.dirname(args.destination);
  if (!hasAccess(deps, owner.userId, parentDir)) {
    return toolError("DEVELOPMENT_DESTINATION_DENIED", `Destination parent is outside allowed directories: ${parentDir}`);
  }

  // Nonempty destination rejection.
  if (fs.existsSync(args.destination) && fs.readdirSync(args.destination).length > 0) {
    return toolError("DEVELOPMENT_DESTINATION_DENIED", `Destination is not empty: ${args.destination}`);
  }

  if (!deps.registry.has(args.ecosystem)) {
    return toolError("DEVELOPMENT_PROJECT_UNKNOWN", `No provider registered for ecosystem: ${args.ecosystem}`);
  }

  const provider = deps.registry.get(args.ecosystem);

  // Exact create approval — single-use, showing ecosystem/template/destination.
  const subjectKey = `${args.ecosystem}:${args.templateId}:${args.destination}`;
  const approval = await requestApproval(ctx, {
    tool: "manage_development_project",
    userId: owner.userId,
    subject: { kind: "development", key: subjectKey, display: `create ${args.ecosystem} project` },
    argsDigest: digestArguments(args),
    reasons: [
      `Create ${args.ecosystem} project from template ${args.templateId} into ${args.destination}.`,
    ],
    decisionMode: "single_use",
  });
  if (approval !== true) return approval;

  // Stage in the authorized parent, then atomic move.
  const stagingRoot = (deps.stagingRoot ?? defaultStagingRoot)(args.destination);
  const request: ProjectCreateRequest = {
    templateId: args.templateId,
    projectName: args.projectName,
    packageId: args.packageId,
    destination: args.destination,
    profile: args.profile,
  };

  try {
    const result = await provider.create(request, stagingRoot);
    // Return summary without secrets — only root and relative file list.
    return toolJson({
      ok: true,
      ecosystem: args.ecosystem,
      root: result.root,
      fileCount: result.files.length,
      files: result.files,
    });
  } catch (err) {
    return toolError("DEVELOPMENT_CREATE_FAILED", (err as Error).message);
  }
}

// ------------------------------------------------------------- dispatch ---

export async function manageDevelopmentProject(
  args: unknown,
  deps: DevelopmentProjectDeps,
  ctx: ServerContext,
) {
  const parsed = manageDevelopmentProjectInputSchema.parse(args);
  switch (parsed.action) {
    case "list_templates":
      return listTemplatesAction(parsed, deps);
    case "inspect":
      return inspectAction(parsed, deps);
    case "create":
      return createAction(parsed, deps, ctx);
  }
}

// ------------------------------------------------------------- register ---

export function registerDevelopmentProjectTool(
  server: McpServer,
  deps: DevelopmentProjectDeps,
) {
  server.registerTool(
    "manage_development_project",
    {
      description:
        "Owner-only development project management. Lists reviewed templates, " +
        "inspects existing projects, and scaffolds new projects from reviewed " +
        "templates into authorized destinations. The caller never supplies a " +
        "template path, executable, command, URL, or free-form package-manager " +
        "switch. Project creation requires single-use exact approval and stages " +
        "atomically with rollback on failure.",
      inputSchema: manageDevelopmentProjectInputSchema,
    },
    async (args, ctx) =>
      authorizeOwnerToolCall("manage_development_project", args) ??
      runTool(
        {
          name: "manage_development_project",
          concurrency: "default",
          subject: { kind: "development", key: "project", display: "development project" },
        },
        async () => manageDevelopmentProject(args, deps, ctx),
      ),
  );
}
