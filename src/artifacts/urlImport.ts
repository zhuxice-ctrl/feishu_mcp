import { createHash, randomUUID } from "node:crypto";
import https from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import {
  BINARY_ARTIFACT_MAX_BYTES,
  FETCH_MAX_REDIRECTS,
  FETCH_MAX_TIMEOUT_MS,
  FETCH_TIMEOUT_MS,
  SERVER_NAME,
  SERVER_VERSION,
} from "../config.js";
import { validateNetworkTarget, type ValidatedNetworkTarget } from "../security/networkGuard.js";
import { BinaryArtifactStore, type ArtifactCommitResult } from "./store.js";
import type { ArtifactClass } from "./types.js";

export class ArtifactUrlImportError extends Error {
  constructor(readonly code: "BINARY_ARTIFACT_SOURCE_DENIED" | "BINARY_ARTIFACT_TOO_LARGE", message: string) {
    super(message);
    this.name = "ArtifactUrlImportError";
  }
}

export interface UrlImportRequest {
  url: string;
  displayName: string;
  declaredMediaType: string;
  expectedSize: number | null;
  expectedSha256: string | null;
  class: ArtifactClass;
}

interface ResponseResult {
  status: number;
  headers: IncomingHttpHeaders;
  redirect: URL | null;
  bytes: number;
}

function responseLength(headers: IncomingHttpHeaders): number | null {
  const raw = headers["content-length"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function requestOnce(
  target: ValidatedNetworkTarget,
  store: BinaryArtifactStore,
  sessionId: string,
  maxBytes: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ResponseResult> {
  return new Promise((resolve, reject) => {
    const address = target.addresses[0];
    let settled = false;
    const finish = (value: ResponseResult) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = https.request(target.url, {
      method: "GET",
      headers: {
        "user-agent": `${SERVER_NAME}/${SERVER_VERSION}`,
        "accept-encoding": "identity",
      },
      servername: target.url.hostname,
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
      timeout: timeoutMs,
      signal,
      maxHeaderSize: 16 * 1024,
    }, (response) => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.resume();
        finish({ status, headers: response.headers, redirect: new URL(location, target.url), bytes: 0 });
        return;
      }
      const declared = responseLength(response.headers);
      if (declared !== null && declared > maxBytes) {
        response.destroy();
        fail(new ArtifactUrlImportError("BINARY_ARTIFACT_TOO_LARGE", "Artifact response is too large."));
        return;
      }
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        if (settled) return;
        bytes += chunk.length;
        if (bytes > maxBytes) {
          response.destroy();
          fail(new ArtifactUrlImportError("BINARY_ARTIFACT_TOO_LARGE", "Artifact response is too large."));
          return;
        }
        try { store.appendUploadBytes(sessionId, chunk); }
        catch { response.destroy(); fail(new ArtifactUrlImportError("BINARY_ARTIFACT_SOURCE_DENIED", "Artifact response could not be staged.")); }
      });
      response.once("end", () => finish({ status, headers: response.headers, redirect: null, bytes }));
      response.once("error", () => fail(new ArtifactUrlImportError("BINARY_ARTIFACT_SOURCE_DENIED", "Artifact response failed.")));
    });
    request.once("timeout", () => request.destroy(new Error("Artifact request timed out.")));
    request.once("error", () => fail(new ArtifactUrlImportError("BINARY_ARTIFACT_SOURCE_DENIED", "Artifact source request failed.")));
    request.end();
  });
}

export async function importArtifactUrl(
  store: BinaryArtifactStore,
  request: UrlImportRequest,
  signal: AbortSignal,
): Promise<ArtifactCommitResult> {
  const timeoutMs = Math.min(FETCH_TIMEOUT_MS, FETCH_MAX_TIMEOUT_MS);
  const maxBytes = Math.min(request.expectedSize ?? BINARY_ARTIFACT_MAX_BYTES, BINARY_ARTIFACT_MAX_BYTES);
  if (request.expectedSize !== null && (!Number.isSafeInteger(request.expectedSize) || request.expectedSize <= 0)) {
    throw new ArtifactUrlImportError("BINARY_ARTIFACT_SOURCE_DENIED", "Artifact expected size is invalid.");
  }
  let current: ValidatedNetworkTarget;
  try { current = await validateNetworkTarget(request.url, { policy: "artifact_import" }); }
  catch { throw new ArtifactUrlImportError("BINARY_ARTIFACT_SOURCE_DENIED", "Artifact source is denied."); }
  const sessionId = randomUUID();
  const originDigest = createHash("sha256").update(current.origin).digest("hex");
  store.createUploadStaging(sessionId);
  const deadline = Date.now() + timeoutMs;
  try {
    for (let hop = 0; hop <= FETCH_MAX_REDIRECTS; hop += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new ArtifactUrlImportError("BINARY_ARTIFACT_SOURCE_DENIED", "Artifact source timed out.");
      const response = await requestOnce(current, store, sessionId, maxBytes, remaining, signal);
      if (response.redirect) {
        if (hop === FETCH_MAX_REDIRECTS) throw new ArtifactUrlImportError("BINARY_ARTIFACT_SOURCE_DENIED", "Artifact redirect limit exceeded.");
        try { current = await validateNetworkTarget(response.redirect, { policy: "artifact_import" }); }
        catch { throw new ArtifactUrlImportError("BINARY_ARTIFACT_SOURCE_DENIED", "Artifact redirect is denied."); }
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        throw new ArtifactUrlImportError("BINARY_ARTIFACT_SOURCE_DENIED", "Artifact source returned an unsuccessful response.");
      }
      if (request.expectedSize !== null && response.bytes !== request.expectedSize) {
        throw new ArtifactUrlImportError("BINARY_ARTIFACT_SOURCE_DENIED", "Artifact response size does not match.");
      }
      return store.promoteStaging({
        sessionId, displayName: request.displayName, declaredMediaType: request.declaredMediaType,
        expectedSize: request.expectedSize ?? response.bytes, expectedSha256: request.expectedSha256,
        class: request.class, source: "url", urlOriginDigest: originDigest,
      });
    }
    throw new ArtifactUrlImportError("BINARY_ARTIFACT_SOURCE_DENIED", "Artifact redirect limit exceeded.");
  } catch (error) {
    store.discardUpload(sessionId);
    if (error instanceof ArtifactUrlImportError) throw error;
    throw new ArtifactUrlImportError("BINARY_ARTIFACT_SOURCE_DENIED", "Artifact import failed.");
  }
}
