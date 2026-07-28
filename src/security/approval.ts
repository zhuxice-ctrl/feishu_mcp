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
import { mintApprovalState, type ApprovalStatePayload } from "./approvalState.js";
import { toolError } from "../tools/results.js";

export interface ApprovalRequest {
  tool: string;
  userId: string | null;
  subject: { kind: ApprovalSubjectKind; key: string; display: string };
  argsDigest: string;
  reasons: string[];
}

export type ApprovalOutcome = true | CallToolResult | InputRequiredResult;

const decisionSchema = z.object({
  decision: z.enum(["allow_once", "allow_session", "allow_permanent", "deny"]),
});
const usedNonces = new Map<string, number>();

function consumeNonce(nonce: string): boolean {
  const now = Date.now();
  if (usedNonces.has(nonce)) return false;
  if (usedNonces.size >= 4_096) {
    for (const [key, usedAt] of usedNonces) {
      if (now - usedAt > APPROVAL_TIMEOUT_MS) usedNonces.delete(key);
    }
  }
  while (usedNonces.size >= 10_000) {
    const oldest = usedNonces.keys().next().value as string | undefined;
    if (!oldest) break;
    usedNonces.delete(oldest);
  }
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

function matches(payload: ApprovalStatePayload, request: ApprovalRequest): boolean {
  return payload.version === 1 && payload.tool === request.tool &&
    payload.userId === request.userId && payload.subjectKey === request.subject.key &&
    payload.argsDigest === request.argsDigest;
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
  if (approvalStore.has(request.userId, request.tool, request.subject.key)) {
    logDecision(request, "remembered");
    return true;
  }

  const state = ctx.mcpReq.requestState<ApprovalStatePayload>();
  if (state) {
    if (!matches(state, request)) {
      return toolError("APPROVAL_DENIED", "Approval state does not match this operation.");
    }
    if (usedNonces.has(state.nonce)) {
      return toolError("APPROVAL_DENIED", "Approval state has already been used.");
    }
    const response = acceptedContent(ctx.mcpReq.inputResponses, "approval", decisionSchema);
    if (!response) {
      return toolError("APPROVAL_DENIED", "Approval was declined, cancelled, or unavailable.");
    }
    if (!consumeNonce(state.nonce)) {
      return toolError("APPROVAL_DENIED", "Approval state has already been used.");
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

  if (!ctx.mcpReq.envelope) {
    return toolError(
      "CLIENT_ELICITATION_UNSUPPORTED",
      "This MCP client cannot display the required approval form.",
    );
  }

  const payload: ApprovalStatePayload = {
    version: 1,
    tool: request.tool,
    userId: request.userId,
    subjectKey: request.subject.key,
    argsDigest: request.argsDigest,
    nonce: randomUUID(),
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
              enum: ["allow_once", "allow_session", "allow_permanent", "deny"],
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
