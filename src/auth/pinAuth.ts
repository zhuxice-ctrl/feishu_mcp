import crypto from "node:crypto";
import {
  AUTH_MAX_USERS,
  AUTH_MODE,
  AUTH_MULTI_USER,
  AUTH_PIN,
  type AuthMode,
} from "../config.js";

interface AuthRecord {
  authedAt: number;
  lastSeenAt: number;
}

const activeUsers = new Map<string, AuthRecord>();
let serverPin: string | null = null;

export interface AuthResult {
  ok: boolean;
  error?: string;
  evictedUsers?: string[];
}

export function initPin(): string | null {
  if (AUTH_MODE !== "pin") return null;
  if (!serverPin) serverPin = AUTH_PIN || crypto.randomBytes(24).toString("base64url");
  return serverPin;
}

export function getPin(): string | null {
  return serverPin;
}

function safeEqual(candidate: string, expected: string): boolean {
  const candidateBuffer = Buffer.from(candidate, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (candidateBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(candidateBuffer, expectedBuffer);
}

function touch(userId: string): string[] {
  const now = Date.now();
  const existing = activeUsers.get(userId);
  if (existing) {
    existing.lastSeenAt = now;
    return [];
  } else {
    const evicted = evictIfNeeded();
    activeUsers.set(userId, { authedAt: now, lastSeenAt: now });
    return evicted;
  }
}

function evictIfNeeded(): string[] {
  const limit = AUTH_MULTI_USER ? AUTH_MAX_USERS : 1;
  const evicted: string[] = [];
  while (activeUsers.size >= limit) {
    let oldestId: string | null = null;
    let oldestSeen = Number.POSITIVE_INFINITY;
    for (const [userId, record] of activeUsers) {
      if (record.lastSeenAt < oldestSeen) {
        oldestId = userId;
        oldestSeen = record.lastSeenAt;
      }
    }
    if (oldestId === null) break;
    activeUsers.delete(oldestId);
    evicted.push(oldestId);
  }
  return evicted;
}

export function attemptAuth(pin: string | undefined, userId: string | null): AuthResult {
  if (AUTH_MODE === "none") return { ok: true, evictedUsers: [] };
  if (!userId) return { ok: false, error: "Missing request user identity" };
  if (AUTH_MODE === "header") {
    return { ok: true, evictedUsers: touch(userId) };
  }

  const expected = initPin();
  if (!expected) return { ok: false, error: "PIN authentication is not initialized" };
  if (!pin) return { ok: false, error: "Missing pin argument" };
  if (!safeEqual(pin, expected)) return { ok: false, error: "Invalid PIN" };

  const evictedUsers = touch(userId);
  return { ok: true, evictedUsers };
}

export function isAuthenticated(userId: string | null): boolean {
  if (AUTH_MODE === "none") return true;
  if (!userId) return false;
  if (AUTH_MODE === "header") {
    touch(userId);
    return true;
  }
  if (!activeUsers.has(userId)) return false;
  touch(userId);
  return true;
}

export function getActiveUsers(): string[] {
  return [...activeUsers.keys()];
}

export function getMode(): AuthMode {
  return AUTH_MODE;
}

export function summary(): object {
  return {
    mode: AUTH_MODE,
    required: AUTH_MODE !== "none",
    multiUser: AUTH_MULTI_USER,
    activeUsers: activeUsers.size,
    maxUsers: AUTH_MULTI_USER ? AUTH_MAX_USERS : 1,
  };
}
