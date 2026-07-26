/**
 * Soft-delete / recycle bin mechanism.
 *
 * Instead of permanently deleting files, `move_file` or `write_file` (overwrite)
 * operations that would destroy existing data move the original to a `.trash`
 * directory inside the same allowed root, preserving it for TRASH_RETENTION_DAYS.
 *
 * A periodic cleanup purges trash entries older than the retention period.
 */

import fs from "node:fs";
import path from "node:path";
import { TRASH_DIR_NAME, TRASH_RETENTION_DAYS } from "../config.js";
import { ALLOWED_DIRS } from "../config.js";

/**
 * Find or create the .trash directory for a given file path's root.
 */
function getTrashDir(filePath: string): string | null {
  for (const root of ALLOWED_DIRS) {
    const normalizedRoot = path.normalize(root) + path.sep;
    const normalizedFile = path.normalize(filePath) + path.sep;
    if (normalizedFile.startsWith(normalizedRoot)) {
      const trashPath = path.join(root, TRASH_DIR_NAME);
      try {
        fs.mkdirSync(trashPath, { recursive: true });
      } catch {
        // ignore — may already exist or be read-only
      }
      return trashPath;
    }
  }
  return null;
}

/**
 * Move a file/directory to the trash before it gets overwritten or removed.
 * Returns the trash path on success, or null if the source doesn't exist.
 */
export function moveToTrash(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;

  const trashDir = getTrashDir(filePath);
  if (!trashDir) return null;

  const baseName = path.basename(filePath);
  const timestamp = Date.now();
  const trashedName = `${timestamp}_${baseName}`;
  const trashedPath = path.join(trashDir, trashedName);

  try {
    fs.renameSync(filePath, trashedPath);
    return trashedPath;
  } catch {
    // rename can fail across drives — try copy + delete
    try {
      fs.copyFileSync(filePath, trashedPath);
      fs.unlinkSync(filePath);
      return trashedPath;
    } catch {
      return null;
    }
  }
}

/**
 * Purge trash entries older than TRASH_RETENTION_DAYS.
 * Called periodically by the server.
 */
export function cleanupTrash(): number {
  let purgedCount = 0;
  const now = Date.now();
  const maxAgeMs = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  for (const root of ALLOWED_DIRS) {
    const trashDir = path.join(root, TRASH_DIR_NAME);
    if (!fs.existsSync(trashDir)) continue;

    let entries: string[];
    try {
      entries = fs.readdirSync(trashDir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(trashDir, entry);
      try {
        const stat = fs.statSync(fullPath);
        if (now - stat.mtimeMs > maxAgeMs) {
          fs.rmSync(fullPath, { recursive: true, force: true });
          purgedCount++;
        }
      } catch {
        // skip unreadable entries
      }
    }
  }

  return purgedCount;
}
