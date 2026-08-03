export type ArtifactClass = "project_asset" | "archive" | "executable";
export type ArtifactSourceKind = "url" | "upload";
export type ArtifactId = `sha256:${string}`;

export interface ArtifactMetadata {
  version: 1;
  artifact: ArtifactId;
  sha256: string;
  size: number;
  displayName: string;
  declaredMediaType: string;
  detectedMediaType: string | null;
  class: ArtifactClass;
  createdAt: string;
  source: ArtifactSourceKind;
  urlOriginDigest?: string;
}

export interface UploadSession {
  version: 1;
  id: string;
  userId: string;
  displayName: string;
  declaredMediaType: string;
  expectedSize: number;
  expectedSha256: string | null;
  class: ArtifactClass;
  nextChunkIndex: number;
  writtenBytes: number;
  expiresAt: string;
  committedAt: string | null;
}
