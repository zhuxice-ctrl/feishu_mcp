import { randomUUID } from "node:crypto";
import {
  acceptedContent,
  inputRequired,
  type CallToolResult,
  type InputRequiredResult,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  directoryGrantStore,
  type DirectoryGrantStore,
} from "./directoryGrantStore.js";
import {
  deduplicateRoots,
  digestDirectoryRoots,
  type CanonicalDirectoryRoot,
} from "./directoryRoots.js";
import {
  mintApprovalState,
  type DirectoryApprovalStatePayload,
} from "./approvalState.js";
import { consumeSignedNonce } from "./approval.js";
import { toolError } from "../tools/results.js";

export interface DirectoryAuthorizationRequest {
  tool: string;
  userId: string | null;
  argsDigest: string;
  access: "read" | "write" | "search" | "command" | "git" | "patch";
  roots: CanonicalDirectoryRoot[];
}

export interface DirectoryAuthorizationAllowed {
  allowed: true;
  roots: CanonicalDirectoryRoot[];
  rootsDigest: string;
  decision: "allow_once" | "allow_session" | "allow_permanent" | "remembered";
}

export type DirectoryAuthorizationOutcome =
  | DirectoryAuthorizationAllowed
  | CallToolResult
  | InputRequiredResult;

const directoryDecisionSchema = z.object({
  decision: z.enum(["allow_once", "allow_session", "allow_permanent", "deny"]),
});

function canonicalRoots(roots: CanonicalDirectoryRoot[]): CanonicalDirectoryRoot[] {
  return deduplicateRoots(roots).map((root) => ({
    logicalRoot: root.logicalRoot,
    physicalRoot: root.physicalRoot,
  }));
}

function isDirectoryState(value: unknown): value is DirectoryApprovalStatePayload {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<DirectoryApprovalStatePayload>;
  return state.version === 1 && state.kind === "directory" &&
    typeof state.tool === "string" && typeof state.userId === "string" &&
    typeof state.argsDigest === "string" && typeof state.rootsDigest === "string" &&
    typeof state.nonce === "string";
}

function matches(
  state: DirectoryApprovalStatePayload,
  request: DirectoryAuthorizationRequest,
  rootsDigest: string,
): boolean {
  return state.tool === request.tool && state.userId === request.userId &&
    state.argsDigest === request.argsDigest && state.rootsDigest === rootsDigest;
}

function renderDirectoryMessage(request: DirectoryAuthorizationRequest): string {
  return [
    `Authorize directory access for ${request.tool}?`,
    `Access type: ${request.access}`,
    ...request.roots.map((root, index) => `Directory ${index + 1}: ${root.logicalRoot}`),
    "Allow once: this original tool call only.",
    "Allow session: until this MCP process stops.",
    "Allow permanently: survives restarts until locally revoked.",
    "Deny: do not run the operation.",
    "Permanent approval expands local filesystem access for this user.",
  ].join("\n");
}

export async function requestDirectoryAuthorization(
  ctx: ServerContext,
  request: DirectoryAuthorizationRequest,
  store: DirectoryGrantStore = directoryGrantStore,
): Promise<DirectoryAuthorizationOutcome> {
  const roots = canonicalRoots(request.roots);
  const rootsDigest = digestDirectoryRoots(roots);

  if (request.userId === null) {
    return toolError("DIRECTORY_IDENTITY_REQUIRED", "A stable request identity is required for directory authorization.");
  }

  if (roots.every((root) => store.hasAccess(request.userId, root.physicalRoot))) {
    return { allowed: true, roots, rootsDigest, decision: "remembered" };
  }

  const state = ctx.mcpReq.requestState<unknown>();
  if (state !== undefined) {
    if (!isDirectoryState(state) || !matches(state, request, rootsDigest)) {
      return toolError("APPROVAL_DENIED", "Directory approval state does not match this operation.");
    }
    if (!consumeSignedNonce(state.nonce)) {
      return toolError("APPROVAL_DENIED", "Directory approval state has already been used.");
    }
    const response = acceptedContent(
      ctx.mcpReq.inputResponses,
      "directory_approval",
      directoryDecisionSchema,
    );
    if (!response || response.decision === "deny") {
      return toolError(
        "DIRECTORY_APPROVAL_DENIED",
        "Directory authorization was denied, cancelled, or unavailable.",
      );
    }
    if (response.decision === "allow_session") {
      store.rememberSessionBatch(request.userId, roots);
    } else if (response.decision === "allow_permanent") {
      try {
        store.rememberPermanentBatch(request.userId, roots);
      } catch {
        return toolError(
          "DIRECTORY_GRANT_PERSIST_FAILED",
          "The permanent directory grant could not be stored.",
        );
      }
    }
    return { allowed: true, roots, rootsDigest, decision: response.decision };
  }

  if (!ctx.mcpReq.envelope) {
    return toolError(
      "CLIENT_ELICITATION_UNSUPPORTED",
      "This MCP client cannot display the required directory authorization form.",
    );
  }

  const payload: DirectoryApprovalStatePayload = {
    version: 1,
    kind: "directory",
    tool: request.tool,
    userId: request.userId,
    argsDigest: request.argsDigest,
    rootsDigest,
    nonce: randomUUID(),
  };
  const requestState = await mintApprovalState(payload, ctx);
  return inputRequired({
    requestState,
    inputRequests: {
      directory_approval: inputRequired.elicit({
        message: renderDirectoryMessage({ ...request, roots }),
        requestedSchema: {
          type: "object",
          properties: {
            decision: {
              type: "string",
              title: "Directory authorization",
              enum: ["allow_once", "allow_session", "allow_permanent", "deny"],
            },
          },
          required: ["decision"],
        },
      }),
    },
  });
}
