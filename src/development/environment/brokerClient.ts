/**
 * Administrator-broker client.
 *
 * Connects only to the fixed named pipe `\\.\pipe\feishu-mcp-admin-<sid-hash>`,
 * caps both request and response at 64 KiB, uses a 30-second connection
 * timeout, signs the canonical request fields with HMAC-SHA256, and maps
 * broker errors to structured MCP errors. The pipe secret, HMAC, nonce, and
 * owner SID are never logged or returned.
 */

import net from "node:net";
import { createHmac, randomUUID } from "node:crypto";

export const BROKER_PIPE_PREFIX = "\\\\.\\pipe\\feishu-mcp-admin-";
export const BROKER_CONNECT_TIMEOUT_MS = 30_000;
export const BROKER_MAX_FRAME_BYTES = 64 * 1024;
export const BROKER_PROTOCOL_VERSION = 1;

export type BrokerOperationId =
  | "winget"
  | "vs_workload"
  | "android_sdk"
  | "verified_archive";

export interface BrokerApplyInput {
  operationId: BrokerOperationId;
  planId: string;
  componentId: string;
  version: string;
}

export interface BrokerResult {
  accepted: boolean;
  exitCode?: number;
  stage?: string;
  message?: string;
  error?: string;
}

export interface BrokerClientOptions {
  /** Full pipe path, e.g. `\\.\pipe\feishu-mcp-admin-<sid-hash>`. */
  pipePath: string;
  /** 32-byte shared key read from the ACL-protected local file. */
  key: Buffer;
  ownerSid: string;
  catalogDigest: string;
  connectTimeoutMs?: number;
  clock?: () => Date;
  nonceGen?: () => string;
}

export class BrokerClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BrokerClientError";
  }
}

function sidHash(sid: string): string {
  return createHmac("sha256", sid).update(sid).digest("hex").slice(0, 16);
}

export function brokerPipePath(ownerSid: string): string {
  return `${BROKER_PIPE_PREFIX}${sidHash(ownerSid)}`;
}

function canonical(input: {
  protocolVersion: number;
  requestId: string;
  planId: string;
  operationId: string;
  componentId: string;
  version: string;
  catalogDigest: string;
  ownerSid: string;
  timestamp: number;
  nonce: string;
}): string {
  return [
    input.protocolVersion,
    input.requestId,
    input.planId,
    input.operationId,
    input.componentId,
    input.version,
    input.catalogDigest,
    input.ownerSid,
    input.timestamp,
    input.nonce,
  ].join("\n");
}

function sign(key: Buffer, fields: Record<string, unknown>): string {
  return createHmac("sha256", key).update(canonical(fields as never), "utf8").digest("hex");
}

const ERROR_CODE_MAP: Record<string, string> = {
  MalformedRequest: "BROKER_MALFORMED",
  ProtocolMismatch: "BROKER_PROTOCOL",
  CatalogMismatch: "BROKER_CATALOG",
  UnsupportedOperation: "BROKER_OPERATION",
  UnknownComponent: "BROKER_COMPONENT",
  InvalidHmac: "BROKER_AUTH",
  StaleTimestamp: "BROKER_STALE",
  ReusedNonce: "BROKER_REPLAY",
  AlreadyApplied: "BROKER_ALREADY_APPLIED",
  ForbiddenOwner: "BROKER_FORBIDDEN",
};

export class BrokerClient {
  private readonly key: Buffer;
  private readonly ownerSid: string;
  private readonly catalogDigest: string;
  private readonly pipePath: string;
  private readonly connectTimeoutMs: number;
  private readonly clock: () => Date;
  private readonly nonceGen: () => string;

  constructor(options: BrokerClientOptions) {
    this.key = options.key;
    this.ownerSid = options.ownerSid;
    this.catalogDigest = options.catalogDigest;
    this.pipePath = options.pipePath;
    this.connectTimeoutMs = options.connectTimeoutMs ?? BROKER_CONNECT_TIMEOUT_MS;
    this.clock = options.clock ?? (() => new Date());
    this.nonceGen = options.nonceGen ?? (() => randomUUID());
  }

  async apply(input: BrokerApplyInput): Promise<BrokerResult> {
    const fields = {
      protocolVersion: BROKER_PROTOCOL_VERSION,
      requestId: randomUUID(),
      planId: input.planId,
      operationId: input.operationId,
      componentId: input.componentId,
      version: input.version,
      catalogDigest: this.catalogDigest,
      ownerSid: this.ownerSid,
      timestamp: Math.floor(this.clock().getTime() / 1000),
      nonce: this.nonceGen(),
    };
    const request = { ...fields, hmac: sign(this.key, fields) };
    const body = Buffer.from(JSON.stringify(request), "utf8");
    if (body.length > BROKER_MAX_FRAME_BYTES) {
      throw new BrokerClientError("BROKER_REQUEST_TOO_LARGE", "request exceeds frame cap");
    }
    let response: Buffer;
    try {
      response = await this.exchange(body);
    } catch (cause) {
      throw new BrokerClientError("BROKER_UNAVAILABLE", redactConnectionError(cause));
    }
    const parsed = JSON.parse(response.toString("utf8")) as BrokerResult;
    if (parsed.error && ERROR_CODE_MAP[parsed.error]) {
      parsed.error = ERROR_CODE_MAP[parsed.error];
    }
    return parsed;
  }

  private exchange(request: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.pipePath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("connection timeout"));
      }, this.connectTimeoutMs);
      socket.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      socket.on("connect", () => {
        const header = Buffer.alloc(4);
        header.writeUInt32BE(request.length, 0);
        socket.write(header);
        socket.write(request);
        readFrame(socket, BROKER_MAX_FRAME_BYTES)
          .then((frame) => {
            clearTimeout(timer);
            socket.end();
            resolve(frame);
          })
          .catch((err) => {
            clearTimeout(timer);
            socket.destroy();
            reject(err);
          });
      });
    });
  }
}

export function readFrame(socket: net.Socket, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let header = Buffer.alloc(0);
    let body = Buffer.alloc(0);
    let readingBody = false;
    let expected = 0;
    const onData = (chunk: Buffer) => {
      let buf = chunk;
      while (buf.length > 0) {
        if (!readingBody) {
          const remaining = 4 - header.length;
          const take = Math.min(remaining, buf.length);
          header = Buffer.concat([header, buf.subarray(0, take)]);
          buf = buf.subarray(take);
          if (header.length === 4) {
            expected = header.readUInt32BE(0);
            if (expected === 0 || expected > maxBytes) {
              socket.off("data", onData);
              reject(new Error("frame too large"));
              return;
            }
            readingBody = true;
            body = Buffer.alloc(0);
          }
        } else {
          const remaining = expected - body.length;
          const take = Math.min(remaining, buf.length);
          body = Buffer.concat([body, buf.subarray(0, take)]);
          buf = buf.subarray(take);
          if (body.length === expected) {
            socket.off("data", onData);
            resolve(body);
            return;
          }
        }
      }
    };
    socket.on("data", onData);
    socket.on("end", () => reject(new Error("disconnected")));
  });
}

function redactConnectionError(cause: unknown): string {
  const msg = cause instanceof Error ? cause.message : "broker unavailable";
  // Never surface the pipe path, socket path, key, sid, or nonce.
  return msg
    .replace(/\\\\\.\\pipe\\[^\s]+/gi, "<pipe>")
    .replace(/\/[^\s'"']+/g, "<path>")
    .replace(/[0-9a-f]{32,}/gi, "<redacted>");
}
