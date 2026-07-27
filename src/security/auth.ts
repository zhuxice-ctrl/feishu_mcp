/**
 * Bearer Token authentication — Express middleware.
 *
 * Implements a simple Bearer Token check against MCP_AUTH_TOKEN.
 * When AUTH_ENABLED is false (no token configured), the middleware
 * is a pass-through (useful for local development).
 */

import type { Request, Response, NextFunction } from "express";
import { AUTH_ENABLED, MCP_AUTH_TOKEN, RATE_LIMIT_PER_MIN } from "../config.js";
import { checkRateLimit } from "./rateLimit.js";

/**
 * Extract the Bearer token from the Authorization header.
 */
export function extractToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/**
 * Combined auth + rate-limit middleware for the MCP endpoint.
 *
 * 1. If auth is enabled, validates the Bearer token.
 * 2. Rate-limits requests per token (or per IP if no token).
 *
 * On success the validated token is forwarded to `next()` so the route
 * handler can wrap the rest of the request lifecycle in runWithToken().
 */
export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const token = extractToken(req.headers.authorization);

  // --- Auth check ---
  if (AUTH_ENABLED) {
    if (!token || token !== MCP_AUTH_TOKEN) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message: "Unauthorized: invalid or missing Bearer token",
        },
        id: null,
      });
      return;
    }
  }

  // --- Rate limit check ---
  const rateLimitKey = token || req.ip || "unknown";
  const rateLimitResult = checkRateLimit(rateLimitKey);

  if (!rateLimitResult.allowed) {
    res.set("Retry-After", String(Math.ceil((rateLimitResult.resetAt - Date.now()) / 1000)));
    res.status(429).json({
      jsonrpc: "2.0",
      error: {
        code: -32002,
        message: "Rate limit exceeded. Too many requests.",
      },
      id: null,
    });
      return;
  }

  // Attach rate-limit headers (limit reflects the configured value, not a
  // hardcoded 60 — a previous version drifted from RATE_LIMIT_PER_MIN).
  res.set("X-RateLimit-Limit", String(RATE_LIMIT_PER_MIN));
  res.set("X-RateLimit-Remaining", String(rateLimitResult.remaining));

  // Stash the validated token on the request for the route handler to pick up
  // and propagate via AsyncLocalStorage (see security/requestContext.ts).
  (req as Request & { authToken?: string }).authToken = token || "";

  next();
}
