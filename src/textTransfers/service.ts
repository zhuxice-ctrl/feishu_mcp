import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_TEXT_TRANSFER_CHUNK_BYTES,
  DEFAULT_TEXT_TRANSFER_MAX_SESSIONS,
  DEFAULT_TEXT_TRANSFER_TTL_MS,
  TEXT_TRANSFER_VERSION,
  type TextTransferAppendResult,
  type TextTransferBeginRequest,
  type TextTransferBeginResult,
  type TextTransferErrorCode,
  type TextTransferInspection,
  type TextTransferSession,
  type TextTransferVerification,
  type VerifiedTextSource,
} from "./types.js";

export { DEFAULT_TEXT_TRANSFER_CHUNK_BYTES } from "./types.js";

export class TextTransferError extends Error {
  constructor(readonly code: TextTransferErrorCode, message: string) {
    super(message);
    this.name = "TextTransferError";
  }
}

export interface TextTransferServiceOptions {
  dataDir: string;
  chunkBytes?: number;
  ttlMs?: number;
  maxBytes?: number;
  maxSessions?: number;
  now?: () => number;
}

function isSafeSessionId(value: string): boolean {
  return /^[a-f0-9-]{36}$/i.test(value);
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export class TextTransferService {
  private readonly dataDir: string;
  private readonly chunkBytes: number;
  private readonly ttlMs: number;
  private readonly maxBytes: number;
  private readonly maxSessions: number;
  private readonly now: () => number;

  constructor(options: TextTransferServiceOptions) {
    if (!Number.isSafeInteger(options.chunkBytes ?? DEFAULT_TEXT_TRANSFER_CHUNK_BYTES) ||
      (options.chunkBytes ?? DEFAULT_TEXT_TRANSFER_CHUNK_BYTES) <= 0) {
      throw new TextTransferError("TEXT_TRANSFER_STORE_FAILED", "Invalid text transfer chunk limit.");
    }
    if (!Number.isSafeInteger(options.maxBytes ?? Number.MAX_SAFE_INTEGER) ||
      (options.maxBytes ?? Number.MAX_SAFE_INTEGER) < 0) {
      throw new TextTransferError("TEXT_TRANSFER_STORE_FAILED", "Invalid text transfer size limit.");
    }
    this.dataDir = path.resolve(options.dataDir);
    this.chunkBytes = options.chunkBytes ?? DEFAULT_TEXT_TRANSFER_CHUNK_BYTES;
    this.ttlMs = options.ttlMs ?? DEFAULT_TEXT_TRANSFER_TTL_MS;
    this.maxBytes = options.maxBytes ?? Number.MAX_SAFE_INTEGER;
    this.maxSessions = options.maxSessions ?? DEFAULT_TEXT_TRANSFER_MAX_SESSIONS;
    this.now = options.now ?? Date.now;
  }

  begin(ownerId: string, request: TextTransferBeginRequest): TextTransferBeginResult {
    if (!ownerId || !Number.isSafeInteger(request.expectedBytes) || request.expectedBytes < 0 ||
      request.expectedBytes > this.maxBytes || !isSha256(request.expectedSha256)) {
      throw new TextTransferError("TEXT_TRANSFER_TOO_LARGE", "Invalid text transfer request.");
    }
    this.cleanupExpired();
    if (this.activeSessionCount() >= this.maxSessions) {
      throw new TextTransferError("TEXT_TRANSFER_TOO_LARGE", "Too many active text transfers.");
    }
    const id = crypto.randomUUID();
    const session: TextTransferSession = {
      version: TEXT_TRANSFER_VERSION,
      id,
      ownerId,
      expectedBytes: request.expectedBytes,
      expectedSha256: request.expectedSha256.toLowerCase(),
      nextChunkIndex: 0,
      writtenBytes: 0,
      expiresAt: new Date(this.now() + this.ttlMs).toISOString(),
      verifiedAt: null,
    };
    this.createStaging(session.id);
    try {
      this.writeSession(session);
    } catch (error) {
      this.removeStaging(session.id);
      throw error;
    }
    return {
      sessionId: session.id,
      nextChunkIndex: session.nextChunkIndex,
      chunkBytes: this.chunkBytes,
      expiresAt: session.expiresAt,
    };
  }

  append(ownerId: string, sessionId: string, chunkIndex: number, content: string): TextTransferAppendResult {
    const session = this.requireActive(ownerId, sessionId);
    if (session.verifiedAt) {
      throw new TextTransferError("TEXT_TRANSFER_VERIFIED", "Verified text transfers cannot accept more chunks.");
    }
    if (!Number.isSafeInteger(chunkIndex) || chunkIndex !== session.nextChunkIndex) {
      throw new TextTransferError("TEXT_TRANSFER_ORDER", "Text chunks must be uploaded in order.");
    }
    if (hasUnpairedSurrogate(content)) {
      throw new TextTransferError("TEXT_TRANSFER_CHUNK_INVALID", "Text chunk contains an unpaired UTF-16 surrogate.");
    }
    const bytes = Buffer.from(content, "utf8");
    if (bytes.length > this.chunkBytes) {
      throw new TextTransferError("TEXT_TRANSFER_CHUNK_INVALID", "Text chunk exceeds the configured byte limit.");
    }
    if (session.writtenBytes + bytes.length > session.expectedBytes) {
      throw new TextTransferError("TEXT_TRANSFER_EXCEEDS_EXPECTED_SIZE", "Text transfer exceeds its declared size.");
    }
    this.appendBytes(session.id, bytes);
    session.nextChunkIndex += 1;
    session.writtenBytes += bytes.length;
    this.writeSession(session);
    return { nextChunkIndex: session.nextChunkIndex, writtenBytes: session.writtenBytes };
  }

  inspect(ownerId: string, sessionId: string): TextTransferInspection {
    const session = this.requireActive(ownerId, sessionId);
    return {
      sessionId: session.id,
      nextChunkIndex: session.nextChunkIndex,
      writtenBytes: session.writtenBytes,
      expectedBytes: session.expectedBytes,
      expiresAt: session.expiresAt,
      verified: session.verifiedAt !== null,
    };
  }

  verify(ownerId: string, sessionId: string): TextTransferVerification {
    const session = this.requireActive(ownerId, sessionId);
    if (session.writtenBytes !== session.expectedBytes) {
      throw new TextTransferError("TEXT_TRANSFER_SIZE_MISMATCH", "Text transfer size does not match its declaration.");
    }
    const actual = this.digestContent(session.id);
    if (actual.size !== session.expectedBytes) {
      throw new TextTransferError("TEXT_TRANSFER_SIZE_MISMATCH", "Text transfer size does not match its declaration.");
    }
    if (actual.sha256 !== session.expectedSha256) {
      throw new TextTransferError("TEXT_TRANSFER_DIGEST_MISMATCH", "Text transfer digest does not match its declaration.");
    }
    if (!session.verifiedAt) {
      session.verifiedAt = new Date(this.now()).toISOString();
      this.writeSession(session);
    }
    return { size: actual.size, sha256: actual.sha256, verifiedAt: session.verifiedAt };
  }

  readVerified(ownerId: string, sessionId: string): VerifiedTextSource {
    const session = this.requireActive(ownerId, sessionId);
    if (!session.verifiedAt) {
      throw new TextTransferError("TEXT_TRANSFER_NOT_VERIFIED", "Text transfer has not been verified.");
    }
    const actual = this.digestContent(session.id);
    if (actual.size !== session.expectedBytes || actual.sha256 !== session.expectedSha256) {
      throw new TextTransferError("TEXT_TRANSFER_DIGEST_MISMATCH", "Verified text staging no longer matches its declaration.");
    }
    const source = Object.freeze({
      path: this.contentPath(session.id),
      size: actual.size,
      sha256: actual.sha256,
    });
    return source;
  }

  discard(ownerId: string, sessionId: string): void {
    this.requireActive(ownerId, sessionId);
    this.removeStaging(sessionId);
  }

  cleanupExpired(): number {
    let removed = 0;
    for (const id of this.stagingSessionIds()) {
      const session = this.readSession(id);
      if (!session || Date.parse(session.expiresAt) <= this.now()) {
        this.removeStaging(id);
        removed += 1;
      }
    }
    return removed;
  }

  private requireActive(ownerId: string, sessionId: string): TextTransferSession {
    const session = this.readSession(sessionId);
    if (!session || session.ownerId !== ownerId) {
      throw new TextTransferError("TEXT_TRANSFER_NOT_FOUND", "Text transfer session was not found.");
    }
    if (Date.parse(session.expiresAt) <= this.now()) {
      this.removeStaging(session.id);
      throw new TextTransferError("TEXT_TRANSFER_EXPIRED", "Text transfer session has expired.");
    }
    return session;
  }

  private createStaging(sessionId: string): void {
    const directory = this.stagingDirectory(sessionId);
    try {
      fs.mkdirSync(this.stagingRoot(), { recursive: true, mode: 0o700 });
      fs.mkdirSync(directory, { mode: 0o700 });
      const fd = fs.openSync(this.contentPath(sessionId), "wx", 0o600);
      fs.closeSync(fd);
    } catch {
      this.removeStaging(sessionId);
      throw new TextTransferError("TEXT_TRANSFER_STORE_FAILED", "Could not create text transfer staging.");
    }
  }

  private appendBytes(sessionId: string, bytes: Buffer): void {
    try {
      const fd = fs.openSync(this.contentPath(sessionId), "a", 0o600);
      try {
        fs.writeSync(fd, bytes);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      throw new TextTransferError("TEXT_TRANSFER_STORE_FAILED", "Could not append text transfer chunk.");
    }
  }

  private readSession(sessionId: string): TextTransferSession | null {
    if (!isSafeSessionId(sessionId)) return null;
    try {
      const session = JSON.parse(fs.readFileSync(this.sessionPath(sessionId), "utf8")) as TextTransferSession;
      if (session.version !== TEXT_TRANSFER_VERSION || session.id !== sessionId || !session.ownerId ||
        !Number.isSafeInteger(session.expectedBytes) || session.expectedBytes < 0 ||
        !isSha256(session.expectedSha256) || !Number.isSafeInteger(session.nextChunkIndex) ||
        session.nextChunkIndex < 0 || !Number.isSafeInteger(session.writtenBytes) ||
        session.writtenBytes < 0 || session.writtenBytes > session.expectedBytes ||
        !Number.isFinite(Date.parse(session.expiresAt)) ||
        (session.verifiedAt !== null && !Number.isFinite(Date.parse(session.verifiedAt)))) {
        return null;
      }
      return session;
    } catch {
      return null;
    }
  }

  private writeSession(session: TextTransferSession): void {
    const destination = this.sessionPath(session.id);
    const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.writeFileSync(fd, `${JSON.stringify(session)}\n`, "utf8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, destination);
      const syncFd = fs.openSync(destination, "r+");
      try { fs.fsyncSync(syncFd); } finally { fs.closeSync(syncFd); }
    } catch {
      try { fs.rmSync(temporary, { force: true }); } catch { /* ignored */ }
      throw new TextTransferError("TEXT_TRANSFER_STORE_FAILED", "Could not persist text transfer session.");
    }
  }

  private digestContent(sessionId: string): { size: number; sha256: string } {
    try {
      const content = this.contentPath(sessionId);
      const stat = fs.lstatSync(content);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe staging content.");
      const hash = crypto.createHash("sha256");
      const fd = fs.openSync(content, "r");
      try {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let position = 0;
        for (;;) {
          const count = fs.readSync(fd, buffer, 0, buffer.length, position);
          if (count === 0) break;
          hash.update(buffer.subarray(0, count));
          position += count;
        }
        return { size: position, sha256: hash.digest("hex") };
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      if (error instanceof TextTransferError) throw error;
      throw new TextTransferError("TEXT_TRANSFER_STORE_FAILED", "Could not verify text transfer staging.");
    }
  }

  private activeSessionCount(): number {
    return this.stagingSessionIds().length;
  }

  private stagingSessionIds(): string[] {
    try {
      return fs.readdirSync(this.stagingRoot(), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && isSafeSessionId(entry.name))
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  private removeStaging(sessionId: string): void {
    if (!isSafeSessionId(sessionId)) return;
    try { fs.rmSync(this.stagingDirectory(sessionId), { recursive: true, force: true }); } catch { /* ignored */ }
  }

  private stagingRoot(): string {
    return path.join(this.dataDir, "text-transfers");
  }

  private stagingDirectory(sessionId: string): string {
    return path.join(this.stagingRoot(), sessionId);
  }

  private contentPath(sessionId: string): string {
    return path.join(this.stagingDirectory(sessionId), "content.partial");
  }

  private sessionPath(sessionId: string): string {
    return path.join(this.stagingDirectory(sessionId), "session.json");
  }
}
