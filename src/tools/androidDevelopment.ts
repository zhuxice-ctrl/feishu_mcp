/**
 * Owner-only Android development adapter tool.
 *
 * A single strict `android_development` tool routes every supported Android
 * operation through the trusted environment snapshot. Read-only inspections
 * (project inspection, template enumeration, device list, AVD list) run
 * synchronously behind the normal tool concurrency gate. Gradle build/test
 * actions use standard exact approval so an unchanged project script may be
 * remembered. Every device write, lifecycle mutation, transfer, forwarding,
 * restricted diagnostic, emulator/AVD mutation, and signing action elicits a
 * single-use owner approval, then enqueues an internal launch spec through
 * the persistent task core and immediately returns `{ ok, taskId, state:
 * "queued" }`.
 *
 * The caller never supplies an executable, SDK location, Gradle task/flag,
 * emulator flag, URL, or arbitrary argument. Every binary is resolved from a
 * `ready` catalog component; every command is built from a fixed argument
 * array with `shell: false`. No secret, path, owner key, credential value, or
 * toolchain detail is returned to the caller.
 */

import { spawnSync } from "node:child_process";
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
import { resolveAndroidToolchain, type AndroidToolchain, type ToolchainResolution } from "../development/android/toolchain.js";
import {
  planGradleAction,
  validateGradleWrapper,
  discoverModules,
} from "../development/android/gradle.js";
import { collectArtifacts } from "../development/android/artifacts.js";
import {
  planAdbAction,
  parseDevices,
  type AdbPlan,
} from "../development/android/adb.js";
import {
  planEmulatorStart,
  planEmulatorStop,
  planAvdCreate,
  parseAvdList,
} from "../development/android/emulator.js";
import {
  planApksignerSign,
  planApksignerVerify,
} from "../development/android/signing.js";
import {
  AdbCommandInput,
  GradleCommandInput,
  EmulatorCommandInput,
  AvdmanagerCommandInput,
  ApksignerCommandInput,
} from "../development/android/types.js";
import type { DevelopmentProjectProvider } from "../development/projects/types.js";
import type { LocalCredentialStore } from "../development/credentials/dpapiStore.js";
import { runTool } from "./registry.js";
import { toolError, toolJson } from "./results.js";

// ----------------------------------------------------------- input schema ---

const DANGEROUS_SERIAL_KEYWORDS = ["bootloader", "recovery", "sideload", "fastboot"];
const deviceSerial = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, "invalid device serial")
  .refine((v) => !DANGEROUS_SERIAL_KEYWORDS.includes(v), "dangerous serial keyword");
const packageId = z.string().min(1).max(255);
const activity = z.string().min(1).max(255);
const hostPath = z.string().min(1).max(4096);
const devicePath = z.string().min(1).max(1024);
const port = z.number().int().min(1).max(65535);
const pid = z.number().int().min(1).max(2147483647);
const avdName = z.string().min(1).max(64);
const sdkPackagePath = z.string().min(1).max(256);
const deviceId = z.string().min(1).max(64);
const gradleModule = z.string().min(1).max(64);
const gradleVariant = z.enum(["debug", "release"]);
const credentialId = z.string().uuid();
const ksAlias = z.string().min(1).max(128);

const remoteSpec = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, "invalid remote spec");

const adbDiagnostic = z.enum([
  "getprop_subset",
  "dumpsys_package",
  "dumpsys_activity",
  "pm_path",
  "df_data",
  "pidof_package",
]);

/**
 * Strict discriminated input schema. Every variant rejects unknown fields, so
 * a caller can never smuggle a `url`, `executable`, `args`, or shell token.
 */
export const androidDevelopmentInputSchema = z.discriminatedUnion("action", [
  // ---- synchronous inspections ----
  z.object({ action: z.literal("inspect_project"), root: hostPath }).strict(),
  z.object({ action: z.literal("list_templates") }).strict(),
  z.object({ action: z.literal("list_devices") }).strict(),
  z.object({ action: z.literal("list_avds") }).strict(),
  // ---- gradle build/test (standard approval) ----
  z
    .object({
      action: z.literal("build"),
      root: hostPath,
      module: gradleModule,
      variant: gradleVariant,
    })
    .strict(),
  z
    .object({
      action: z.literal("bundle"),
      root: hostPath,
      module: gradleModule,
      variant: gradleVariant,
    })
    .strict(),
  z
    .object({
      action: z.literal("test_unit"),
      root: hostPath,
      module: gradleModule,
      variant: gradleVariant,
    })
    .strict(),
  z
    .object({
      action: z.literal("test_instrumented"),
      root: hostPath,
      module: gradleModule,
      variant: gradleVariant,
    })
    .strict(),
  z
    .object({
      action: z.literal("clean"),
      root: hostPath,
      module: gradleModule,
      variant: gradleVariant,
    })
    .strict(),
  // ---- device lifecycle (single-use) ----
  z
    .object({
      action: z.literal("install"),
      serial: deviceSerial,
      hostApk: hostPath,
    })
    .strict(),
  z
    .object({
      action: z.literal("uninstall"),
      serial: deviceSerial,
      packageId,
    })
    .strict(),
  z
    .object({
      action: z.literal("clear"),
      serial: deviceSerial,
      packageId,
    })
    .strict(),
  z
    .object({
      action: z.literal("start_app"),
      serial: deviceSerial,
      packageId,
      activity,
    })
    .strict(),
  z
    .object({
      action: z.literal("force_stop"),
      serial: deviceSerial,
      packageId,
    })
    .strict(),
  // ---- device reads (single-use) ----
  z
    .object({
      action: z.literal("screenshot"),
      serial: deviceSerial,
      hostPng: hostPath,
    })
    .strict(),
  z
    .object({
      action: z.literal("logcat"),
      serial: deviceSerial,
      pid,
    })
    .strict(),
  z
    .object({
      action: z.literal("diagnostic"),
      serial: deviceSerial,
      diagnostic: adbDiagnostic,
      packageId: packageId.optional(),
    })
    .strict(),
  // ---- transfer / forwarding (single-use) ----
  z
    .object({
      action: z.literal("push"),
      serial: deviceSerial,
      hostFile: hostPath,
      deviceFile: devicePath,
    })
    .strict(),
  z
    .object({
      action: z.literal("pull"),
      serial: deviceSerial,
      deviceFile: devicePath,
      hostFile: hostPath,
    })
    .strict(),
  z
    .object({
      action: z.literal("forward"),
      serial: deviceSerial,
      localPort: port,
      remoteSpec,
    })
    .strict(),
  // ---- emulator / AVD (single-use) ----
  z
    .object({
      action: z.literal("emulator_start"),
      avdName,
      port,
    })
    .strict(),
  z
    .object({
      action: z.literal("emulator_stop"),
      serial: deviceSerial,
    })
    .strict(),
  z
    .object({
      action: z.literal("avd_create"),
      avdName,
      packageId: sdkPackagePath,
      device: deviceId,
    })
    .strict(),
  // ---- signing (single-use) ----
  z
    .object({
      action: z.literal("sign"),
      inApk: hostPath,
      outApk: hostPath,
      keystore: hostPath,
      ksAlias,
      ksCredentialId: credentialId,
      keyCredentialId: credentialId,
    })
    .strict(),
  z
    .object({
      action: z.literal("verify"),
      inApk: hostPath,
    })
    .strict(),
]);

export type AndroidDevelopmentAction = z.infer<typeof androidDevelopmentInputSchema>;

// ----------------------------------------------------------------- deps ---

export interface AndroidDevelopmentDeps {
  coordinator: DevelopmentTaskCoordinator;
  inspector: EnvironmentInspector;
  projectProvider: DevelopmentProjectProvider;
  credentialStore: LocalCredentialStore;
  /**
   * Generate the Gradle wrapper inside a staged project. In production this
   * runs the trusted Gradle distribution; in tests a fake writes text files.
   */
  generateWrapper: (stagingDir: string, gradleVersion: string) => { distributionSha256Sum: string };
  userId?: () => string | null;
  hasDirectoryAccess?: (userId: string, hostPath: string) => boolean;
  /** Override toolchain resolution in tests. */
  resolveToolchain?: (snapshot: EnvironmentSnapshot) => ToolchainResolution;
  /** Synchronous read-only command runner for inspections. */
  runReadOnly?: (plan: { executable: string; args: string[]; stdin?: string }) => {
    stdout: string;
    exitCode: number | null;
  };
  taskTimeoutMs?: number;
}

function resolveUserId(deps: AndroidDevelopmentDeps): string | null {
  return (deps.userId ?? getRequestUserId)();
}

function requireOwner(
  deps: AndroidDevelopmentDeps,
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

function hasAccess(deps: AndroidDevelopmentDeps, userId: string, candidate: string): boolean {
  return (deps.hasDirectoryAccess ?? defaultHasAccess)(userId, candidate);
}

interface ResolvedToolchain {
  toolchain: AndroidToolchain;
  snapshot: EnvironmentSnapshot;
}

async function resolveToolchainOrError(
  deps: AndroidDevelopmentDeps,
): Promise<ResolvedToolchain | { error: ReturnType<typeof toolError> }> {
  const { snapshot } = await deps.inspector.inspect();
  const resolution = (deps.resolveToolchain ?? resolveAndroidToolchain)(snapshot);
  if ("error" in resolution) {
    const code =
      resolution.error === "TOOLCHAIN_UNTRUSTED"
        ? "ANDROID_TOOLCHAIN_UNAVAILABLE"
        : "ANDROID_TOOLCHAIN_UNAVAILABLE";
    return {
      error: toolError(
        code,
        `Android toolchain ${resolution.error}: ${resolution.componentIds.join(", ")}`,
      ),
    };
  }
  return { toolchain: resolution.toolchain, snapshot };
}

function runReadOnlyDefault(plan: {
  executable: string;
  args: string[];
  stdin?: string;
}): { stdout: string; exitCode: number | null } {
  const result = spawnSync(plan.executable, plan.args, {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    input: plan.stdin,
    shell: false,
  });
  return { stdout: result.stdout ?? "", exitCode: result.status };
}

function runReadOnly(deps: AndroidDevelopmentDeps, plan: { executable: string; args: string[]; stdin?: string }) {
  return (deps.runReadOnly ?? runReadOnlyDefault)(plan);
}

// --------------------------------------------------- synchronous actions ---

async function inspectProject(args: { root: string }, deps: AndroidDevelopmentDeps) {
  const owner = requireOwner(deps);
  if ("error" in owner) return owner.error;
  const inspection = await deps.projectProvider.inspect(args.root);
  return toolJson({ ok: true, project: inspection });
}

async function listTemplates(deps: AndroidDevelopmentDeps) {
  const owner = requireOwner(deps);
  if ("error" in owner) return owner.error;
  return toolJson({ ok: true, templates: deps.projectProvider.templates() });
}

async function listDevices(deps: AndroidDevelopmentDeps) {
  const owner = requireOwner(deps);
  if ("error" in owner) return owner.error;
  const resolved = await resolveToolchainOrError(deps);
  if ("error" in resolved) return resolved.error;
  const built = planAdbAction(resolved.toolchain, { action: "devices" }, {
    authorizeHostPath: () => true,
  });
  const { stdout, exitCode } = runReadOnly(deps, built);
  if (exitCode !== 0) {
    return toolError("INTERNAL_ERROR", "adb devices failed.");
  }
  return toolJson({ ok: true, devices: parseDevices(stdout) });
}

async function listAvds(deps: AndroidDevelopmentDeps) {
  const owner = requireOwner(deps);
  if ("error" in owner) return owner.error;
  const resolved = await resolveToolchainOrError(deps);
  if ("error" in resolved) return resolved.error;
  const built = planAvdList(resolved.toolchain);
  const { stdout, exitCode } = runReadOnly(deps, built);
  if (exitCode !== 0) {
    return toolError("INTERNAL_ERROR", "avdmanager list failed.");
  }
  return toolJson({ ok: true, avds: parseAvdList(stdout) });
}

function planAvdList(toolchain: AndroidToolchain): { executable: string; args: string[] } {
  return buildAvdmanagerRaw(toolchain, { action: "list" });
}

function buildAvdmanagerRaw(toolchain: AndroidToolchain, input: unknown): { executable: string; args: string[] } {
  // Reuse the validated command builder for the list action.
  const validated = AvdmanagerCommandInput.parse(input);
  return { executable: toolchain.avdmanager, args: validated.action === "list" ? ["list", "avd"] : [] };
}

// ------------------------------------------------- approval + enqueue ---

const GRADLE_ACTIONS = new Set(["build", "bundle", "test_unit", "test_instrumented", "clean"]);

interface EnqueueResult {
  ok: true;
  taskId: string;
  state: string;
}

function enqueue(
  deps: AndroidDevelopmentDeps,
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
      tool: "android_development",
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

async function gradleAction(
  args: { action: "build" | "bundle" | "test_unit" | "test_instrumented" | "clean"; root: string; module: string; variant: "debug" | "release" },
  deps: AndroidDevelopmentDeps,
  ctx: ServerContext,
) {
  const owner = requireOwner(deps);
  if ("error" in owner) return owner.error;

  const wrapper = validateGradleWrapper(args.root);
  if (!wrapper.valid) {
    return toolError("ANDROID_WRAPPER_INVALID", `Untrusted Gradle wrapper: ${wrapper.reason}`);
  }
  const modules = discoverModules(args.root);
  if (!modules.includes(args.module)) {
    return toolError("ANDROID_MODULE_UNKNOWN", `Unknown Gradle module: ${args.module}`);
  }

  const resolved = await resolveToolchainOrError(deps);
  if ("error" in resolved) return resolved.error;

  let plan;
  try {
    plan = planGradleAction(resolved.toolchain, {
      root: args.root,
      module: args.module,
      variant: args.variant,
      action: args.action,
      timeoutMs: deps.taskTimeoutMs ?? DEV_TASK_MAX_RUNTIME_MS,
    });
  } catch (err) {
    return toolError("ANDROID_WRAPPER_INVALID", (err as Error).message);
  }

  const subjectKey = plan.scriptDigest;
  const approval = await requestApproval(ctx, {
    tool: "android_development",
    userId: owner.userId,
    subject: { kind: "development", key: subjectKey, display: `gradle ${args.action}` },
    argsDigest: digestArguments(args),
    reasons: [
      `Gradle ${args.action} on module ${args.module} (${args.variant}).`,
      "Build scripts will execute on the host.",
    ],
  });
  if (approval !== true) return approval;

  const launch: DevelopmentLaunchSpec = {
    executable: plan.executable,
    args: plan.args,
    cwd: plan.cwd,
    env: {},
    timeoutMs: plan.timeoutMs,
    successExitCodes: plan.successExitCodes,
    artifactRoots: plan.artifactRoots,
  };
  const enqueued = enqueue(deps, owner.userId, args.action, "build", [args.root], launch);
  if ("error" in enqueued) return enqueued.error;
  return toolJson(enqueued);
}

async function deviceAction(
  args: Record<string, unknown>,
  deps: AndroidDevelopmentDeps,
  ctx: ServerContext,
  actionName: string,
  taskClass: "default" | "privileged",
  resources: string[],
) {
  const owner = requireOwner(deps);
  if ("error" in owner) return owner.error;

  const resolved = await resolveToolchainOrError(deps);
  if ("error" in resolved) return resolved.error;

  let plan: AdbPlan;
  try {
    plan = planAdbAction(resolved.toolchain, args, {
      authorizeHostPath: (p) => hasAccess(deps, owner.userId, p),
    });
  } catch (err) {
    const message = (err as Error).message;
    if (message.includes("host path")) {
      return toolError("ANDROID_HOST_PATH_DENIED", message);
    }
    if (message.includes("device path")) {
      return toolError("ANDROID_DEVICE_PATH_DENIED", message);
    }
    return toolError("INVALID_ARGUMENT", message);
  }

  const approval = await requestApproval(ctx, {
    tool: "android_development",
    userId: owner.userId,
    subject: { kind: "device", key: String(args.serial), display: `device ${args.serial}` },
    argsDigest: digestArguments(args),
    reasons: [`ADB ${actionName} on device ${args.serial}.`],
    decisionMode: "single_use",
  });
  if (approval !== true) return approval;

  const screenshotTarget = actionName === "screenshot" && typeof args.hostPng === "string"
    ? args.hostPng
    : undefined;

  const launch: DevelopmentLaunchSpec = {
    executable: plan.executable,
    args: plan.args,
    cwd: process.cwd(),
    env: {},
    stdin: plan.stdin,
    timeoutMs: deps.taskTimeoutMs ?? DEV_TASK_MAX_RUNTIME_MS,
    successExitCodes: [0],
    ...(screenshotTarget === undefined ? {} : {
      artifactRoots: [path.dirname(screenshotTarget)],
      binaryStdoutSinks: [{
        stream: "stdout" as const,
        type: "png" as const,
        target: screenshotTarget,
        name: path.basename(screenshotTarget),
        kind: "screenshot" as const,
      }],
    }),
  };
  const enqueued = enqueue(deps, owner.userId, actionName, taskClass, resources, launch);
  if ("error" in enqueued) return enqueued.error;
  return toolJson(enqueued);
}

async function emulatorAction(
  args: Record<string, unknown>,
  deps: AndroidDevelopmentDeps,
  ctx: ServerContext,
  actionName: string,
  planBuilder: (toolchain: AndroidToolchain) => { executable: string; args: string[]; stdin?: string },
  subjectKey: string,
  display: string,
) {
  const owner = requireOwner(deps);
  if ("error" in owner) return owner.error;
  const resolved = await resolveToolchainOrError(deps);
  if ("error" in resolved) return resolved.error;

  const built = planBuilder(resolved.toolchain);

  const approval = await requestApproval(ctx, {
    tool: "android_development",
    userId: owner.userId,
    subject: { kind: "device", key: subjectKey, display },
    argsDigest: digestArguments(args),
    reasons: [`${display}.`],
    decisionMode: "single_use",
  });
  if (approval !== true) return approval;

  const launch: DevelopmentLaunchSpec = {
    executable: built.executable,
    args: built.args,
    cwd: process.cwd(),
    env: {},
    stdin: built.stdin,
    timeoutMs: deps.taskTimeoutMs ?? DEV_TASK_MAX_RUNTIME_MS,
    successExitCodes: [0],
  };
  const enqueued = enqueue(deps, owner.userId, actionName, "default", [subjectKey], launch);
  if ("error" in enqueued) return enqueued.error;
  return toolJson(enqueued);
}

async function signAction(
  args: {
    inApk: string;
    outApk: string;
    keystore: string;
    ksAlias: string;
    ksCredentialId: string;
    keyCredentialId: string;
  },
  deps: AndroidDevelopmentDeps,
  ctx: ServerContext,
) {
  const owner = requireOwner(deps);
  if ("error" in owner) return owner.error;
  const resolved = await resolveToolchainOrError(deps);
  if ("error" in resolved) return resolved.error;

  let plan;
  try {
    plan = planApksignerSign(
      resolved.toolchain,
      {
        inApk: args.inApk,
        outApk: args.outApk,
        keystore: args.keystore,
        ksAlias: args.ksAlias,
        ksCredentialId: args.ksCredentialId,
        keyCredentialId: args.keyCredentialId,
      },
      {
        authorizeHostPath: (p) => hasAccess(deps, owner.userId, p),
        credentialStore: deps.credentialStore,
      },
    );
  } catch (err) {
    const message = (err as Error).message;
    if (message.includes("host path")) {
      return toolError("ANDROID_HOST_PATH_DENIED", message);
    }
    if (message.includes("credential")) {
      return toolError("ANDROID_CREDENTIAL_UNKNOWN", message);
    }
    return toolError("INVALID_ARGUMENT", message);
  }

  const approval = await requestApproval(ctx, {
    tool: "android_development",
    userId: owner.userId,
    subject: { kind: "credential", key: args.outApk, display: "apksigner sign" },
    argsDigest: digestArguments(args),
    reasons: ["Sign an APK with a local keystore credential."],
    decisionMode: "single_use",
  });
  if (approval !== true) return approval;

  const launch: DevelopmentLaunchSpec = {
    executable: plan.signPlan.executable,
    args: plan.signPlan.args,
    cwd: process.cwd(),
    env: {},
    timeoutMs: deps.taskTimeoutMs ?? DEV_TASK_MAX_RUNTIME_MS,
    successExitCodes: [0],
    secretEnvRefs: plan.secretEnvRefs,
    artifactRoots: [path.dirname(plan.outApk)],
  };
  const enqueued = enqueue(deps, owner.userId, "sign", "default", [args.outApk], launch);
  if ("error" in enqueued) return enqueued.error;
  return toolJson(enqueued);
}

async function verifyAction(
  args: { inApk: string },
  deps: AndroidDevelopmentDeps,
  ctx: ServerContext,
) {
  const owner = requireOwner(deps);
  if ("error" in owner) return owner.error;
  const resolved = await resolveToolchainOrError(deps);
  if ("error" in resolved) return resolved.error;

  let plan;
  try {
    plan = planApksignerVerify(resolved.toolchain, args, {
      authorizeHostPath: (p) => hasAccess(deps, owner.userId, p),
    });
  } catch (err) {
    const message = (err as Error).message;
    if (message.includes("host path")) {
      return toolError("ANDROID_HOST_PATH_DENIED", message);
    }
    return toolError("INVALID_ARGUMENT", message);
  }

  const approval = await requestApproval(ctx, {
    tool: "android_development",
    userId: owner.userId,
    subject: { kind: "credential", key: args.inApk, display: "apksigner verify" },
    argsDigest: digestArguments(args),
    reasons: ["Verify an APK signature."],
    decisionMode: "single_use",
  });
  if (approval !== true) return approval;

  const launch: DevelopmentLaunchSpec = {
    executable: plan.executable,
    args: plan.args,
    cwd: process.cwd(),
    env: {},
    timeoutMs: deps.taskTimeoutMs ?? DEV_TASK_MAX_RUNTIME_MS,
    successExitCodes: [0],
  };
  const enqueued = enqueue(deps, owner.userId, "verify", "default", [args.inApk], launch);
  if ("error" in enqueued) return enqueued.error;
  return toolJson(enqueued);
}

// ------------------------------------------------------------- dispatch ---

export async function androidDevelopment(
  args: unknown,
  deps: AndroidDevelopmentDeps,
  ctx: ServerContext,
) {
  const parsed = androidDevelopmentInputSchema.parse(args);
  switch (parsed.action) {
    case "inspect_project":
      return inspectProject(parsed, deps);
    case "list_templates":
      return listTemplates(deps);
    case "list_devices":
      return listDevices(deps);
    case "list_avds":
      return listAvds(deps);
    case "build":
    case "bundle":
    case "test_unit":
    case "test_instrumented":
    case "clean":
      return gradleAction(parsed, deps, ctx);
    case "install":
    case "uninstall":
    case "clear":
    case "start_app":
    case "force_stop":
    case "screenshot":
    case "logcat":
    case "diagnostic":
    case "push":
    case "pull":
    case "forward":
      return deviceAction(
        parsed as Record<string, unknown>,
        deps,
        ctx,
        parsed.action,
        "default",
        [String((parsed as { serial?: string }).serial ?? "")],
      );
    case "emulator_start":
      return emulatorAction(
        parsed as Record<string, unknown>,
        deps,
        ctx,
        "emulator_start",
        (tc) => planEmulatorStart(tc, { avdName: parsed.avdName, port: parsed.port }),
        parsed.avdName,
        `emulator start ${parsed.avdName}`,
      );
    case "emulator_stop":
      return emulatorAction(
        parsed as Record<string, unknown>,
        deps,
        ctx,
        "emulator_stop",
        (tc) => planEmulatorStop(tc, { serial: parsed.serial }),
        parsed.serial,
        `emulator stop ${parsed.serial}`,
      );
    case "avd_create":
      return emulatorAction(
        parsed as Record<string, unknown>,
        deps,
        ctx,
        "avd_create",
        (tc) => planAvdCreate(tc, { avdName: parsed.avdName, packageId: parsed.packageId, device: parsed.device }),
        parsed.avdName,
        `avd create ${parsed.avdName}`,
      );
    case "sign":
      return signAction(parsed, deps, ctx);
    case "verify":
      return verifyAction(parsed, deps, ctx);
  }
}

// ----------------------------------------------------------- registration ---

export function registerAndroidDevelopmentTool(
  server: McpServer,
  deps: AndroidDevelopmentDeps,
): void {
  server.registerTool(
    "android_development",
    {
      description:
        "Owner-only Android development adapter. Inspects projects, " +
        "enumerates templates and devices, and runs Gradle build/test, " +
        "device lifecycle, transfer, forwarding, diagnostic, emulator/AVD, " +
        "and signing operations. Every binary is resolved from the trusted " +
        "environment; no caller-supplied executable, SDK path, Gradle task, " +
        "emulator flag, URL, or argument is accepted. Long operations " +
        "enqueue a background task and return a task id.",
      inputSchema: androidDevelopmentInputSchema,
    },
    async (args, ctx) =>
      authorizeOwnerToolCall("android_development", args) ??
      runTool(
        {
          name: "android_development",
          concurrency: "default",
          subject: { kind: "development", key: "android", display: "android development" },
        },
        async () => androidDevelopment(args, deps, ctx),
      ),
  );
}

// Re-exports for tests and downstream adapters.
export {
  AdbCommandInput,
  GradleCommandInput,
  EmulatorCommandInput,
  AvdmanagerCommandInput,
  ApksignerCommandInput,
  collectArtifacts,
  GRADLE_ACTIONS,
};
