import path from "node:path";
import { BINARY_ARTIFACT_MAX_BATCH } from "../config.js";
import { parseSha256 } from "./digest.js";
import type { ArtifactClass, ArtifactId } from "./types.js";

export interface ArtifactLockEntry {
  id: string;
  artifact: ArtifactId;
  size: number;
  mediaType: string;
  class: ArtifactClass;
  target: string;
}

export interface ArtifactLockManifest {
  version: 1;
  artifacts: ArtifactLockEntry[];
}

function fail(): never {
  throw new Error("Invalid artifact manifest.");
}

function classOf(value: unknown): ArtifactClass | null {
  return value === "project_asset" || value === "archive" || value === "executable" ? value : null;
}

function targetOf(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 1024 ||
    path.isAbsolute(value) || value.split(/[\\/]/).some((part) => part === ".." || !part)) fail();
  const normalized = value.replace(/\\/g, "/");
  if (normalized !== value || normalized.startsWith("/") || /^[a-z]:/i.test(normalized)) fail();
  return normalized;
}

export function parseArtifactLockManifest(value: unknown, maxBatch = BINARY_ARTIFACT_MAX_BATCH): ArtifactLockManifest {
  if (!value || typeof value !== "object") fail();
  const input = value as { version?: unknown; artifacts?: unknown };
  if (input.version !== 1 || !Array.isArray(input.artifacts) || input.artifacts.length > maxBatch) fail();
  const ids = new Set<string>();
  const targets = new Set<string>();
  const artifacts: ArtifactLockEntry[] = input.artifacts.map((raw) => {
    if (!raw || typeof raw !== "object") fail();
    const entry = raw as Partial<ArtifactLockEntry>;
    const digest = typeof entry.artifact === "string" && entry.artifact.startsWith("sha256:")
      ? parseSha256(entry.artifact.slice(7)) : null;
    const artifactClass = classOf(entry.class);
    const size = entry.size;
    const mediaType = entry.mediaType;
    if (typeof entry.id !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(entry.id) ||
      !digest || typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0 ||
      typeof mediaType !== "string" || !mediaType || mediaType.length > 128 ||
      !artifactClass) fail();
    const target = targetOf(entry.target);
    const targetKey = process.platform === "win32" ? target.toLowerCase() : target;
    if (ids.has(entry.id) || targets.has(targetKey)) fail();
    ids.add(entry.id);
    targets.add(targetKey);
    return { id: entry.id, artifact: `sha256:${digest}`, size, mediaType, class: artifactClass, target };
  });
  return { version: 1, artifacts };
}

export function serializeArtifactLockManifest(manifest: ArtifactLockManifest): string {
  const valid = parseArtifactLockManifest(manifest);
  return JSON.stringify({ version: 1, artifacts: [...valid.artifacts].sort((a, b) => a.id.localeCompare(b.id)) }, null, 2) + "\n";
}
