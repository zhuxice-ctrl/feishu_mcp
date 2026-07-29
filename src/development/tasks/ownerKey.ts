/**
 * Non-reversible owner key for development tasks.
 *
 * The raw owner user ID is never persisted to task metadata. Instead we store
 * a full HMAC-SHA256 derived from the shared approval-state secret and the
 * canonical owner ID. The digest is used only to scope task queries to the
 * owning identity; it cannot be reversed to recover the user ID.
 */

import { createHmac } from "node:crypto";
import { APPROVAL_STATE_SECRET } from "../../config.js";

export function developmentOwnerKey(userId: string): string {
  if (!APPROVAL_STATE_SECRET) {
    throw new Error("APPROVAL_STATE_SECRET is required for development tasks");
  }
  if (!userId) {
    throw new Error("developmentOwnerKey requires a non-empty owner ID");
  }
  return createHmac("sha256", APPROVAL_STATE_SECRET).update(userId, "utf8").digest("hex");
}
