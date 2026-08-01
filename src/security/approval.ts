import { createHash, randomUUID } from "node:crypto";
import {
  acceptedContent,
  inputRequired,
  type CallToolResult,
  type InputRequiredResult,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { logger } from "./logger.js";
import { APPROVAL_TIMEOUT_MS } from "../config.js";
import { approvalStore, type ApprovalSubjectKind } from "./approvalStore.js";
import {
  mintApprovalState,
  type ApprovalDecisionMode,
  type ApprovalStatePayload,
  type DirectoryApprovalStatePayload,
  type LegacyDirectoryChallengePayload,
  type SignedRequestStatePayload,
} from "./approvalState.js";
import { toolError } from "../tools/results.js";

export interface ApprovalRequest {
  tool: string;
  userId: string | null;
  subject: { kind: ApprovalSubjectKind; key: string; display: string };
  argsDigest: string;
  reasons: string[];
  priorSubjectKeys?: string[];
  authorizedDirectoryRootsDigest?: string;
  /** Restrict the elicitation to a single allow_once/deny decision. */
  decisionMode?: ApprovalDecisionMode;
}

export type ApprovalOutcome = true | CallToolResult | InputRequiredResult;

const decisionSchema = z.object({
  decision: z.enum(["allow_once", "allow_session", "allow_permanent", "deny"]),
});
const usedNonces = new Map<string, number>();

export function consumeSignedNonce(nonce: string): boolean {
  const now = Date.now();
  if (usedNonces.has(nonce)) return false;
  if (usedNonces.size >= 4_096) {
    for (const [key, usedAt] of usedNonces) {
      if (now - usedAt > APPROVAL_TIMEOUT_MS) usedNonces.delete(key);
    }
  }
  if (usedNonces.size >= 10_000) return false;
  usedNonces.set(nonce, now);
  return true;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function digestArguments(args: unknown): string {
  return createHash("sha256").update(canonical(args)).digest("hex");
}

function requestDecisionMode(request: ApprovalRequest): ApprovalDecisionMode {
  return request.decisionMode ?? "standard";
}

function payloadDecisionMode(payload: ApprovalStatePayload): ApprovalDecisionMode {
  return payload.decisionMode ?? "standard";
}

function matches(payload: ApprovalStatePayload, request: ApprovalRequest): boolean {
  return payload.version === 1 && payload.tool === request.tool &&
    payload.userId === request.userId && payload.subjectKey === request.subject.key &&
    payload.argsDigest === request.argsDigest &&
    payloadDecisionMode(payload) === requestDecisionMode(request);
}

function isDirectoryState(value: SignedRequestStatePayload): value is DirectoryApprovalStatePayload {
  return "kind" in value && value.kind === "directory";
}

function isLegacyDirectoryState(
  value: SignedRequestStatePayload,
): value is LegacyDirectoryChallengePayload {
  return "kind" in value && value.kind === "legacy_directory";
}

function isApprovalState(value: SignedRequestStatePayload): value is ApprovalStatePayload {
  return !("kind" in value);
}

function matchesPrior(payload: ApprovalStatePayload, request: ApprovalRequest): boolean {
  return payload.version === 1 && payload.tool === request.tool && payload.userId === request.userId &&
    payload.argsDigest === request.argsDigest &&
    payloadDecisionMode(payload) === requestDecisionMode(request) &&
    payload.priorSubjectKeys?.includes(request.subject.key) === true;
}

function renderMessage(request: ApprovalRequest): string {
  return [
    `Authorize ${request.tool}?`,
    `Target: ${request.subject.display}`,
    `Scope: exact ${request.subject.kind}`,
    ...request.reasons.map((reason) => `Risk: ${reason}`),
  ].join("\n");
}

function logDecision(request: ApprovalRequest, decision: string): void {
  logger.info("approval_decision", {
    toolName: request.tool,
    subjectKind: request.subject.kind,
    decision,
    userId: request.userId,
  });
}

export async function requestApproval(
  ctx: ServerContext,
  request: ApprovalRequest,
): Promise<ApprovalOutcome> {
  const decisionMode = requestDecisionMode(request);
  if (
    decisionMode !== "single_use" &&
    approvalStore.has(request.userId, request.tool, request.subject.key)
  ) {
    logDecision(request, "remembered");
    return true;
  }

  const state = ctx.mcpReq.requestState<SignedRequestStatePayload>();
  if (state) {
    if (isLegacyDirectoryState(state)) {
      return toolError("APPROVAL_DENIED", "Legacy directory state cannot authorize this operation.");
    } else if (isDirectoryState(state)) {
      const continuingDirectoryChain = usedNonces.has(state.nonce) &&
        request.authorizedDirectoryRootsDigest !== undefined &&
        state.rootsDigest === request.authorizedDirectoryRootsDigest &&
        state.tool === request.tool && state.userId === request.userId &&
        state.argsDigest === request.argsDigest;
      if (!continuingDirectoryChain) {
        return toolError("APPROVAL_DENIED", "Directory approval state does not match this operation.");
      }
    } else if (!isApprovalState(state)) {
      return toolError("APPROVAL_DENIED", "This approval state cannot authorize this operation.");
    } else if (matchesPrior(state, request)) return true;
    else if (!matches(state, request)) {
      const continuingChain = usedNonces.has(state.nonce) &&
        payloadDecisionMode(state) === decisionMode &&
        request.priorSubjectKeys?.includes(state.subjectKey) === true;
      if (!continuingChain) {
        return toolError("APPROVAL_DENIED", "Approval state does not match this operation.");
      }
    } else {
      if (usedNonces.has(state.nonce)) {
        return toolError("APPROVAL_DENIED", "Approval state has already been used.");
      }
      const response = acceptedContent(ctx.mcpReq.inputResponses, "approval", decisionSchema);
      if (!response) {
        return toolError("APPROVAL_DENIED", "Approval was declined, cancelled, or unavailable.");
      }
      if (!consumeSignedNonce(state.nonce)) {
        return toolError("APPROVAL_DENIED", "Approval state has already been used.");
      }
      const allowedDecisions = decisionMode === "single_use"
        ? (["allow_once", "deny"] as const)
        : (["allow_once", "allow_session", "allow_permanent", "deny"] as const);
      if (!(allowedDecisions as readonly string[]).includes(response.decision)) {
        return toolError("APPROVAL_DENIED", "This operation requires a single-use decision.");
      }
      if (response.decision === "deny") {
        logDecision(request, "deny");
        return toolError("APPROVAL_DENIED", "The user denied this operation.");
      }
      if (response.decision === "allow_session") {
        approvalStore.rememberSession(request.userId, request.tool, request.subject.key);
      } else if (response.decision === "allow_permanent") {
        approvalStore.rememberPermanent(
          request.userId,
          request.tool,
          request.subject.kind,
          request.subject.key,
          request.subject.display,
        );
      }
      logDecision(request, response.decision);
      return true;
    }
  }

  if (!ctx.mcpReq.envelope) {
    return toolError(
      "CLIENT_ELICITATION_UNSUPPORTED",
      "This MCP client cannot display the required approval form.",
    );
  }

  const decisionEnum = decisionMode === "single_use"
    ? ["allow_once", "deny"]
    : ["allow_once", "allow_session", "allow_permanent", "deny"];
  const payload: ApprovalStatePayload = {
    version: 1,
    tool: request.tool,
    userId: request.userId,
    subjectKey: request.subject.key,
    argsDigest: request.argsDigest,
    nonce: randomUUID(),
    decisionMode,
    ...(request.priorSubjectKeys?.length
      ? { priorSubjectKeys: [...new Set(request.priorSubjectKeys)].slice(0, 10) }
      : {}),
    ...(request.authorizedDirectoryRootsDigest
      ? { authorizedDirectoryRootsDigest: request.authorizedDirectoryRootsDigest }
      : {}),
  };
  const requestState = await mintApprovalState(payload, ctx);
  return inputRequired({
    requestState,
    inputRequests: {
      approval: inputRequired.elicit({
        message: renderMessage(request),
        requestedSchema: {
          type: "object",
          properties: {
            decision: {
              type: "string",
              title: "Authorization",
              enum: decisionEnum,
            },
          },
          required: ["decision"],
        },
      }),
    },
  });
}

export function approvalSummary() {
  return approvalStore.summary();
}
