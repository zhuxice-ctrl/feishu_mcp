/**
 * Bearer Token authentication — Express middleware.
 *
 * Implements a simple Bearer Token check against MCP_AUTH_TOKEN.
 * When AUTH_ENABLED is false (no token configured), the middleware
 * is a pass-through (useful for local development).
 */

import type { Request, Response, NextFunction } from "express";
import {
  AUTH_EMAIL_HEADER,
  AUTH_ENABLED,
  AUTH_USER_HEADER,
  MCP_AUTH_TOKEN,
  RATE_LIMIT_PER_MIN,
} from "../config.js";
import { checkRateLimit } from "./rateLimit.js";
import { logger } from "./logger.js";

const CORS_HEADERS = [
  "Content-Type",
  "Authorization",
  "MCP-Protocol-Version",
  "MCP-Method",
  "MCP-Name",
  "Mcp-Session-Id",
  AUTH_USER_HEADER,
  AUTH_EMAIL_HEADER,
].reduce<string[]>((headers, header) => {
  const trimmed = header.trim();
  if (trimmed && !headers.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) {
    headers.push(trimmed);
  }
  return headers;
}, []);

/**
 * Extract the Bearer token from the Authorization header.
 */
export function extractToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export function corsPreflight(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  res.set("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") {
    res.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.set("Access-Control-Allow-Headers", CORS_HEADERS.join(", "));
    res.status(204).end();
    return;
  }
  next();
}

/**
 * Combined auth + rate-limit middleware for the MCP endpoint.
 *
 * 1. If auth is enabled, validates the Bearer token.
 * 2. Rate-limits requests per token (or per IP if no token).
 *
 * On success the validated token is forwarded to `next()` so the route
 * handler can include it in the AsyncLocalStorage request context.
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
      logger.warn("transport_authentication_failed", { ip: req.ip });
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
    logger.warn("rate_limit_exceeded", {
      ip: req.ip,
      bearerAuthenticated: Boolean(token),
    });
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
