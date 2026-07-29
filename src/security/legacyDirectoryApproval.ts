import path from "node:path";
import { randomUUID } from "node:crypto";
import type { CallToolResult, ServerContext } from "@modelcontextprotocol/server";
import {
  APPROVAL_TIMEOUT_MS,
  DIRECTORY_APPROVAL_FALLBACK,
  OWNER_USER_ID,
} from "../config.js";
import { isAuthenticated } from "../auth/pinAuth.js";
import { toolError, toolJson } from "../tools/results.js";
import { consumeSignedNonce } from "./approval.js";
import { isInternalApprovalPath } from "./approvalStore.js";
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
  verifyApprovalState,
  type LegacyDirectoryChallengePayload,
} from "./approvalState.js";
import { getRequestUserId } from "./requestContext.js";
import { logger } from "./logger.js";
import type { DirectoryAuthorizationRequest } from "./directoryAuthorization.js";

export type LegacyDirectoryDecision =
  | "allow_once"
  | "allow_session"
  | "allow_permanent"
  | "deny";

export interface LegacyDirectoryMatch {
  userId: string;
  tool: string;
  argsDigest: string;
  rootsDigest: string;
}

interface OnceEntry {
  roots: CanonicalDirectoryRoot[];
  expiresAt: number;
}

function matchKey(match: LegacyDirectoryMatch): string {
  return [match.userId, match.tool, match.argsDigest, match.rootsDigest].join("\u0000");
}

function cloneRoots(roots: CanonicalDirectoryRoot[]): CanonicalDirectoryRoot[] {
  return roots.map((root) => ({ ...root }));
}

export class LegacyDirectoryOnceStore {
  private readonly entries = new Map<string, OnceEntry>();

  remember(
    match: LegacyDirectoryMatch,
    roots: CanonicalDirectoryRoot[],
    expiresAt: number,
  ): void {
    this.cleanup();
    this.entries.set(matchKey(match), { roots: cloneRoots(roots), expiresAt });
  }

  consume(match: LegacyDirectoryMatch): CanonicalDirectoryRoot[] | null {
    this.cleanup();
    const key = matchKey(match);
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.entries.delete(key);
    return cloneRoots(entry.roots);
  }

  private cleanup(now = Date.now()): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}

export const legacyDirectoryOnceStore = new LegacyDirectoryOnceStore();

function validRoots(value: unknown): value is CanonicalDirectoryRoot[] {
  return Array.isArray(value) && value.length > 0 && value.every((root) =>
    root && typeof root === "object" &&
    typeof (root as CanonicalDirectoryRoot).logicalRoot === "string" &&
    path.isAbsolute((root as CanonicalDirectoryRoot).logicalRoot) &&
    typeof (root as CanonicalDirectoryRoot).physicalRoot === "string" &&
    path.isAbsolute((root as CanonicalDirectoryRoot).physicalRoot));
}

function isLegacyPayload(value: unknown): value is LegacyDirectoryChallengePayload {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<LegacyDirectoryChallengePayload>;
  return state.version === 1 && state.kind === "legacy_directory" &&
    typeof state.userId === "string" && typeof state.tool === "string" &&
    typeof state.argsDigest === "string" && typeof state.rootsDigest === "string" &&
    typeof state.nonce === "string" && typeof state.expiresAt === "string" &&
    validRoots(state.roots);
}

function protectedRoots(roots: CanonicalDirectoryRoot[]): boolean {
  return roots.some((root) =>
    isInternalApprovalPath(root.logicalRoot) || isInternalApprovalPath(root.physicalRoot));
}

function fallbackAvailable(userId: string | null): userId is string {
  return DIRECTORY_APPROVAL_FALLBACK === "owner" &&
    Boolean(OWNER_USER_ID) && userId === OWNER_USER_ID;
}

export async function createLegacyDirectoryChallenge(
  ctx: ServerContext,
  request: DirectoryAuthorizationRequest,
  requestedRoots: CanonicalDirectoryRoot[],
): Promise<CallToolResult> {
  if (!fallbackAvailable(request.userId)) {
    return toolError(
      "CLIENT_ELICITATION_UNSUPPORTED",
      "This MCP client cannot display the required directory authorization form.",
    );
  }
  const roots = deduplicateRoots(requestedRoots);
  if (roots.length === 0 || protectedRoots(roots)) {
    return toolError("SENSITIVE_PATH", "The internal approval directory is protected.");
  }
  const expiresAt = new Date(Date.now() + APPROVAL_TIMEOUT_MS).toISOString();
  const payload: LegacyDirectoryChallengePayload = {
    version: 1,
    kind: "legacy_directory",
    userId: request.userId,
    tool: request.tool,
    argsDigest: request.argsDigest,
    rootsDigest: digestDirectoryRoots(roots),
    roots: cloneRoots(roots),
    nonce: randomUUID(),
    expiresAt,
  };
  const challenge = await mintApprovalState(payload, ctx);
  return toolError(
    "DIRECTORY_APPROVAL_REQUIRED",
    "Explicit owner approval is required before retrying this tool.",
    true,
    {
      directoryApproval: {
        challenge,
        tool: request.tool,
        access: request.access,
        directories: roots.map((root) => root.logicalRoot),
        decisions: ["allow_once", "allow_session", "allow_permanent", "deny"],
        expiresAt,
      },
    },
  );
}

export async function submitLegacyDirectoryDecision(
  ctx: ServerContext,
  challenge: string,
  decision: LegacyDirectoryDecision,
  store: DirectoryGrantStore = directoryGrantStore,
  onceStore: LegacyDirectoryOnceStore = legacyDirectoryOnceStore,
): Promise<CallToolResult> {
  const userId = getRequestUserId();
  if (!fallbackAvailable(userId) || !isAuthenticated(userId)) {
    return toolError("APPROVAL_DENIED", "Legacy directory approval is not available for this identity.");
  }
  let verified: unknown;
  try {
    verified = await verifyApprovalState(challenge, ctx);
  } catch {
    return toolError("APPROVAL_DENIED", "Directory approval challenge is invalid.");
  }
  if (!isLegacyPayload(verified) || verified.userId !== userId) {
    return toolError("APPROVAL_DENIED", "Directory approval challenge does not match this identity.");
  }
  const expiry = Date.parse(verified.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= Date.now()) {
    return toolError("DIRECTORY_APPROVAL_EXPIRED", "Directory approval challenge has expired.");
  }
  const roots = deduplicateRoots(verified.roots);
  if (protectedRoots(roots) || digestDirectoryRoots(roots) !== verified.rootsDigest) {
    return toolError("APPROVAL_DENIED", "Directory approval challenge does not match its roots.");
  }
  if (!consumeSignedNonce(verified.nonce)) {
    return toolError("APPROVAL_DENIED", "Directory approval challenge has already been used.");
  }
  if (decision === "deny") {
    logger.info("legacy_directory_decision", {
      toolName: verified.tool,
      decision,
      rootCount: roots.length,
      source: "legacy_owner_fallback",
    });
    return toolError("DIRECTORY_APPROVAL_DENIED", "The owner denied directory authorization.");
  }
  const match: LegacyDirectoryMatch = {
    userId,
    tool: verified.tool,
    argsDigest: verified.argsDigest,
    rootsDigest: verified.rootsDigest,
  };
  if (decision === "allow_once") {
    onceStore.remember(match, roots, expiry);
  } else if (decision === "allow_session") {
    store.rememberSessionBatch(userId, roots);
  } else {
    try {
      store.rememberPermanentBatch(userId, roots);
    } catch {
      return toolError(
        "DIRECTORY_GRANT_PERSIST_FAILED",
        "The permanent directory grant could not be stored.",
      );
    }
  }
  logger.info("legacy_directory_decision", {
    toolName: verified.tool,
    decision,
    rootCount: roots.length,
    source: "legacy_owner_fallback",
  });
  return toolJson({
    ok: true,
    directoryApproval: {
      decision,
      retryTool: verified.tool,
      retryOriginalCall: true,
    },
  });
}

export function consumeLegacyDirectoryOnce(
  match: LegacyDirectoryMatch,
): CanonicalDirectoryRoot[] | null {
  return legacyDirectoryOnceStore.consume(match);
}
