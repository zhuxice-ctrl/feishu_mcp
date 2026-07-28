import { randomUUID } from "node:crypto";
import {
  acceptedContent,
  inputRequired,
  inputResponse,
  type McpServer,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { getRequestUserId } from "../security/requestContext.js";
import {
  consumeSignedNonce,
  digestArguments,
} from "../security/approval.js";
import {
  mintApprovalState,
  type ApprovalStatePayload,
} from "../security/approvalState.js";
import { authorizeToolCall } from "../security/toolAccess.js";
import { toolError, toolJson } from "./results.js";

interface AskUserArgs {
  question: string;
  options?: string[];
  context?: string;
  timeout?: number;
}

function subjectKey(args: AskUserArgs): string {
  return digestArguments({ question: args.question, options: args.options ?? [], context: args.context ?? "" });
}

function matches(state: ApprovalStatePayload, args: AskUserArgs): boolean {
  return state.version === 1 && state.tool === "ask_user" && state.userId === getRequestUserId() &&
    state.subjectKey === subjectKey(args) && state.argsDigest === digestArguments(args);
}

export async function askUser(args: AskUserArgs, ctx: ServerContext) {
  const options = [...new Set((args.options ?? []).map((item) => item.trim()).filter(Boolean))].slice(0, 10);
  const normalized = { ...args, ...(options.length ? { options } : { options: undefined }) };
  const state = ctx.mcpReq.requestState<ApprovalStatePayload>();
  if (state) {
    if (!matches(state, normalized)) return toolError("APPROVAL_DENIED", "Question state does not match this request.");
    if (!consumeSignedNonce(state.nonce)) return toolError("APPROVAL_DENIED", "Question state has already been used.");
    const response = inputResponse(ctx.mcpReq.inputResponses, "answer");
    if (response.kind === "elicit" && response.action === "decline") {
      return toolJson({ ok: true, answered: false, reason: "declined" });
    }
    if (response.kind === "elicit" && response.action === "cancel") {
      return toolJson({ ok: true, answered: false, reason: "cancelled" });
    }
    if (response.kind !== "elicit" || response.action !== "accept") {
      return toolJson({ ok: true, answered: false, reason: "timeout" });
    }
    const schema = options.length
      ? z.object({ answer: z.enum(options as [string, ...string[]]) })
      : z.object({ answer: z.string().trim().min(1).max(4_000) });
    const content = acceptedContent(ctx.mcpReq.inputResponses, "answer", schema);
    if (!content) return toolError("INVALID_ARGUMENT", "The submitted answer is invalid.");
    const selectedIndex = options.indexOf(content.answer);
    return toolJson({
      ok: true,
      answered: true,
      answer: content.answer,
      ...(selectedIndex >= 0 ? { selectedIndex } : {}),
    });
  }
  if (!ctx.mcpReq.envelope) {
    return toolError("CLIENT_ELICITATION_UNSUPPORTED", "This MCP client cannot display a supplemental-information form.");
  }
  const payload: ApprovalStatePayload = {
    version: 1,
    tool: "ask_user",
    userId: getRequestUserId(),
    subjectKey: subjectKey(normalized),
    argsDigest: digestArguments(normalized),
    nonce: randomUUID(),
  };
  const requestState = await mintApprovalState(payload, ctx);
  const requestedSchema = options.length
    ? {
        type: "object" as const,
        properties: { answer: { type: "string" as const, title: "Select an answer", enum: options } },
        required: ["answer"],
      }
    : {
        type: "object" as const,
        properties: { answer: { type: "string" as const, title: "Your answer", minLength: 1, maxLength: 4_000 } },
        required: ["answer"],
      };
  return inputRequired({
    requestState,
    inputRequests: {
      answer: inputRequired.elicit({
        message: [args.question, args.context ? `Context: ${args.context}` : ""].filter(Boolean).join("\n"),
        requestedSchema,
      }),
    },
  });
}

export function registerAskUserTool(server: McpServer): void {
  server.registerTool("ask_user", {
    description: "Ask the user for text or a choice in a Feishu supplemental-information form.",
    inputSchema: {
      question: z.string().trim().min(1).max(4_000),
      options: z.array(z.string().trim().min(1).max(500)).max(10).optional(),
      context: z.string().max(4_000).optional(),
      timeout: z.number().int().positive().optional(),
    },
  }, async (args, ctx) => authorizeToolCall("ask_user", args) ?? askUser(args, ctx));
}
