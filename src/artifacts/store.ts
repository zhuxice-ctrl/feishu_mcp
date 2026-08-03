import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { BINARY_ARTIFACT_DATA_DIR } from "../config.js";
import { artifactId, parseSha256, sha256File } from "./digest.js";
import { validateArtifactType } from "./signatures.js";
import type { ArtifactClass, ArtifactId, ArtifactMetadata, ArtifactSourceKind, UploadSession } from "./types.js";

export type ArtifactStoreErrorCode =
  | "BINARY_ARTIFACT_NOT_FOUND"
  | "BINARY_ARTIFACT_SIZE_MISMATCH"
  | "BINARY_ARTIFACT_DIGEST_MISMATCH"
  | "BINARY_ARTIFACT_TYPE_MISMATCH"
  | "BINARY_ARTIFACT_STORE_FAILED";

export class ArtifactStoreError extends Error {
  constructor(readonly code: ArtifactStoreErrorCode, message: string) {
    super(message);
    this.name = "ArtifactStoreError";
  }
}

export interface PromoteStagingRequest {
  sessionId: string;
  displayName: string;
  declaredMediaType: string;
  expectedSize: number;
  expectedSha256: string | null;
  class: ArtifactClass;
  source: ArtifactSourceKind;
  urlOriginDigest?: string;
}

export interface ArtifactCommitResult {
  artifact: ArtifactId;
  sha256: string;
  size: number;
  displayName: string;
  declaredMediaType: string;
  detectedMediaType: string | null;
  class: ArtifactClass;
}

function noFollowReadFlags(): number {
  return fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
}

function isSafeSessionId(value: string): boolean {
  return /^[a-zA-Z0-9-]{1,128}$/.test(value);
}

export class BinaryArtifactStore {
  readonly dataDir: string;

  constructor(options: { dataDir?: string } = {}) {
    this.dataDir = path.resolve(options.dataDir ?? BINARY_ARTIFACT_DATA_DIR);
  }

  createUploadStaging(sessionId: string): void {
    if (!isSafeSessionId(sessionId)) throw new ArtifactStoreError("BINARY_ARTIFACT_STORE_FAILED", "Invalid upload session.");
    const directory = this.uploadDirectory(sessionId);
    fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      throw new ArtifactStoreError("BINARY_ARTIFACT_STORE_FAILED", "Could not create artifact staging.");
    }
    try {
      const fd = fs.openSync(this.uploadContentPath(sessionId), "wx", 0o600);
      fs.closeSync(fd);
    } catch {
      this.removeOwnedUpload(sessionId);
      throw new ArtifactStoreError("BINARY_ARTIFACT_STORE_FAILED", "Could not create artifact staging.");
    }
  }

  promoteStaging(request: PromoteStagingRequest): ArtifactCommitResult {
    const staging = this.uploadContentPath(request.sessionId);
    let actual: { sha256: string; size: number };
    try {
      actual = sha256File(staging);
    } catch {
      throw new ArtifactStoreError("BINARY_ARTIFACT_STORE_FAILED", "Artifact staging could not be verified.");
    }
    if (actual.size !== request.expectedSize) {
      throw new ArtifactStoreError("BINARY_ARTIFACT_SIZE_MISMATCH", "Artifact size does not match.");
    }
    if (request.expectedSha256 && actual.sha256 !== request.expectedSha256) {
      throw new ArtifactStoreError("BINARY_ARTIFACT_DIGEST_MISMATCH", "Artifact digest does not match.");
    }
    const fd = fs.openSync(staging, noFollowReadFlags());
    let prefix: Buffer;
    try {
      prefix = Buffer.alloc(32);
      const count = fs.readSync(fd, prefix, 0, prefix.length, 0);
      prefix = prefix.subarray(0, count);
    } finally {
      fs.closeSync(fd);
    }
    const type = validateArtifactType(request, prefix);
    if (!type.ok) throw new ArtifactStoreError(type.code, "Artifact type does not match.");
    const destination = this.objectDirectory(actual.sha256);
    const content = path.join(destination, "content");
    const metadataPath = path.join(destination, "metadata.json");
    const metadata: ArtifactMetadata = {
      version: 1,
      artifact: artifactId(actual.sha256),
      sha256: actual.sha256,
      size: actual.size,
      displayName: request.displayName,
      declaredMediaType: request.declaredMediaType,
      detectedMediaType: type.detectedMediaType,
      class: request.class,
      createdAt: new Date().toISOString(),
      source: request.source,
      ...(request.urlOriginDigest ? { urlOriginDigest: request.urlOriginDigest } : {}),
    };
    try {
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      try {
        fs.mkdirSync(destination, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = sha256File(content);
        if (existing.sha256 !== actual.sha256 || existing.size !== actual.size || !fs.existsSync(metadataPath)) {
          throw new ArtifactStoreError("BINARY_ARTIFACT_STORE_FAILED", "Stored artifact is corrupt.");
        }
        this.removeOwnedUpload(request.sessionId);
        return this.resultFromMetadata(this.readMetadata(metadataPath));
      }
      fs.renameSync(staging, content);
      this.syncFile(content);
      this.writeMetadata(metadataPath, metadata);
      this.removeOwnedUpload(request.sessionId);
      return this.resultFromMetadata(metadata);
    } catch (error) {
      if (error instanceof ArtifactStoreError) throw error;
      throw new ArtifactStoreError("BINARY_ARTIFACT_STORE_FAILED", "Artifact storage failed.");
    }
  }

  inspect(id: string): ArtifactMetadata | null {
    const digest = this.digestFromId(id);
    if (!digest) return null;
    try {
      const metadata = this.readMetadata(path.join(this.objectDirectory(digest), "metadata.json"));
      const actual = sha256File(path.join(this.objectDirectory(digest), "content"));
      return actual.sha256 === metadata.sha256 && actual.size === metadata.size ? metadata : null;
    } catch {
      return null;
    }
  }

  healthSummary(): { schemaVersion: 1; activeUploads: number; storedObjects: number } {
    return {
      schemaVersion: 1,
      activeUploads: this.directoryCount(path.join(this.dataDir, "uploads")),
      storedObjects: this.objectCount(),
    };
  }

  cleanupExpiredUploads(now = Date.now()): number {
    const root = path.join(this.dataDir, "uploads");
    let removed = 0;
    for (const entry of this.safeDirectories(root)) {
      const session = path.join(root, entry, "session.json");
      try {
        const value = JSON.parse(fs.readFileSync(session, "utf8")) as { expiresAt?: string };
        if (!value.expiresAt || Date.parse(value.expiresAt) > now) continue;
        fs.rmSync(path.join(root, entry), { recursive: true, force: true });
        removed += 1;
      } catch {
        // Leave malformed or active data for an explicit operator inspection.
      }
    }
    return removed;
  }

  appendUploadBytes(sessionId: string, bytes: Buffer): void {
    if (!isSafeSessionId(sessionId)) throw new ArtifactStoreError("BINARY_ARTIFACT_STORE_FAILED", "Invalid upload session.");
    const fd = fs.openSync(this.uploadContentPath(sessionId), "a", 0o600);
    try {
      fs.writeSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  readUploadSession(sessionId: string): UploadSession | null {
    if (!isSafeSessionId(sessionId)) return null;
    try {
      const value = JSON.parse(fs.readFileSync(this.uploadSessionPath(sessionId), "utf8")) as UploadSession;
      return value.version === 1 && value.id === sessionId ? value : null;
    } catch { return null; }
  }

  writeUploadSession(session: UploadSession): void {
    if (!isSafeSessionId(session.id)) throw new ArtifactStoreError("BINARY_ARTIFACT_STORE_FAILED", "Invalid upload session.");
    this.writeJsonAtomic(this.uploadSessionPath(session.id), session);
  }

  private uploadDirectory(sessionId: string): string {
    return path.join(this.dataDir, "uploads", sessionId);
  }

  private uploadContentPath(sessionId: string): string {
    return path.join(this.uploadDirectory(sessionId), "content.partial");
  }

  private uploadSessionPath(sessionId: string): string {
    return path.join(this.uploadDirectory(sessionId), "session.json");
  }

  private objectDirectory(digest: string): string {
    return path.join(this.dataDir, "objects", digest.slice(0, 2), digest);
  }

  private digestFromId(id: string): string | null {
    return id.startsWith("sha256:") ? parseSha256(id.slice(7)) : null;
  }

  private syncFile(file: string): void {
    const fd = fs.openSync(file, "r+");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }

  private writeMetadata(file: string, metadata: ArtifactMetadata): void {
    this.writeJsonAtomic(file, metadata);
  }

  private writeJsonAtomic(file: string, value: unknown): void {
    const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const fd = fs.openSync(temp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(value) + "\n", "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, file);
    this.syncFile(file);
  }

  private readMetadata(file: string): ArtifactMetadata {
    const fd = fs.openSync(file, noFollowReadFlags());
    try {
      const value = JSON.parse(fs.readFileSync(fd, "utf8")) as ArtifactMetadata;
      if (value.version !== 1 || !parseSha256(value.sha256) || value.artifact !== artifactId(value.sha256) ||
        !Number.isSafeInteger(value.size) || value.size < 0) throw new Error("Invalid metadata.");
      return value;
    } finally {
      fs.closeSync(fd);
    }
  }

  private resultFromMetadata(metadata: ArtifactMetadata): ArtifactCommitResult {
    return {
      artifact: metadata.artifact,
      sha256: metadata.sha256,
      size: metadata.size,
      displayName: metadata.displayName,
      declaredMediaType: metadata.declaredMediaType,
      detectedMediaType: metadata.detectedMediaType,
      class: metadata.class,
    };
  }

  private removeOwnedUpload(sessionId: string): void {
    try { fs.rmSync(this.uploadDirectory(sessionId), { recursive: true, force: true }); } catch {}
  }

  private safeDirectories(root: string): string[] {
    try {
      return fs.readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && isSafeSessionId(entry.name))
        .map((entry) => entry.name);
    } catch { return []; }
  }

  private directoryCount(root: string): number {
    return this.safeDirectories(root).length;
  }

  private objectCount(): number {
    let count = 0;
    for (const prefix of this.safeDirectories(path.join(this.dataDir, "objects"))) {
      count += this.safeDirectories(path.join(this.dataDir, "objects", prefix)).length;
    }
    return count;
  }
}
