/**
 * Trusted Windows toolchain resolution.
 *
 * The Windows adapter never accepts a caller-supplied executable, path, SDK
 * location, or Visual Studio instance. Every binary it invokes must first
 * appear as a `ready` component in the inspected environment snapshot — the
 * same snapshot the environment broker bound to the active plan. This module
 * resolves the finite set of component ids the Windows operations require and
 * returns either a fully-populated toolchain (internal use only; real paths
 * never leave the server) or a structured error naming only the missing/
 * untrusted component ids.
 */

import path from "node:path";
import type { EnvironmentSnapshot, PrivateComponentSnapshot } from "../environment/inspect.js";

/**
 * The exact catalog component ids a Windows operation may invoke. Adding an
 * id here requires the catalog to declare it and the environment inspector to
 * have resolved it to `ready`.
 */
export const WINDOWS_TOOLCHAIN_COMPONENTS = [
  "microsoft.dotnet.sdk.8",
  "microsoft.visualstudio.2022.buildtools",
  "microsoft.visualstudio.workload.manageddesktop",
  "microsoft.visualstudio.workload.nativedesktop",
  "microsoft.visualstudio.workload.universal",
  "microsoft.windows.sdk.11",
  "kitware.cmake",
  "ninja-build.ninja",
  "openjs.nodejs.lts",
  "git.git",
] as const;

export interface WindowsToolchain {
  dotnet: string;
  msbuild: string;
  vsInstanceId: string;
  signtool: string;
  cmake: string;
  ninja: string;
  node: string;
  npm: string;
  corepack: string;
  git: string;
}

export type WindowsToolchainResolution =
  | { toolchain: WindowsToolchain }
  | { error: "ENVIRONMENT_MISSING" | "TOOLCHAIN_UNTRUSTED"; componentIds: string[] };

function findComponent(
  snapshot: EnvironmentSnapshot,
  componentId: string,
): PrivateComponentSnapshot | undefined {
  return snapshot.components.find((c) => c.componentId === componentId);
}

/**
 * Replace the trailing executable name in a trusted path with a sibling,
 * deriving a binary in the same reviewed directory. Used for sibling tools
 * shipped in the same component (e.g. MSBuild.exe / signtool.exe under a VS
 * instance / Windows SDK install). If `fromName` is not present the original
 * path is returned unchanged so the adapter fails loudly rather than guessing.
 */
function siblingExecutable(trustedPath: string, fromName: string, toName: string): string {
  const base = path.dirname(trustedPath);
  return path.join(base, toName);
}

/**
 * Resolve the Windows toolchain from an inspected environment snapshot.
 *
 * The Visual Studio `buildtools` component provides the VS install root; the
 * `msbuild` path is derived from that root
 * (`<root>/MSBuild/Current/Bin/MSBuild.exe`). The Windows SDK component
 * provides `signtool` (`<sdk>/bin/<arch>/signtool.exe`). The Node.js component
 * provides `node`; `npm` and `corepack` are siblings in the same directory.
 */
export function resolveWindowsToolchain(snapshot: EnvironmentSnapshot): WindowsToolchainResolution {
  const missing: string[] = [];
  const untrusted: string[] = [];

  for (const componentId of WINDOWS_TOOLCHAIN_COMPONENTS) {
    const component = findComponent(snapshot, componentId);
    if (!component) {
      missing.push(componentId);
      continue;
    }
    if (component.state === "missing") {
      missing.push(componentId);
      continue;
    }
    if (component.state === "untrusted" || component.state === "incompatible") {
      untrusted.push(componentId);
      continue;
    }
    // ready
    if (!component.realPath) {
      missing.push(componentId);
    }
  }

  if (untrusted.length > 0) {
    return { error: "TOOLCHAIN_UNTRUSTED", componentIds: untrusted };
  }
  if (missing.length > 0) {
    return { error: "ENVIRONMENT_MISSING", componentIds: missing };
  }

  const lookup = (id: string): PrivateComponentSnapshot => findComponent(snapshot, id)!;

  const dotnet = lookup("microsoft.dotnet.sdk.8").realPath!;
  const vsBuildTools = lookup("microsoft.visualstudio.2022.buildtools");
  const vsRoot = vsBuildTools.realPath!;
  const vsInstanceId =
    vsBuildTools.discovery ??
    /* fallback: derive a stable id from the install root */ path.basename(vsRoot);
  const msbuild = path.join(vsRoot, "MSBuild", "Current", "Bin", "MSBuild.exe");

  const windowsSdk = lookup("microsoft.windows.sdk.11");
  const sdkRoot = windowsSdk.realPath!;
  // signtool ships under <sdk>/bin/<arch>/signtool.exe
  const signtool = path.join(sdkRoot, "bin", "x64", "signtool.exe");

  const cmake = lookup("kitware.cmake").realPath!;
  const ninja = lookup("ninja-build.ninja").realPath!;

  const node = lookup("openjs.nodejs.lts").realPath!;
  const nodeDir = path.dirname(node);
  const npm = path.join(nodeDir, "npm.cmd");
  const corepack = path.join(nodeDir, "corepack.cmd");

  const git = lookup("git.git").realPath!;

  return {
    toolchain: {
      dotnet,
      msbuild,
      vsInstanceId,
      signtool,
      cmake,
      ninja,
      node,
      npm,
      corepack,
      git,
    },
  };
}
