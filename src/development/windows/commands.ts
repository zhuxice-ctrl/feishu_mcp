/**
 * Pure Windows command builders.
 *
 * Each builder takes a resolved {@link WindowsToolchain} and a validated
 * action, and returns a fixed `{ executable, args, stdin? }` triple. Builders
 * are pure: they never read `process.env`, never touch the filesystem, and
 * never concatenate a shell string. Every eventual execution path uses
 * `shell: false`.
 */

import path from "node:path";
import type { WindowsToolchain } from "./toolchain.js";
import {
  DotnetCommandInput,
  MsbuildCommandInput,
  NativeCommandInput,
  ElectronCommandInput,
  SignCommandInput,
  type BuiltCommand,
  type DotnetCommand,
  type MsbuildCommand,
  type NativeCommand,
  type ElectronCommand,
  type SignCommand,
} from "./types.js";

function parse<T>(schema: { parse: (v: unknown) => T }, input: unknown): T {
  return schema.parse(input);
}

// --------------------------------------------------------------- dotnet -----

/**
 * Build a `dotnet` command. `restore` maps to `restore --locked-mode` when a
 * lock exists; `generate_dependency_lock` maps to `restore --use-lock-file`.
 * A caller cannot supply MSBuild properties or switches.
 */
export function buildDotnetCommand(
  toolchain: WindowsToolchain,
  raw: unknown,
): BuiltCommand {
  const input = parse(DotnetCommandInput, raw) as DotnetCommand;
  const dotnet = toolchain.dotnet;
  switch (input.action) {
    case "restore":
      return {
        executable: dotnet,
        args: input.lockedMode
          ? ["restore", input.projectOrSolution, "--locked-mode"]
          : ["restore", input.projectOrSolution],
      };
    case "build":
      return {
        executable: dotnet,
        args: buildDotnetBuildLike("build", input, ["--no-restore"]),
      };
    case "test":
      return {
        executable: dotnet,
        args: [
          "test", input.projectOrSolution,
          "--no-build", "--logger", "trx",
          ...configFrameworkArgs(input as { configuration?: string; framework?: string }),
        ],
      };
    case "publish":
      return {
        executable: dotnet,
        args: [
          "publish", input.projectOrSolution,
          "--no-build",
          ...configFrameworkArgs(input as { configuration?: string; framework?: string }),
          ...(input.runtime ? ["--runtime", input.runtime] : []),
        ],
      };
    case "pack":
      return {
        executable: dotnet,
        args: [
          "pack", input.projectOrSolution,
          "--no-build",
          ...configFrameworkArgs(input as { configuration?: string; framework?: string }),
        ],
      };
    case "generate_dependency_lock":
      return {
        executable: dotnet,
        args: ["restore", input.projectOrSolution, "--use-lock-file"],
      };
  }
}

function configFrameworkArgs(input: { configuration?: string; framework?: string }): string[] {
  const out: string[] = [];
  if (input.configuration) out.push("--configuration", input.configuration);
  if (input.framework) out.push("--framework", input.framework);
  return out;
}

function buildDotnetBuildLike(
  verb: string,
  input: DotnetCommand,
  extra: string[],
): string[] {
  return [
    verb, input.projectOrSolution,
    ...extra,
    ...configFrameworkArgs(input as { configuration?: string; framework?: string }),
  ];
}

// --------------------------------------------------------------- msbuild ----

/** Adapter-owned MSBuild flag set; no arbitrary property passthrough. */
export function buildMsbuildCommand(
  toolchain: WindowsToolchain,
  raw: unknown,
): BuiltCommand {
  const input = parse(MsbuildCommandInput, raw) as MsbuildCommand;
  const msbuild = toolchain.msbuild;
  const args = [
    input.solutionOrProject,
    "/nologo",
    `/m:${input.maxCpuCount}`,
    `/t:${input.target}`,
    `/p:Configuration=${input.configuration}`,
    `/p:Platform=${input.platform}`,
  ];
  return { executable: msbuild, args };
}

// --------------------------------------------------------------- native -----

/** Fixed CMake/Ninja/CTest command builder. */
export function buildNativeCommand(
  toolchain: WindowsToolchain,
  raw: unknown,
): BuiltCommand {
  const input = parse(NativeCommandInput, raw) as NativeCommand;
  switch (input.action) {
    case "configure": {
      if (input.preset) {
        return {
          executable: toolchain.cmake,
          args: ["--preset", input.preset, "-S", input.sourceDir, "-B", input.buildDir],
        };
      }
      const generator = input.preset?.startsWith("ninja") ? "Ninja" : "Visual Studio 17 2022";
      const configArgs = input.configuration
        ? [`-DCMAKE_BUILD_TYPE=${input.configuration}`]
        : [];
      return {
        executable: toolchain.cmake,
        args: ["-S", input.sourceDir, "-B", input.buildDir, "-G", generator, ...configArgs],
      };
    }
    case "build":
      return {
        executable: toolchain.cmake,
        args: [
          "--build", input.buildDir,
          "--config", input.configuration,
          "--target", input.target,
        ],
      };
    case "test":
      return {
        executable: toolchain.cmake,
        args: ["--build", input.buildDir, "--target", "test", "--config", input.configuration],
      };
    case "install":
      return {
        executable: toolchain.cmake,
        args: [
          "--install", input.buildDir,
          "--config", input.configuration,
          "--prefix", input.prefix,
        ],
      };
    case "package":
      return {
        executable: path.join(path.dirname(toolchain.cmake), "cpack"),
        args: ["--config", path.join(input.buildDir, "CPackConfig.cmake"), "-C", input.configuration],
      };
  }
}

// ------------------------------------------------------------- electron -----

/** Fixed package-manager (frozen install / run script) command builder. */
export function buildElectronCommand(
  toolchain: WindowsToolchain,
  raw: unknown,
): BuiltCommand {
  const input = parse(ElectronCommandInput, raw) as ElectronCommand;
  const pm = packageManagerExecutable(toolchain, input.packageManager);
  switch (input.action) {
    case "install":
      return { executable: pm.executable, args: pm.frozenInstallArgs };
    case "run_script":
      return { executable: pm.executable, args: ["run", input.scriptName] };
    case "test":
      return { executable: pm.executable, args: ["run", input.scriptName] };
    case "package":
      return { executable: pm.executable, args: ["run", input.scriptName] };
  }
}

interface PackageManagerExecutable {
  executable: string;
  frozenInstallArgs: string[];
}

function packageManagerExecutable(
  toolchain: WindowsToolchain,
  manager: string,
): PackageManagerExecutable {
  const m = (manager === "pnpm" || manager === "yarn") ? manager : "npm";
  switch (m) {
    case "npm":
      return { executable: toolchain.npm, frozenInstallArgs: ["ci"] };
    case "pnpm":
      return {
        executable: path.join(path.dirname(toolchain.npm), "pnpm.cmd"),
        frozenInstallArgs: ["install", "--frozen-lockfile"],
      };
    case "yarn":
      return {
        executable: path.join(path.dirname(toolchain.npm), "yarn.cmd"),
        frozenInstallArgs: ["install", "--immutable"],
      };
  }
}

// --------------------------------------------------------------- signing ----

/** Fixed SignTool command builder. No password on the command line. */
export function buildSignCommand(
  toolchain: WindowsToolchain,
  raw: unknown,
): BuiltCommand {
  const input = parse(SignCommandInput, raw) as SignCommand;
  switch (input.action) {
    case "sign":
      return {
        executable: toolchain.signtool,
        args: [
          "sign",
          "/fd", "sha256",
          "/td", "sha256",
          "/tr", input.timestampOrigin,
          "/csp", "Microsoft Enhanced RSA and AES Cryptographic Provider",
          "/kc", input.credentialId,
          "/f", input.inFile,
          "/o", input.outFile,
        ],
      };
    case "verify":
      return {
        executable: toolchain.signtool,
        args: ["verify", "/pa", "/all", input.inFile],
      };
  }
}
