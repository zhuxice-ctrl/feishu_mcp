/**
 * Owner-only Windows development adapter tool.
 *
 * A single strict `windows_development` tool routes every supported Windows
 * operation — .NET, Visual Studio/MSBuild, native CMake/Ninja, and Electron —
 * through the trusted environment snapshot. Read-only inspections (project
 * inspection, template enumeration) run synchronously behind the normal tool
 * concurrency gate. Restore/build/test/package/run operations revalidate
 * project and toolchain digests and use standard exact approval so an
 * unchanged project script may be remembered. Dependency-lock generation and
 * signing call `requestApproval` with `decisionMode: "single_use"`. Approved
 * work enqueues an internal launch spec through the persistent task core and
 * immediately returns `{ ok, taskId, state: "queued" }`. Stop resolves an
 * owned running task; it never accepts a process id.
 *
 * The caller never supplies an executable, SDK location, MSBuild property,
 * CMake flag, URL, or arbitrary argument. Every binary is resolved from a
 * `ready` catalog component; every command is built from a fixed argument
 * array with `shell: false`. No secret, path, owner key, credential value, or
 * toolchain detail is returned to the caller.
 */

import path from "node:path";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import { DEV_TASK_MAX_RUNTIME_MS } from "../config.js";
import { getRequestUserId } from "../security/requestContext.js";
import { directoryGrantStore } from "../security/directoryGrantStore.js";
import { authorizeOwnerToolCall } from "../security/toolAccess.js";
import { digestArguments, requestApproval } from "../security/approval.js";
import { developmentOwnerKey } from "../development/tasks/ownerKey.js";
import type { DevelopmentTaskCoordinator } from "../development/tasks/coordinator.js";
import type { DevelopmentLaunchSpec } from "../development/tasks/types.js";
import type { EnvironmentInspector, EnvironmentSnapshot } from "../development/environment/inspect.js";
import { resolveWindowsToolchain, type WindowsToolchain, type WindowsToolchainResolution } from "../development/windows/toolchain.js";
import { planDotnetAction } from "../development/windows/dotnet.js";
import { planMsbuildAction } from "../development/windows/msbuild.js";
import { planNativeAction } from "../development/windows/native.js";
import { planElectronAction, isManifestDigestStale } from "../development/windows/electron.js";
import {
  planSignToolSign,
  planPfxSign,
  planSignToolVerify,
  type CertificateInspector,
} from "../development/windows/signing.js";
import { planWindowsRun, resolveStopTaskId } from "../development/windows/run.js";
import type { DevelopmentProjectProvider } from "../development/projects/types.js";
import type { LocalCredentialStore } from "../development/credentials/dpapiStore.js";
import { runTool } from "./registry.js";
import { toolError, toolJson } from "./results.js";

// ----------------------------------------------------------- input schema ---

const hostPath = z.string().min(1).max(4096);
const projectName = z.string().min(1).max(256);
const scriptName = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/, "invalid script name");
const credentialId = z.string().uuid();
const taskId = z.string().min(1).max(128);
const configuration = z.enum(["Debug", "Release"]);
const platform = z.enum(["AnyCPU", "x86", "x64", "ARM64"]);
const framework = z.string().min(1).max(32).regex(/^[a-z0-9.]+$/i, "invalid framework");
const runtime = z.string().min(1).max(32).regex(/^[a-z0-9-]+$/i, "invalid runtime");
const msbuildTarget = z.enum(["Restore", "Build", "Rebuild", "Clean", "Test"]);
const nativeTarget = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/, "invalid target");
const cmakePreset = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/, "invalid preset");
const timestampOrigin = z.string().min(1).max(128);

/**
 * Strict discriminated input schema. Every variant rejects unknown fields, so
 * a caller can never smuggle a `url`, `executable`, `args`, or shell token.
 */
export const windowsDevelopmentInputSchema = z.discriminatedUnion("action", [
  // ---- synchronous inspections ----
  z.object({ action: z.literal("inspect_project"), root: hostPath }).strict(),
  z.object({ action: z.literal("list_templates") }).strict(),
  // ---- dotnet (standard approval; generate_dependency_lock = single_use) ----
  z.object({ action: z.literal("dotnet_restore"), root: hostPath, projectOrSolution: projectName, configuration: configuration.optional(), framework: framework.optional() }).strict(),
  z.object({ action: z.literal("dotnet_build"), root: hostPath, projectOrSolution: projectName, configuration: configuration.optional(), framework: framework.optional() }).strict(),
  z.object({ action: z.literal("dotnet_test"), root: hostPath, projectOrSolution: projectName, configuration: configuration.optional(), framework: framework.optional() }).strict(),
  z.object({ action: z.literal("dotnet_publish"), root: hostPath, projectOrSolution: projectName, configuration: configuration.optional(), framework: framework.optional(), runtime: runtime.optional() }).strict(),
  z.object({ action: z.literal("dotnet_pack"), root: hostPath, projectOrSolution: projectName, configuration: configuration.optional() }).strict(),
  z.object({ action: z.literal("dotnet_generate_dependency_lock"), root: hostPath, projectOrSolution: projectName }).strict(),
  // ---- msbuild (standard approval) ----
  z.object({ action: z.literal("msbuild_restore"), root: hostPath, solutionOrProject: projectName }).strict(),
  z.object({ action: z.literal("msbuild_build"), root: hostPath, solutionOrProject: projectName, target: msbuildTarget, configuration, platform }).strict(),
  z.object({ action: z.literal("msbuild_rebuild"), root: hostPath, solutionOrProject: projectName, target: msbuildTarget, configuration, platform }).strict(),
  z.object({ action: z.literal("msbuild_clean"), root: hostPath, solutionOrProject: projectName, target: msbuildTarget, configuration, platform }).strict(),
  z.object({ action: z.literal("msbuild_test"), root: hostPath, solutionOrProject: projectName, target: msbuildTarget, configuration, platform }).strict(),
  // ---- native cmake/ninja (standard approval) ----
  z.object({ action: z.literal("native_configure"), root: hostPath, sourceDir: hostPath, buildDir: hostPath, preset: cmakePreset.optional(), configuration: configuration.optional() }).strict(),
  z.object({ action: z.literal("native_build"), root: hostPath, buildDir: hostPath, configuration, target: nativeTarget }).strict(),
  z.object({ action: z.literal("native_test"), root: hostPath, buildDir: hostPath, configuration }).strict(),
  z.object({ action: z.literal("native_install"), root: hostPath, buildDir: hostPath, configuration, prefix: hostPath }).strict(),
  z.object({ action: z.literal("native_package"), root: hostPath, buildDir: hostPath, configuration }).strict(),
  // ---- electron (standard approval) ----
  z.object({ action: z.literal("electron_install"), root: hostPath }).strict(),
  z.object({ action: z.literal("electron_run_script"), root: hostPath, scriptName }).strict(),
  z.object({ action: z.literal("electron_test"), root: hostPath, scriptName }).strict(),
  z.object({ action: z.literal("electron_package"), root: hostPath, scriptName }).strict(),
  // ---- signing (single-use) ----
  z.object({ action: z.literal("sign"), inFile: hostPath, outFile: hostPath, credentialId, timestampOrigin, pfxHelperPath: hostPath.optional() }).strict(),
  z.object({ action: z.literal("verify"), inFile: hostPath }).strict(),
  // ---- run / stop (run = standard, stop = resolve task id) ----
  z.object({ action: z.literal("run"), artifactPath: hostPath, cwd: hostPath }).strict(),
  z.object({ action: z.literal("stop"), taskId }).strict(),
]);

export type WindowsDevelopmentAction = z.infer<typeof windowsDevelopmentInputSchema>;

// ----------------------------------------------------------------- deps ---

export interface WindowsDevelopmentDeps {
  coordinator: DevelopmentTaskCoordinator;
  inspector: EnvironmentInspector;
  /** Providers keyed by ecosystem. */
  dotnetProvider: DevelopmentProjectProvider;
  nativeProvider: DevelopmentProjectProvider;
  electronProvider: DevelopmentProjectProvider;
  credentialStore: LocalCredentialStore;
  /** Certificate inspector for EKU/validity checks. Optional in pure tests. */
  certInspector?: CertificateInspector;
  userId?: () => string | null;
  hasDirectoryAccess?: (userId: string, hostPath: string) => boolean;
  /** Override toolchain resolution in tests. */
  resolveToolchain?: (snapshot: EnvironmentSnapshot) => WindowsToolchainResolution;
  taskTimeoutMs?: number;
  /** PFX import helper path (production default). */
  pfxHelperPath?: string;
}

function resolveUserId(deps: WindowsDevelopmentDeps): string | null {
  return (deps.userId ?? getRequestUserId)();
}

function requireOwner(
  deps: WindowsDevelopmentDeps,
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

function hasAccess(deps: WindowsDevelopmentDeps, userId: string, candidate: string): boolean {
  return (deps.hasDirectoryAccess ?? defaultHasAccess)(userId, candidate);
}

interface ResolvedToolchain {
  toolchain: WindowsToolchain;
  snapshot: EnvironmentSnapshot;
}

async function resolveToolchainOrError(
  deps: WindowsDevelopmentDeps,
): Promise<ResolvedToolchain | { error: ReturnType<typeof toolError> }> {
  const { snapshot } = await deps.inspector.inspect();
  const resolution = (deps.resolveToolchain ?? resolveWindowsToolchain)(snapshot);
  if ("error" in resolution) {
    return {
      error: toolError(
        "WINDOWS_TOOLCHAIN_UNAVAILABLE",
        `Windows toolchain ${resolution.error}: ${resolution.componentIds.join(", ")}`,
      ),
    };
  }
  return { toolchain: resolution.toolchain, snapshot };
}

// --------------------------------------------------- synchronous actions ---

async function inspectProject(args: { root: string }, deps: WindowsDevelopmentDeps) {
  const owner = requireOwner(deps);
  if ("error" in owner) return owner.error;
  // Inspect via the dotnet provider which delegates to the shared detector.
  const inspection = await deps.dotnetProvider.inspect(args.root);
  return toolJson({ ok: true, project: inspection });
}

async function listTemplates(deps: WindowsDevelopmentDeps) {
  const owner = requireOwner(deps);
  if ("error" in owner) return owner.error;
  return toolJson({
    ok: true,
    dotnet: deps.dotnetProvider.templates(),
    native: deps.nativeProvider.templates(),
    electron: deps.electronProvider.templates(),
  });
}

// ------------------------------------------------- approval + enqueue ---

interface EnqueueResult {
  ok: true;
  taskId: string;
  state: string;
}

function enqueue(
  deps: WindowsDevelopmentDeps,
  userId: string,
  action: string,
  taskClass: "default" | "build" | "privileged",
  resources: string[],
  launch: DevelopmentLaunchSpec,
  secretValues?: string[],
): EnqueueResult | { error: ReturnType<typeof toolError> } {
  try {
    const record = deps.coordinator.enqueue({
      ownerKey: developmentOwnerKey(userId),
      tool: "windows_development",
      action,
      class: taskClass,
      resources,
      launch,
      secretValues,
    });
    return { ok: true, taskId: record.id, state: record.state };
  } catch {
    return { error: toolError("TASK_QUEUE_FULL", "The development task queue is full.") };
  }
}

function buildLaunch(
  plan: { executable: string; args: string[]; cwd: string; timeoutMs: number; successExitCodes: number[]; artifactRoots?: string[] },
  deps: WindowsDevelopmentDeps,
): DevelopmentLaunchSpec {
  return {
    executable: plan.executable,
    args: plan.args,
    cwd: plan.cwd,
    env: {},
    timeoutMs: plan.timeoutMs,
    successExitCodes: plan.successExitCodes,
    artifactRoots: plan.artifactRoots,
  };
}

/** Standard exact approval for restore/build/test/package/run operations. */
async function standardProjectAction(
  args: Record<string, unknown>,
  deps: WindowsDevelopmentDeps,
  ctx: ServerContext,
  actionName: string,
  planBuilder: (toolchain: WindowsToolchain) => { executable: string; args: string[]; cwd: string; scriptDigest: string; artifactRoots: string[]; timeoutMs: number; successExitCodes: number[] },
  subjectDisplay: string,
) {
  const owner = requireOwner(deps);
  if ("error" in owner) return owner.error;
  const resolved = await resolveToolchainOrError(deps);
  if ("error" in resolved) return resolved.error;

  let plan;
  try {
    plan = planBuilder(resolved.toolchain);
  } catch (err) {
    return mapPlanError(err);
  }

  const approval = await requestApproval(ctx, {
    tool: "windows_development",
    userId: owner.userId,
    subject: { kind: "development", key: plan.scriptDigest, display: subjectDisplay },
    argsDigest: digestArguments(args),
    reasons: [`${subjectDisplay}.`],
  });
  if (approval !== true) return approval;

  const launch = buildLaunch(plan, deps);
  const enqueued = enqueue(deps, owner.userId, actionName, "build", [String(args.root ?? "")], launch);
  if ("error" in enqueued) return enqueued.error;
  return toolJson(enqueued);
}

/** Single-use approval for dependency-lock generation and signing. */
async function singleUseAction(
  args: Record<string, unknown>,
  deps: WindowsDevelopmentDeps,
  ctx: ServerContext,
  actionName: string,
  planBuilder: (toolchain: WindowsToolchain) => { executable: string; args: string[]; cwd: string; scriptDigest: string; artifactRoots: string[]; timeoutMs: number; successExitCodes: number[] },
  subjectDisplay: string,
  subjectKey: string,
) {
  const owner = requireOwner(deps);
  if ("error" in owner) return owner.error;
  const resolved = await resolveToolchainOrError(deps);
  if ("error" in resolved) return resolved.error;

  let plan;
  try {
    plan = planBuilder(resolved.toolchain);
  } catch (err) {
    return mapPlanError(err);
  }

  const approval = await requestApproval(ctx, {
    tool: "windows_development",
    userId: owner.userId,
    subject: { kind: "development", key: subjectKey, display: subjectDisplay },
    argsDigest: digestArguments(args),
    reasons: [`${subjectDisplay}.`],
    decisionMode: "single_use",
  });
  if (approval !== true) return approval;

  const launch = buildLaunch(plan, deps);
  const enqueued = enqueue(deps, owner.userId, actionName, "default", [subjectKey], launch);
  if ("error" in enqueued) return enqueued.error;
  return toolJson(enqueued);
}

function mapPlanError(err: unknown): ReturnType<typeof toolError> {
  const message = (err as Error).message;
  if (message.includes("host path")) {
    return toolError("WINDOWS_HOST_PATH_DENIED", message);
  }
  if (message.includes("credential")) {
    return toolError("WINDOWS_CREDENTIAL_UNKNOWN", message);
  }
  if (message.includes("certificate") || message.includes("EKU") || message.includes("thumbprint")) {
    return toolError("WINDOWS_CERTIFICATE_INVALID", message);
  }
  if (message.includes("artifact") || message.includes("runnable") || message.includes("symlink")) {
    return toolError("WINDOWS_ARTIFACT_DENIED", message);
  }
  if (message.includes("manifest") || message.includes("script not found")) {
    return toolError("WINDOWS_MANIFEST_STALE", message);
  }
  return toolError("INVALID_ARGUMENT", message);
}

// ------------------------------------------------------------- signing ---

async function signAction(
  args: { inFile: string; outFile: string; credentialId: string; timestampOrigin: string; pfxHelperPath?: string },
  deps: WindowsDevelopmentDeps,
  ctx: ServerContext,
) {
  const owner = requireOwner(deps);
  if ("error" in owner) return owner.error;
  const resolved = await resolveToolchainOrError(deps);
  if ("error" in resolved) return resolved.error;

  let plan;
  try {
    const opts = {
      authorizeHostPath: (p: string) => hasAccess(deps, owner.userId, p),
      credentialStore: deps.credentialStore,
      certInspector: deps.certInspector,
    };
    if (args.pfxHelperPath || deps.pfxHelperPath) {
      plan = planPfxSign(
        resolved.toolchain,
        { inFile: args.inFile, outFile: args.outFile, credentialId: args.credentialId, timestampOrigin: args.timestampOrigin, helperPath: args.pfxHelperPath ?? deps.pfxHelperPath! },
        opts,
      );
    } else {
      plan = planSignToolSign(
        resolved.toolchain,
        { inFile: args.inFile, outFile: args.outFile, credentialId: args.credentialId, timestampOrigin: args.timestampOrigin },
        opts,
      );
    }
  } catch (err) {
    return mapPlanError(err);
  }

  const approval = await requestApproval(ctx, {
    tool: "windows_development",
    userId: owner.userId,
    subject: { kind: "credential", key: args.outFile, display: "signtool sign" },
    argsDigest: digestArguments(args),
    reasons: ["Sign a Windows artifact with a local certificate credential."],
    decisionMode: "single_use",
  });
  if (approval !== true) return approval;

  // For signing, the launch spec runs the sign command on the staging path.
  // The worker handles stageCopy → sign → verify → move; here we enqueue the
  // sign command (the coordinator worker performs the staged sequence).
  const launch: DevelopmentLaunchSpec = {
    executable: plan.signCommand.executable,
    args: plan.signCommand.args,
    cwd: path.dirname(plan.stagingOut),
    env: {},
    timeoutMs: deps.taskTimeoutMs ?? DEV_TASK_MAX_RUNTIME_MS,
    successExitCodes: [0],
    artifactRoots: [path.dirname(plan.outFile)],
  };
  const enqueued = enqueue(deps, owner.userId, "sign", "default", [args.outFile], launch);
  if ("error" in enqueued) return enqueued.error;
  return toolJson(enqueued);
}

async function verifyAction(
  args: { inFile: string },
  deps: WindowsDevelopmentDeps,
  ctx: ServerContext,
) {
  const owner = requireOwner(deps);
  if ("error" in owner) return owner.error;
  const resolved = await resolveToolchainOrError(deps);
  if ("error" in resolved) return resolved.error;

  let plan;
  try {
    plan = planSignToolVerify(
      resolved.toolchain,
      { inFile: args.inFile },
      { authorizeHostPath: (p) => hasAccess(deps, owner.userId, p) },
    );
  } catch (err) {
    return mapPlanError(err);
  }

  const approval = await requestApproval(ctx, {
    tool: "windows_development",
    userId: owner.userId,
    subject: { kind: "credential", key: args.inFile, display: "signtool verify" },
    argsDigest: digestArguments(args),
    reasons: ["Verify a Windows artifact signature."],
    decisionMode: "single_use",
  });
  if (approval !== true) return approval;

  const launch: DevelopmentLaunchSpec = {
    executable: plan.verifyCommand.executable,
    args: plan.verifyCommand.args,
    cwd: path.dirname(args.inFile),
    env: {},
    timeoutMs: deps.taskTimeoutMs ?? DEV_TASK_MAX_RUNTIME_MS,
    successExitCodes: [0],
  };
  const enqueued = enqueue(deps, owner.userId, "verify", "default", [args.inFile], launch);
  if ("error" in enqueued) return enqueued.error;
  return toolJson(enqueued);
}

// ------------------------------------------------------------- run/stop ---

async function runAction(
  args: { artifactPath: string; cwd: string },
  deps: WindowsDevelopmentDeps,
  ctx: ServerContext,
) {
  const owner = requireOwner(deps);
  if ("error" in owner) return owner.error;

  let plan;
  try {
    plan = planWindowsRun(
      { artifactPath: args.artifactPath, cwd: args.cwd, timeoutMs: deps.taskTimeoutMs ?? DEV_TASK_MAX_RUNTIME_MS },
      { authorizeHostPath: (p) => hasAccess(deps, owner.userId, p) },
    );
  } catch (err) {
    return mapPlanError(err);
  }

  const approval = await requestApproval(ctx, {
    tool: "windows_development",
    userId: owner.userId,
    subject: { kind: "development", key: plan.canonicalPathHash, display: "run artifact" },
    argsDigest: digestArguments(args),
    reasons: [`Run artifact ${args.artifactPath}.`],
  });
  if (approval !== true) return approval;

  const launch: DevelopmentLaunchSpec = {
    executable: plan.executable,
    args: plan.args,
    cwd: plan.cwd,
    env: {},
    timeoutMs: plan.timeoutMs,
    successExitCodes: plan.successExitCodes,
  };
  const enqueued = enqueue(deps, owner.userId, "run", "default", [args.artifactPath], launch);
  if ("error" in enqueued) return enqueued.error;
  return toolJson(enqueued);
}

async function stopAction(
  args: { taskId: string },
  deps: WindowsDevelopmentDeps,
) {
  const owner = requireOwner(deps);
  if ("error" in owner) return owner.error;

  const record = deps.coordinator.store.get(args.taskId);
  if (!record || record.ownerKey !== developmentOwnerKey(owner.userId)) {
    return toolError("TASK_NOT_FOUND", "Unknown development task.");
  }
  if (["succeeded", "failed", "cancelled", "interrupted"].includes(record.state)) {
    return toolJson({ ok: true, alreadyTerminal: true, taskId: args.taskId });
  }
  const result = deps.coordinator.cancel(args.taskId, developmentOwnerKey(owner.userId));
  if ("denied" in result) {
    return toolError("TASK_NOT_FOUND", "Unknown development task.");
  }
  return toolJson({ ok: true, taskId: args.taskId, state: "cancel_requested" });
}

// ------------------------------------------------------------- dispatch ---

export async function windowsDevelopment(
  args: unknown,
  deps: WindowsDevelopmentDeps,
  ctx: ServerContext,
) {
  const parsed = windowsDevelopmentInputSchema.parse(args);
  const timeoutMs = deps.taskTimeoutMs ?? DEV_TASK_MAX_RUNTIME_MS;
  switch (parsed.action) {
    case "inspect_project":
      return inspectProject(parsed, deps);
    case "list_templates":
      return listTemplates(deps);

    // ---- dotnet ----
    case "dotnet_restore":
      return standardProjectAction(parsed, deps, ctx, "dotnet_restore",
        (tc) => planDotnetAction(tc, { root: parsed.root, projectOrSolution: parsed.projectOrSolution, action: "restore", configuration: parsed.configuration, framework: parsed.framework, timeoutMs }),
        `dotnet restore ${parsed.projectOrSolution}`);
    case "dotnet_build":
      return standardProjectAction(parsed, deps, ctx, "dotnet_build",
        (tc) => planDotnetAction(tc, { root: parsed.root, projectOrSolution: parsed.projectOrSolution, action: "build", configuration: parsed.configuration, framework: parsed.framework, timeoutMs }),
        `dotnet build ${parsed.projectOrSolution}`);
    case "dotnet_test":
      return standardProjectAction(parsed, deps, ctx, "dotnet_test",
        (tc) => planDotnetAction(tc, { root: parsed.root, projectOrSolution: parsed.projectOrSolution, action: "test", configuration: parsed.configuration, framework: parsed.framework, timeoutMs }),
        `dotnet test ${parsed.projectOrSolution}`);
    case "dotnet_publish":
      return standardProjectAction(parsed, deps, ctx, "dotnet_publish",
        (tc) => planDotnetAction(tc, { root: parsed.root, projectOrSolution: parsed.projectOrSolution, action: "publish", configuration: parsed.configuration, framework: parsed.framework, runtime: parsed.runtime, timeoutMs }),
        `dotnet publish ${parsed.projectOrSolution}`);
    case "dotnet_pack":
      return standardProjectAction(parsed, deps, ctx, "dotnet_pack",
        (tc) => planDotnetAction(tc, { root: parsed.root, projectOrSolution: parsed.projectOrSolution, action: "pack", configuration: parsed.configuration, timeoutMs }),
        `dotnet pack ${parsed.projectOrSolution}`);
    case "dotnet_generate_dependency_lock":
      return singleUseAction(parsed, deps, ctx, "dotnet_generate_dependency_lock",
        (tc) => planDotnetAction(tc, { root: parsed.root, projectOrSolution: parsed.projectOrSolution, action: "generate_dependency_lock", timeoutMs }),
        `dotnet generate lock ${parsed.projectOrSolution}`, parsed.projectOrSolution);

    // ---- msbuild ----
    case "msbuild_restore":
      return standardProjectAction(parsed, deps, ctx, "msbuild_restore",
        (tc) => planMsbuildAction(tc, { root: parsed.root, solutionOrProject: parsed.solutionOrProject, target: "Restore", configuration: "Debug", platform: "AnyCPU", timeoutMs }),
        `msbuild restore ${parsed.solutionOrProject}`);
    case "msbuild_build":
    case "msbuild_rebuild":
    case "msbuild_clean":
    case "msbuild_test": {
      const target = parsed.action === "msbuild_build" ? "Build"
        : parsed.action === "msbuild_rebuild" ? "Rebuild"
        : parsed.action === "msbuild_clean" ? "Clean" : "Test";
      return standardProjectAction(parsed, deps, ctx, parsed.action,
        (tc) => planMsbuildAction(tc, { root: parsed.root, solutionOrProject: parsed.solutionOrProject, target, configuration: parsed.configuration, platform: parsed.platform, timeoutMs }),
        `msbuild ${target.toLowerCase()} ${parsed.solutionOrProject}`);
    }

    // ---- native ----
    case "native_configure":
      return standardProjectAction(parsed, deps, ctx, "native_configure",
        (tc) => planNativeAction(tc, { root: parsed.root, sourceDir: parsed.sourceDir, buildDir: parsed.buildDir, action: "configure", preset: parsed.preset, configuration: parsed.configuration ?? "Debug", timeoutMs }),
        `cmake configure ${parsed.sourceDir}`);
    case "native_build":
      return standardProjectAction(parsed, deps, ctx, "native_build",
        (tc) => planNativeAction(tc, { root: parsed.root, sourceDir: parsed.root, buildDir: parsed.buildDir, action: "build", configuration: parsed.configuration, target: parsed.target, timeoutMs }),
        `cmake build ${parsed.buildDir}`);
    case "native_test":
      return standardProjectAction(parsed, deps, ctx, "native_test",
        (tc) => planNativeAction(tc, { root: parsed.root, sourceDir: parsed.root, buildDir: parsed.buildDir, action: "test", configuration: parsed.configuration, timeoutMs }),
        `ctest ${parsed.buildDir}`);
    case "native_install":
      return standardProjectAction(parsed, deps, ctx, "native_install",
        (tc) => planNativeAction(tc, { root: parsed.root, sourceDir: parsed.root, buildDir: parsed.buildDir, action: "install", configuration: parsed.configuration, prefix: parsed.prefix, timeoutMs }),
        `cmake install ${parsed.buildDir}`);
    case "native_package":
      return standardProjectAction(parsed, deps, ctx, "native_package",
        (tc) => planNativeAction(tc, { root: parsed.root, sourceDir: parsed.root, buildDir: parsed.buildDir, action: "package", configuration: parsed.configuration, timeoutMs }),
        `cpack ${parsed.buildDir}`);

    // ---- electron ----
    case "electron_install":
      return standardProjectAction(parsed, deps, ctx, "electron_install",
        (tc) => planElectronAction(tc, { root: parsed.root, action: "install", timeoutMs }),
        `electron install ${parsed.root}`);
    case "electron_run_script":
      return standardProjectAction(parsed, deps, ctx, "electron_run_script",
        (tc) => planElectronAction(tc, { root: parsed.root, action: "run_script", scriptName: parsed.scriptName, timeoutMs }),
        `electron run ${parsed.scriptName}`);
    case "electron_test":
      return standardProjectAction(parsed, deps, ctx, "electron_test",
        (tc) => planElectronAction(tc, { root: parsed.root, action: "test", scriptName: parsed.scriptName, timeoutMs }),
        `electron test ${parsed.scriptName}`);
    case "electron_package":
      return standardProjectAction(parsed, deps, ctx, "electron_package",
        (tc) => planElectronAction(tc, { root: parsed.root, action: "package", scriptName: parsed.scriptName, timeoutMs }),
        `electron package ${parsed.scriptName}`);

    // ---- signing ----
    case "sign":
      return signAction(parsed, deps, ctx);
    case "verify":
      return verifyAction(parsed, deps, ctx);

    // ---- run / stop ----
    case "run":
      return runAction(parsed, deps, ctx);
    case "stop":
      return stopAction(parsed, deps);
  }
}

// ----------------------------------------------------------- registration ---

export function registerWindowsDevelopmentTool(
  server: McpServer,
  deps: WindowsDevelopmentDeps,
): void {
  server.registerTool(
    "windows_development",
    {
      description:
        "Owner-only Windows development adapter. Inspects .NET, native " +
        "CMake, and Electron projects, enumerates templates, and runs " +
        "restore/build/test/package/publish, MSBuild, CMake/Ninja/CTest, " +
        "Electron script, signing, and run/stop operations. Every binary is " +
        "resolved from the trusted environment; no caller-supplied " +
        "executable, SDK path, MSBuild property, CMake flag, URL, or " +
        "argument is accepted. Long operations enqueue a background task " +
        "and return a task id. Stop never accepts a process id.",
      inputSchema: {
        action: z.enum([
          "inspect_project", "list_templates",
          "dotnet_restore", "dotnet_build", "dotnet_test", "dotnet_publish",
          "dotnet_pack", "dotnet_generate_dependency_lock",
          "msbuild_restore", "msbuild_build", "msbuild_rebuild",
          "msbuild_clean", "msbuild_test",
          "native_configure", "native_build", "native_test",
          "native_install", "native_package",
          "electron_install", "electron_run_script", "electron_test",
          "electron_package",
          "sign", "verify", "run", "stop",
        ]),
      },
    },
    async (args, ctx) =>
      authorizeOwnerToolCall("windows_development", args) ??
      runTool(
        {
          name: "windows_development",
          concurrency: "default",
          subject: { kind: "development", key: "windows", display: "windows development" },
        },
        async () => windowsDevelopment(args, deps, ctx),
      ),
  );
}
