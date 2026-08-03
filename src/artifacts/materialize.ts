import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CanonicalDirectoryRoot } from "../security/directoryRoots.js";
import { isInsideDirectory } from "../security/directoryRoots.js";
import { moveToTrash } from "../security/trash.js";
import { BinaryArtifactStore, ArtifactStoreError } from "./store.js";
import type { ArtifactId } from "./types.js";

export interface MaterializeResult {
  artifact: ArtifactId;
  target: string;
  replaced: boolean;
}

function rootFor(target: string, roots: readonly CanonicalDirectoryRoot[]): CanonicalDirectoryRoot | null {
  return roots.find((root) => isInsideDirectory(target, root.logicalRoot) && isInsideDirectory(target, root.physicalRoot)) ?? null;
}

function safeTarget(target: string, root: CanonicalDirectoryRoot): boolean {
  const parent = path.dirname(target);
  if (!fs.existsSync(parent) || !fs.lstatSync(parent).isDirectory()) return false;
  let cursor = root.logicalRoot;
  for (const part of path.relative(root.logicalRoot, parent).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (fs.lstatSync(cursor).isSymbolicLink()) return false;
  }
  try { return !fs.lstatSync(target).isSymbolicLink(); } catch { return true; }
}

export function materializeArtifact(request: {
  store: BinaryArtifactStore;
  artifact: ArtifactId;
  target: string;
  authorizedRoots: readonly CanonicalDirectoryRoot[];
  overwrite: "refuse" | "replace_with_backup";
}): MaterializeResult {
  const target = path.resolve(request.target);
  const root = rootFor(target, request.authorizedRoots);
  if (!root || !safeTarget(target, root)) throw new ArtifactStoreError("BINARY_ARTIFACT_STORE_FAILED", "Artifact destination is denied.");
  const exists = fs.existsSync(target);
  if (exists && request.overwrite === "refuse") throw new ArtifactStoreError("BINARY_ARTIFACT_STORE_FAILED", "Artifact destination exists.");
  const temp = `${target}.${process.pid}.${crypto.randomUUID()}.artifact.tmp`;
  try {
    const metadata = request.store.copyArtifactTo(request.artifact, temp);
    if (exists) {
      const backup = moveToTrash(target);
      if (!backup) throw new Error("Existing file could not be backed up.");
    }
    fs.renameSync(temp, target);
    return { artifact: metadata.artifact, target, replaced: exists };
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch {}
    if (error instanceof ArtifactStoreError) throw error;
    throw new ArtifactStoreError("BINARY_ARTIFACT_STORE_FAILED", "Artifact materialization failed.");
  }
}
