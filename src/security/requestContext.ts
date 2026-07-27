/**
 * Per-request context — propagates transport credentials and request identity
 * to tool handlers via AsyncLocalStorage.
 *
 * Why this exists
 * ---------------
 * The previous design used a module-level `let currentToken` that the auth
 * middleware wrote and tool handlers read.  Under concurrent requests the
 * variable was a race: handler A's token would frequently be attributed to
 * handler B's tool call in the audit log, and the value never reset between
 * requests, so a later unauthenticated request could inherit the last
 * successful token.
 *
 * AsyncLocalStorage provides a real per-async-context store. The route in
 * `index.ts` wraps `handler.fetch()` in `runWithRequestContext()` so every
 * await downstream sees the correct token and identity, no matter how many
 * other requests are in flight.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { Request } from "express";
import {
  AUTH_EMAIL_HEADER,
  AUTH_USER_HEADER,
  AUTH_USER_QUERY_PARAM,
} from "../config.js";

export interface RequestContext {
  /** Raw Bearer token from the Authorization header (already validated). */
  token: string;
  /** Request identity supplied by the configured trusted header/query source. */
  userId: string | null;
  /** Optional email supplied by the configured trusted header. */
  email: string | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

function readIdentityValue(value: unknown): string | null {
  const firstValue = Array.isArray(value) ? value[0] : value;
  if (typeof firstValue !== "string") return null;
  const trimmed = firstValue.trim();
  return trimmed || null;
}

export function extractRequestContext(req: Request): RequestContext {
  const headerUserId = readIdentityValue(req.get(AUTH_USER_HEADER));
  const queryUserId = AUTH_USER_QUERY_PARAM
    ? readIdentityValue(req.query[AUTH_USER_QUERY_PARAM])
    : null;
  return {
    token: (req as Request & { authToken?: string }).authToken ?? "",
    userId: headerUserId ?? queryUserId,
    email: readIdentityValue(req.get(AUTH_EMAIL_HEADER)),
  };
}

/**
 * Run `fn` inside a request context visible to all downstream tool handlers.
 */
export function runWithRequestContext<T>(
  context: RequestContext,
  fn: () => T | Promise<T>
): T | Promise<T> {
  return storage.run(context, fn);
}

/**
 * Read the current request's token.  Returns "" when called outside any
 * request context (e.g. from a startup hook or background interval).
 *
 * Intended callers: the audit logger, which records a sha256(token)[:12]
 * hash so log files never store raw credentials.
 */
export function getRequestToken(): string {
  const ctx = storage.getStore();
  return ctx?.token ?? "";
}

export function getRequestUserId(): string | null {
  return storage.getStore()?.userId ?? null;
}

export function getRequestEmail(): string | null {
  return storage.getStore()?.email ?? null;
}
