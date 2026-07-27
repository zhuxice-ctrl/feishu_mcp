/**
 * Per-request context — propagates the authenticated token to tool handlers
 * via AsyncLocalStorage.
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
 * AsyncLocalStorage provides a real per-async-context store.  The auth
 * middleware in `index.ts` calls `runWithToken(token, () => handler.fetch(req))`
 * so every await downstream sees the correct token, no matter how many
 * other requests are in flight.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  /** Raw Bearer token from the Authorization header (already validated). */
  token: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Run `fn` inside a request context.  The token is visible to any
 * AsyncLocalStorage-aware code called from `fn` (including all tool handlers).
 */
export function runWithToken<T>(token: string, fn: () => T | Promise<T>): T | Promise<T> {
  return storage.run({ token }, fn);
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
