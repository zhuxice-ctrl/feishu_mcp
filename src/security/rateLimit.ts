/**
 * Sliding-window rate limiter — per-token (or per-IP) request throttling.
 *
 * Each unique key gets a rolling window of timestamps. Requests exceeding
 * RATE_LIMIT_PER_MIN within the last 60 seconds are rejected.
 */

import { RATE_LIMIT_PER_MIN } from "../config.js";

interface RateLimitEntry {
  timestamps: number[];
}

const store = new Map<string, RateLimitEntry>();
const WINDOW_MS = 60_000; // 1 minute

// Periodic cleanup — remove stale entries every 5 minutes
const CLEANUP_INTERVAL_MS = 5 * 60_000;
let lastCleanup = Date.now();

function cleanup(): void {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;
  for (const [key, entry] of store) {
    entry.timestamps = entry.timestamps.filter((t) => now - t < WINDOW_MS);
    if (entry.timestamps.length === 0) {
      store.delete(key);
    }
  }
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number; // ms timestamp when the oldest request expires
}

/**
 * Check whether a request from `key` should be allowed.
 * Call this on every MCP request to enforce the rate limit.
 */
export function checkRateLimit(key: string): RateLimitResult {
  cleanup();
  const now = Date.now();
  const cutoff = now - WINDOW_MS;

  let entry = store.get(key);
  if (!entry) {
    entry = { timestamps: [] };
    store.set(key, entry);
  }

  // Prune old timestamps
  entry.timestamps = entry.timestamps.filter((t) => t > cutoff);

  if (entry.timestamps.length >= RATE_LIMIT_PER_MIN) {
    const oldest = entry.timestamps[0];
    return {
      allowed: false,
      remaining: 0,
      resetAt: oldest + WINDOW_MS,
    };
  }

  entry.timestamps.push(now);
  return {
    allowed: true,
    remaining: RATE_LIMIT_PER_MIN - entry.timestamps.length,
    resetAt: 0,
  };
}
