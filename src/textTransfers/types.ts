export const TEXT_TRANSFER_VERSION = 1 as const;
export const DEFAULT_TEXT_TRANSFER_CHUNK_BYTES = 48 * 1024;
export const DEFAULT_TEXT_TRANSFER_TTL_MS = 60 * 60 * 1000;
export const DEFAULT_TEXT_TRANSFER_MAX_SESSIONS = 16;
export const DEFAULT_TEXT_TRANSFER_MAX_BYTES = 5 * 1024 * 1024;

export type TextTransferErrorCode =
  | "TEXT_TRANSFER_NOT_FOUND"
  | "TEXT_TRANSFER_EXPIRED"
  | "TEXT_TRANSFER_ORDER"
  | "TEXT_TRANSFER_CHUNK_INVALID"
  | "TEXT_TRANSFER_TOO_LARGE"
  | "TEXT_TRANSFER_EXCEEDS_EXPECTED_SIZE"
  | "TEXT_TRANSFER_SIZE_MISMATCH"
  | "TEXT_TRANSFER_DIGEST_MISMATCH"
  | "TEXT_TRANSFER_NOT_VERIFIED"
  | "TEXT_TRANSFER_VERIFIED"
  | "TEXT_TRANSFER_STORE_FAILED";

export interface TextTransferSession {
  version: typeof TEXT_TRANSFER_VERSION;
  id: string;
  ownerId: string;
  expectedBytes: number;
  expectedSha256: string;
  nextChunkIndex: number;
  writtenBytes: number;
  expiresAt: string;
  verifiedAt: string | null;
}

export interface TextTransferBeginRequest {
  expectedBytes: number;
  expectedSha256: string;
}

export interface TextTransferBeginResult {
  sessionId: string;
  nextChunkIndex: number;
  chunkBytes: number;
  expiresAt: string;
}

export interface TextTransferAppendResult {
  nextChunkIndex: number;
  writtenBytes: number;
}

export interface TextTransferInspection {
  sessionId: string;
  nextChunkIndex: number;
  writtenBytes: number;
  expectedBytes: number;
  expiresAt: string;
  verified: boolean;
}

export interface VerifiedTextSource {
  path: string;
  size: number;
  sha256: string;
}

export interface TextTransferVerification {
  size: number;
  sha256: string;
  verifiedAt: string;
}
