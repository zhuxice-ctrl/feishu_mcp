/**
 * Strict type contracts and validation schemas for the Windows development
 * adapter.
 *
 * Every action input the MCP layer accepts is validated by a strict Zod schema
 * before it reaches a command builder. Schemas reject unknown fields (no
 * passthrough of arbitrary flags), reject shell metacharacters in identifiers,
 * and constrain free-form values to a closed enum where possible. Command
 * builders consume the validated, narrowed types and never touch `process.env`
 * or the filesystem.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Identifier validators
// ---------------------------------------------------------------------------

/**
 * Project name: conservative charset, bounded length. No shell metacharacters,
 * no whitespace, no path separators.
 */
export const PROJECT_NAME_REGEX = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/**
 * .NET short template name as accepted by `dotnet new`, e.g. `console`,
 * `classlib`, `xunit`. Lowercase, hyphen-separated.
 */
export const DOTNET_TEMPLATE_SHORT_NAME_REGEX = /^[a-z][a-z0-9-]{0,63}$/;

/** .NET target framework moniker, e.g. `net8.0`, `net6.0`. */
export const TFM_REGEX = /^net[0-9]+\.[0-9]+$/;

/** MSBuild configuration enum. */
export const MSBUILD_CONFIG_REGEX = /^(Debug|Release)$/;

/** MSBuild platform enum. */
export const MSBUILD_PLATFORM_REGEX = /^(AnyCPU|x64|x86|ARM64)$/;

/** CMake configuration enum. */
export const CMAKE_CONFIG_REGEX = /^(Debug|Release|RelWithDebInfo|MinSizeRel)$/;

/** C++ standard enum. */
export const CPP_STANDARD_REGEX = /^(11|14|17|20|23)$/;

/** CMake preset name allowlist. */
export const CMAKE_PRESET_REGEX = /^(msvc-debug|msvc-release|ninja-debug|ninja-release)$/;

/** MSBuild fixed target allowlist. */
export const MSBUILD_TARGET_REGEX = /^(Restore|Build|Rebuild|Clean|Test)$/;

/** npm package script name: conservative charset, no shell metacharacters. */
export const SCRIPT_NAME_REGEX = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;

/** Package manager enum derived from lockfile. */
export const PACKAGE_MANAGER_REGEX = /^(npm|pnpm|yarn)$/;

/** Certificate thumbprint: 40 hex chars (SHA-1). */
export const CERT_THUMBPRINT_REGEX = /^[0-9a-fA-F]{40}$/;

/** Timestamp origin allowlist (RFC 3161). */
export const TIMESTAMP_ORIGIN_REGEX =
  /^http:\/\/timestamp\.digicert\.com$|^http:\/\/rfc3161\.timestamp\.sectigo\.com$|^http:\/\/timestamp\.globalsign\.com$/;

/** VS instance id: conservative charset. */
export const VS_INSTANCE_ID_REGEX = /^[a-f0-9]{16,64}$/;

/**
 * Package id: dot-separated identifiers, e.g. `com.example.app`. Reused by the
 * Electron provider for the application package id.
 */
export const PACKAGE_ID_REGEX =
  /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;

const hostPath = z.string().min(1).max(4096);

const projectName = z
  .string()
  .min(1)
  .max(64)
  .regex(PROJECT_NAME_REGEX, "invalid project name");

const dotnetTemplateShortName = z
  .string()
  .min(1)
  .max(64)
  .regex(DOTNET_TEMPLATE_SHORT_NAME_REGEX, "invalid dotnet template short name");

const tfm = z.string().min(1).max(16).regex(TFM_REGEX, "invalid target framework");

const msbuildConfig = z
  .string()
  .min(1)
  .max(32)
  .regex(MSBUILD_CONFIG_REGEX, "invalid msbuild configuration");

const msbuildPlatform = z
  .string()
  .min(1)
  .max(32)
  .regex(MSBUILD_PLATFORM_REGEX, "invalid msbuild platform");

const msbuildTarget = z
  .string()
  .min(1)
  .max(32)
  .regex(MSBUILD_TARGET_REGEX, "invalid msbuild target");

const cmakeConfig = z
  .string()
  .min(1)
  .max(32)
  .regex(CMAKE_CONFIG_REGEX, "invalid cmake configuration");

const cppStandard = z
  .string()
  .min(1)
  .max(8)
  .regex(CPP_STANDARD_REGEX, "invalid c++ standard");

const cmakePreset = z
  .string()
  .min(1)
  .max(64)
  .regex(CMAKE_PRESET_REGEX, "invalid cmake preset");

const scriptName = z
  .string()
  .min(1)
  .max(128)
  .regex(SCRIPT_NAME_REGEX, "invalid script name");

const packageManager = z
  .string()
  .min(1)
  .max(16)
  .regex(PACKAGE_MANAGER_REGEX, "invalid package manager");

const certThumbprint = z
  .string()
  .min(1)
  .max(40)
  .regex(CERT_THUMBPRINT_REGEX, "invalid certificate thumbprint");

const timestampOrigin = z
  .string()
  .min(1)
  .max(256)
  .regex(TIMESTAMP_ORIGIN_REGEX, "invalid timestamp origin");

const credentialId = z.string().uuid();

const pid = z.number().int().min(1).max(2147483647);

// ---------------------------------------------------------------------------
// Action enums
// ---------------------------------------------------------------------------

export const DotnetAction = z.enum([
  "restore",
  "build",
  "test",
  "publish",
  "pack",
  "generate_dependency_lock",
]);
export const MsbuildAction = z.enum(["restore", "build", "rebuild", "clean", "test"]);
export const NativeAction = z.enum([
  "configure",
  "build",
  "test",
  "install",
  "package",
]);
export const ElectronAction = z.enum([
  "install",
  "run_script",
  "test",
  "package",
]);
export const SignAction = z.enum(["sign", "verify"]);

// ---------------------------------------------------------------------------
// Action schemas
// ---------------------------------------------------------------------------

/** .NET command input. */
export const DotnetCommandInput = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("restore"),
      projectOrSolution: hostPath,
      lockedMode: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      action: z.literal("build"),
      projectOrSolution: hostPath,
      configuration: msbuildConfig,
      framework: tfm.optional(),
      noRestore: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      action: z.literal("test"),
      projectOrSolution: hostPath,
      configuration: msbuildConfig,
      framework: tfm.optional(),
      noBuild: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      action: z.literal("publish"),
      projectOrSolution: hostPath,
      configuration: msbuildConfig,
      framework: tfm.optional(),
      runtime: z
        .string()
        .min(1)
        .max(32)
        .regex(/^[a-z0-9-]+$/, "invalid runtime identifier")
        .optional(),
      noBuild: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      action: z.literal("pack"),
      projectOrSolution: hostPath,
      configuration: msbuildConfig,
      noBuild: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      action: z.literal("generate_dependency_lock"),
      projectOrSolution: hostPath,
    })
    .strict(),
]);

/** MSBuild command input. */
export const MsbuildCommandInput = z
  .object({
    action: MsbuildAction,
    solutionOrProject: hostPath,
    target: msbuildTarget,
    configuration: msbuildConfig,
    platform: msbuildPlatform,
    maxCpuCount: z.number().int().min(1).max(64).default(4),
  })
  .strict();

/** Native (CMake/Ninja/CTest) command input. */
export const NativeCommandInput = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("configure"),
      sourceDir: hostPath,
      buildDir: hostPath,
      preset: cmakePreset.optional(),
      configuration: cmakeConfig.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("build"),
      buildDir: hostPath,
      target: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[A-Za-z][A-Za-z0-9_-]*$/, "invalid build target"),
      configuration: cmakeConfig,
    })
    .strict(),
  z
    .object({
      action: z.literal("test"),
      buildDir: hostPath,
      configuration: cmakeConfig,
    })
    .strict(),
  z
    .object({
      action: z.literal("install"),
      buildDir: hostPath,
      configuration: cmakeConfig,
      prefix: hostPath,
    })
    .strict(),
  z
    .object({
      action: z.literal("package"),
      buildDir: hostPath,
      configuration: cmakeConfig,
    })
    .strict(),
]);

/** Electron (package manager) command input. */
export const ElectronCommandInput = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("install"),
      projectDir: hostPath,
      packageManager,
    })
    .strict(),
  z
    .object({
      action: z.literal("run_script"),
      projectDir: hostPath,
      packageManager,
      scriptName,
    })
    .strict(),
  z
    .object({
      action: z.literal("test"),
      projectDir: hostPath,
      packageManager,
      scriptName,
    })
    .strict(),
  z
    .object({
      action: z.literal("package"),
      projectDir: hostPath,
      packageManager,
      scriptName,
    })
    .strict(),
]);

/** Sign command input. */
export const SignCommandInput = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("sign"),
      inFile: hostPath,
      outFile: hostPath,
      credentialId,
      timestampOrigin,
    })
    .strict(),
  z
    .object({
      action: z.literal("verify"),
      inFile: hostPath,
    })
    .strict(),
]);

// ---------------------------------------------------------------------------
// Output contract
// ---------------------------------------------------------------------------

export interface BuiltCommand {
  executable: string;
  args: string[];
  stdin?: string;
}

export type DotnetCommand = z.infer<typeof DotnetCommandInput>;
export type MsbuildCommand = z.infer<typeof MsbuildCommandInput>;
export type NativeCommand = z.infer<typeof NativeCommandInput>;
export type ElectronCommand = z.infer<typeof ElectronCommandInput>;
export type SignCommand = z.infer<typeof SignCommandInput>;
