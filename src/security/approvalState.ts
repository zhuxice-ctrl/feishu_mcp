import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  createRequestStateCodec,
  type ServerContext,
} from "@modelcontextprotocol/server";
import {
  APPROVAL_DATA_DIR,
  APPROVAL_STATE_SECRET,
  APPROVAL_TIMEOUT_MS,
} from "../config.js";
import { getRequestUserId } from "./requestContext.js";

export interface ApprovalStatePayload {
  version: 1;
  tool: string;
  userId: string | null;
  subjectKey: string;
  argsDigest: string;
  nonce: string;
}

function loadOrCreateApprovalKey(): string {
  if (APPROVAL_STATE_SECRET) {
    if (Buffer.byteLength(APPROVAL_STATE_SECRET, "utf8") < 32) {
      throw new Error("APPROVAL_STATE_SECRET must contain at least 32 bytes");
    }
    return APPROVAL_STATE_SECRET;
  }
  fs.mkdirSync(APPROVAL_DATA_DIR, { recursive: true, mode: 0o700 });
  const keyPath = path.join(APPROVAL_DATA_DIR, "approval.key");
  try {
    const existing = fs.readFileSync(keyPath, "utf8").trim();
    if (Buffer.byteLength(existing, "utf8") < 32) {
      throw new Error("Stored approval key is invalid");
    }
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const generated = randomBytes(32).toString("hex");
  try {
    const fd = fs.openSync(keyPath, "wx", 0o600);
    try {
      fs.writeFileSync(fd, generated, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return generated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return fs.readFileSync(keyPath, "utf8").trim();
  }
}

export const approvalStateCodec = createRequestStateCodec<ApprovalStatePayload>({
  key: loadOrCreateApprovalKey(),
  ttlSeconds: Math.ceil(APPROVAL_TIMEOUT_MS / 1000),
  bind: () => getRequestUserId() ?? "__anonymous__",
});

export function mintApprovalState(
  payload: ApprovalStatePayload,
  ctx?: ServerContext,
): Promise<string> {
  return approvalStateCodec.mint(payload, ctx);
}

export const verifyApprovalState = approvalStateCodec.verify;
