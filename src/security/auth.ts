/**
 * Bearer Token authentication — Express middleware.
 *
 * Implements a simple Bearer Token check against MCP_AUTH_TOKEN.
 * When AUTH_ENABLED is false (no token configured), the middleware
 * is a pass-through (useful for local development).
 */

import type { Request, Response, NextFunction } from "express";
import { AUTH_ENABLED, MCP_AUTH_TOKEN } from "../config.js";
import { checkRateLimit } from "./rateLimit.js";

/**
 * Extract the Bearer token from the Authorization header.
 */
function extractToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/**
 * Combined auth + rate-limit middleware for the MCP endpoint.
 *
 * 1. If auth is enabled, validates the Bearer token.
 * 2. Rate-limits requests per token (or per IP if no token).
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

  // Attach rate-limit headers
  res.set("X-RateLimit-Limit", String(60));
  res.set("X-RateLimit-Remaining", String(rateLimitResult.remaining));

  next();
}
