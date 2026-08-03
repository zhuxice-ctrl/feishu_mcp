import { randomUUID } from "node:crypto";
import {
  BINARY_ARTIFACT_CHUNK_BYTES,
  BINARY_ARTIFACT_MAX_BYTES,
  BINARY_ARTIFACT_MAX_UPLOADS,
  BINARY_ARTIFACT_UPLOAD_TTL_MS,
} from "../config.js";
import { decodedBase64Length, parseSha256 } from "./digest.js";
import { BinaryArtifactStore, type ArtifactCommitResult } from "./store.js";
import type { ArtifactClass, UploadSession } from "./types.js";

export type ArtifactUploadErrorCode =
  | "BINARY_ARTIFACT_UPLOAD_NOT_FOUND"
  | "BINARY_ARTIFACT_UPLOAD_EXPIRED"
  | "BINARY_ARTIFACT_UPLOAD_ORDER"
  | "BINARY_ARTIFACT_TOO_LARGE"
  | "BINARY_ARTIFACT_SIZE_MISMATCH"
  | "BINARY_ARTIFACT_DIGEST_MISMATCH"
  | "BINARY_ARTIFACT_TYPE_MISMATCH";

export class ArtifactUploadError extends Error {
  constructor(readonly code: ArtifactUploadErrorCode, message: string) {
    super(message);
    this.name = "ArtifactUploadError";
  }
}

export interface UploadBeginRequest {
  displayName: string;
  declaredMediaType: string;
  expectedSize: number;
  expectedSha256?: string;
  class: ArtifactClass;
}

export interface UploadBeginResult {
  sessionId: string;
  nextChunkIndex: number;
  chunkBytes: number;
  expiresAt: string;
}

export interface UploadChunkResult {
  nextChunkIndex: number;
  writtenBytes: number;
}

export interface UploadInspection {
  sessionId: string;
  nextChunkIndex: number;
  writtenBytes: number;
  expiresAt: string;
  committed: boolean;
}

export class ArtifactUploadService {
  private readonly chunkBytes: number;
  private readonly ttlMs: number;
  private readonly maxBytes: number;
  private readonly maxUploads: number;
  private readonly now: () => number;

  constructor(
    private readonly store: BinaryArtifactStore,
    options: {
      chunkBytes?: number; ttlMs?: number; maxBytes?: number;
      maxUploads?: number; now?: () => number;
    } = {},
  ) {
    this.chunkBytes = options.chunkBytes ?? BINARY_ARTIFACT_CHUNK_BYTES;
    this.ttlMs = options.ttlMs ?? BINARY_ARTIFACT_UPLOAD_TTL_MS;
    this.maxBytes = options.maxBytes ?? BINARY_ARTIFACT_MAX_BYTES;
    this.maxUploads = options.maxUploads ?? BINARY_ARTIFACT_MAX_UPLOADS;
    this.now = options.now ?? Date.now;
  }

  begin(userId: string, request: UploadBeginRequest): UploadBeginResult {
    if (!userId || !request.displayName || request.displayName.length > 255 ||
      !request.declaredMediaType || request.declaredMediaType.length > 128 ||
      !Number.isSafeInteger(request.expectedSize) || request.expectedSize <= 0 ||
      request.expectedSize > this.maxBytes) {
      throw new ArtifactUploadError("BINARY_ARTIFACT_TOO_LARGE", "Invalid artifact upload request.");
    }
    const expectedSha256 = request.expectedSha256 ? parseSha256(request.expectedSha256) : null;
    if ((request.class === "archive" || request.class === "executable") && !expectedSha256) {
      throw new ArtifactUploadError("BINARY_ARTIFACT_DIGEST_MISMATCH", "This artifact class requires a digest.");
    }
    if (this.store.healthSummary().activeUploads >= this.maxUploads) {
      throw new ArtifactUploadError("BINARY_ARTIFACT_TOO_LARGE", "Too many active artifact uploads.");
    }
    const id = randomUUID();
    const expiresAt = new Date(this.now() + this.ttlMs).toISOString();
    const session: UploadSession = {
      version: 1, id, userId, displayName: request.displayName,
      declaredMediaType: request.declaredMediaType, expectedSize: request.expectedSize,
      expectedSha256, class: request.class, nextChunkIndex: 0, writtenBytes: 0,
      expiresAt, committedAt: null,
    };
    this.store.createUploadStaging(id);
    this.store.writeUploadSession(session);
    return { sessionId: id, nextChunkIndex: 0, chunkBytes: this.chunkBytes, expiresAt };
  }

  append(userId: string, sessionId: string, chunkIndex: number, base64: string): UploadChunkResult {
    const session = this.requireActive(userId, sessionId);
    if (!Number.isSafeInteger(chunkIndex) || chunkIndex !== session.nextChunkIndex) {
      throw new ArtifactUploadError("BINARY_ARTIFACT_UPLOAD_ORDER", "Artifact chunks must be uploaded in order.");
    }
    let decodedSize: number;
    try { decodedSize = decodedBase64Length(base64, this.chunkBytes); }
    catch { throw new ArtifactUploadError("BINARY_ARTIFACT_TOO_LARGE", "Artifact chunk is invalid or too large."); }
    if (session.writtenBytes + decodedSize > session.expectedSize) {
      throw new ArtifactUploadError("BINARY_ARTIFACT_TOO_LARGE", "Artifact upload exceeds its expected size.");
    }
    const bytes = Buffer.from(base64, "base64");
    this.store.appendUploadBytes(sessionId, bytes);
    session.nextChunkIndex += 1;
    session.writtenBytes += bytes.length;
    this.store.writeUploadSession(session);
    return { nextChunkIndex: session.nextChunkIndex, writtenBytes: session.writtenBytes };
  }

  commit(userId: string, sessionId: string): ArtifactCommitResult {
    const session = this.requireActive(userId, sessionId);
    if (session.writtenBytes !== session.expectedSize) {
      throw new ArtifactUploadError("BINARY_ARTIFACT_SIZE_MISMATCH", "Artifact upload size does not match.");
    }
    session.committedAt = new Date(this.now()).toISOString();
    this.store.writeUploadSession(session);
    try {
      return this.store.promoteStaging({
        sessionId, displayName: session.displayName, declaredMediaType: session.declaredMediaType,
        expectedSize: session.expectedSize, expectedSha256: session.expectedSha256,
        class: session.class, source: "upload",
      });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error) {
        throw new ArtifactUploadError(error.code as ArtifactUploadErrorCode, "Artifact upload could not be committed.");
      }
      throw error;
    }
  }

  inspect(userId: string, sessionId: string): UploadInspection {
    const session = this.requireActive(userId, sessionId);
    return {
      sessionId: session.id, nextChunkIndex: session.nextChunkIndex,
      writtenBytes: session.writtenBytes, expiresAt: session.expiresAt,
      committed: session.committedAt !== null,
    };
  }

  private requireActive(userId: string, sessionId: string): UploadSession {
    const session = this.store.readUploadSession(sessionId);
    if (!session || session.userId !== userId) {
      throw new ArtifactUploadError("BINARY_ARTIFACT_UPLOAD_NOT_FOUND", "Artifact upload session was not found.");
    }
    if (Date.parse(session.expiresAt) <= this.now()) {
      throw new ArtifactUploadError("BINARY_ARTIFACT_UPLOAD_EXPIRED", "Artifact upload session has expired.");
    }
    if (session.committedAt) {
      throw new ArtifactUploadError("BINARY_ARTIFACT_UPLOAD_NOT_FOUND", "Artifact upload session was already committed.");
    }
    return session;
  }
}
