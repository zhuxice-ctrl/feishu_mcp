import type { ArtifactClass } from "./types.js";

function startsWith(buffer: Buffer, bytes: readonly number[]): boolean {
  return buffer.length >= bytes.length && bytes.every((value, index) => buffer[index] === value);
}

function normalizedMediaType(value: string): string {
  return value.split(";", 1)[0].trim().toLowerCase();
}

export function detectArtifactMediaType(prefix: Buffer): string | null {
  if (startsWith(prefix, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(prefix, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(prefix, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith(prefix, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return "image/gif";
  if (startsWith(prefix, [0x52, 0x49, 0x46, 0x46]) && prefix.subarray(8, 12).equals(Buffer.from("WEBP"))) return "image/webp";
  if (startsWith(prefix, [0x50, 0x4b, 0x03, 0x04]) || startsWith(prefix, [0x50, 0x4b, 0x05, 0x06]) || startsWith(prefix, [0x50, 0x4b, 0x07, 0x08])) return "application/zip";
  if (startsWith(prefix, [0x4d, 0x5a])) return "application/vnd.microsoft.portable-executable";
  if (startsWith(prefix, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  if (startsWith(prefix, [0x52, 0x49, 0x46, 0x46]) && prefix.subarray(8, 12).equals(Buffer.from("WAVE"))) return "audio/wav";
  if (startsWith(prefix, [0x4f, 0x67, 0x67, 0x53])) return "audio/ogg";
  return null;
}

function mediaTypesMatch(declared: string, detected: string | null): boolean {
  if (!detected) return false;
  const aliases: Record<string, string[]> = {
    "application/zip": ["application/zip", "application/java-archive", "application/x-java-archive"],
    "application/vnd.microsoft.portable-executable": ["application/vnd.microsoft.portable-executable", "application/x-msdownload"],
    "audio/wav": ["audio/wav", "audio/x-wav"],
  };
  return (aliases[detected] ?? [detected]).includes(declared);
}

export function validateArtifactType(input: {
  declaredMediaType: string;
  class: ArtifactClass;
  expectedSha256: string | null;
}, prefix: Buffer): { ok: true; detectedMediaType: string | null } | { ok: false; code: "BINARY_ARTIFACT_TYPE_MISMATCH" } {
  const declared = normalizedMediaType(input.declaredMediaType);
  const detected = detectArtifactMediaType(prefix);
  if ((input.class === "archive" || input.class === "executable") && !input.expectedSha256) {
    return { ok: false, code: "BINARY_ARTIFACT_TYPE_MISMATCH" };
  }
  if (declared === "application/octet-stream") {
    return input.class === "project_asset" && input.expectedSha256
      ? { ok: true, detectedMediaType: detected }
      : { ok: false, code: "BINARY_ARTIFACT_TYPE_MISMATCH" };
  }
  return mediaTypesMatch(declared, detected)
    ? { ok: true, detectedMediaType: detected }
    : { ok: false, code: "BINARY_ARTIFACT_TYPE_MISMATCH" };
}
