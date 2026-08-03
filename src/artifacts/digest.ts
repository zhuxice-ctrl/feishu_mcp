import { createHash } from "node:crypto";
import fs from "node:fs";
import type { ArtifactId } from "./types.js";

export const SHA256_HEX = /^[a-f0-9]{64}$/;

export function parseSha256(value: string | undefined): string | null {
  return value && SHA256_HEX.test(value) ? value : null;
}

export function artifactId(sha256: string): ArtifactId {
  if (!SHA256_HEX.test(sha256)) throw new Error("Invalid SHA-256 digest.");
  return `sha256:${sha256}`;
}

export function decodedBase64Length(value: string, maxBytes: number): number {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Invalid decoded byte limit.");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Invalid Base64 data.");
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const bytes = (value.length / 4) * 3 - padding;
  if (!Number.isSafeInteger(bytes) || bytes > maxBytes) throw new Error("Decoded Base64 data is too large.");
  return bytes;
}

export function sha256File(filePath: string): { sha256: string; size: number } {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(filePath, flags);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error("Artifact content is not a regular file.");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < stat.size) {
      const read = fs.readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - position), position);
      if (read <= 0) throw new Error("Artifact content changed during hashing.");
      hash.update(buffer.subarray(0, read));
      position += read;
    }
    return { sha256: hash.digest("hex"), size: stat.size };
  } finally {
    fs.closeSync(fd);
  }
}
