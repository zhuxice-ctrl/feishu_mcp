import path from "node:path";
import { isInternalApprovalPath } from "./approvalStore.js";
import {
  directoryGrantStore,
  type DirectoryGrantStore,
  type EffectiveRoot,
  type EffectiveRootSource,
} from "./directoryGrantStore.js";
import {
  isInsideDirectory,
  resolveThroughExistingAncestor,
  type CanonicalDirectoryRoot,
} from "./directoryRoots.js";
import { getRequestUserId } from "./requestContext.js";

export interface PathValidationResult {
  ok: boolean;
  resolvedPath?: string;
  error?: string;
}

export interface AllowedPathInspection {
  status: "allowed";
  logicalPath: string;
  physicalPath: string;
  matchedRoot: Omit<EffectiveRoot, "source"> & { source: EffectiveRootSource | "allow_once" };
}

export interface OutsidePathInspection {
  status: "outside";
  logicalPath: string;
  physicalPath: string;
}

export interface DeniedPathInspection {
  status: "denied";
  code: "SENSITIVE_PATH" | "OUTSIDE_ALLOWED_DIRS";
  message: string;
}

export type PathBoundaryInspection =
  | AllowedPathInspection
  | OutsidePathInspection
  | DeniedPathInspection;

function inspect(
  inputPath: string,
  userId: string | null,
  store: DirectoryGrantStore,
  additionalRoots: CanonicalDirectoryRoot[],
): PathBoundaryInspection {
  const effective = store.effectiveRoots(userId);
  const logicalPath = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(effective[0]?.logicalRoot ?? process.cwd(), inputPath);

  if (isInternalApprovalPath(logicalPath)) {
    return {
      status: "denied",
      code: "SENSITIVE_PATH",
      message: "The internal approval directory is protected.",
    };
  }

  let physicalPath: string;
  try {
    physicalPath = resolveThroughExistingAncestor(logicalPath);
  } catch {
    return {
      status: "denied",
      code: "OUTSIDE_ALLOWED_DIRS",
      message: `Path "${inputPath}" could not be safely resolved.`,
    };
  }
  if (isInternalApprovalPath(physicalPath)) {
    return {
      status: "denied",
      code: "SENSITIVE_PATH",
      message: "The internal approval directory is protected.",
    };
  }

  const roots: Array<Omit<EffectiveRoot, "source"> & {
    source: EffectiveRootSource | "allow_once";
  }> = [
    ...effective,
    ...additionalRoots.map((root) => ({ ...root, source: "allow_once" as const })),
  ];
  const matchedRoot = roots.find((root) => isInsideDirectory(physicalPath, root.physicalRoot));
  if (matchedRoot) return { status: "allowed", logicalPath, physicalPath, matchedRoot };
  return { status: "outside", logicalPath, physicalPath };
}

export function inspectPathBoundary(
  inputPath: string,
  userId: string | null = getRequestUserId(),
  store: DirectoryGrantStore = directoryGrantStore,
): PathBoundaryInspection {
  return inspect(inputPath, userId, store, []);
}

export function inspectPathBoundaryWithAdditionalRoots(
  inputPath: string,
  additionalRoots: CanonicalDirectoryRoot[],
  userId: string | null = getRequestUserId(),
  store: DirectoryGrantStore = directoryGrantStore,
): PathBoundaryInspection {
  return inspect(inputPath, userId, store, additionalRoots);
}

export function validatePath(inputPath: string): PathValidationResult {
  const inspected = inspectPathBoundary(inputPath);
  if (inspected.status === "allowed") {
    return { ok: true, resolvedPath: inspected.physicalPath };
  }
  if (inspected.status === "denied") {
    return {
      ok: false,
      error: inspected.code === "SENSITIVE_PATH"
        ? `Path "${inputPath}" is an internal protected path.`
        : inspected.message,
    };
  }
  const logicalInside = directoryGrantStore.effectiveRoots(getRequestUserId())
    .some((root) => isInsideDirectory(inspected.logicalPath, root.logicalRoot));
  if (logicalInside) {
    return {
      ok: false,
      error: `Path "${inputPath}" resolves (via symlink) outside allowed directories.`,
    };
  }
  return { ok: false, error: `Path "${inputPath}" is outside all allowed directories.` };
}

export function getAllowedDirectories(): string[] {
  return directoryGrantStore.effectiveRoots(getRequestUserId()).map((root) => root.logicalRoot);
}
