import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { CallToolResult, ServerContext } from "@modelcontextprotocol/server";
import { APPROVAL_TIMEOUT_MS } from "../config.js";
import { toolError } from "../tools/results.js";
import { consumeSignedNonce } from "./approval.js";
import {
  mintApprovalState,
  verifyApprovalState,
  type GitConfirmationStatePayload,
} from "./approvalState.js";
import { logger } from "./logger.js";
import { getRequestUserId } from "./requestContext.js";

export interface GitConfirmationRequest {
  userId: string;
  command: string;
  workdir: string;
  timeoutMs: number;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function commandDigest(request: GitConfirmationRequest): string {
  return digest(request.command);
}

function workdirDigest(request: GitConfirmationRequest): string {
  return digest(path.resolve(request.workdir));
}

function confirmationDigest(payload: GitConfirmationStatePayload): string {
  return digest([
    payload.commandDigest,
    payload.workdirDigest,
    String(payload.timeoutMs),
    payload.nonce,
  ].join("\u0000"));
}

function isGitConfirmationPayload(value: unknown): value is GitConfirmationStatePayload {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<GitConfirmationStatePayload>;
  return state.version === 1 && state.kind === "git_confirmation" &&
    typeof state.userId === "string" && typeof state.commandDigest === "string" &&
    typeof state.workdirDigest === "string" && Number.isSafeInteger(state.timeoutMs) &&
    typeof state.nonce === "string" && state.nonce.length > 0 &&
    typeof state.expiresAt === "string";
}

function matchesRequest(
  payload: GitConfirmationStatePayload,
  request: GitConfirmationRequest,
): boolean {
  return payload.userId === request.userId &&
    payload.userId === getRequestUserId() &&
    payload.commandDigest === commandDigest(request) &&
    payload.workdirDigest === workdirDigest(request) &&
    payload.timeoutMs === request.timeoutMs;
}

export async function createGitConfirmation(
  ctx: ServerContext,
  request: GitConfirmationRequest,
): Promise<CallToolResult> {
  const expiresAt = new Date(Date.now() + APPROVAL_TIMEOUT_MS).toISOString();
  const payload: GitConfirmationStatePayload = {
    version: 1,
    kind: "git_confirmation",
    userId: request.userId,
    commandDigest: commandDigest(request),
    workdirDigest: workdirDigest(request),
    timeoutMs: request.timeoutMs,
    nonce: randomUUID(),
    expiresAt,
  };
  const token = await mintApprovalState(payload, ctx);
  logger.info("git_soft_confirmation", {
    outcome: "confirmation_requested",
    digest: confirmationDigest(payload),
  });
  return toolError(
    "GIT_CONFIRMATION_REQUIRED",
    "Explicit confirmation is required before retrying this Git command.",
    true,
    { gitConfirmation: { token, expiresAt, retryOriginalCall: true } },
  );
}

export async function consumeGitConfirmation(
  ctx: ServerContext,
  token: string,
  request: GitConfirmationRequest,
): Promise<boolean> {
  let verified: unknown;
  try {
    verified = await verifyApprovalState(token, ctx);
  } catch {
    return false;
  }
  if (!isGitConfirmationPayload(verified) || !matchesRequest(verified, request)) return false;
  const expiry = Date.parse(verified.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= Date.now()) return false;
  if (!consumeSignedNonce(verified.nonce)) return false;
  logger.info("git_soft_confirmation", {
    outcome: "confirmation_accepted",
    digest: confirmationDigest(verified),
  });
  return true;
}
