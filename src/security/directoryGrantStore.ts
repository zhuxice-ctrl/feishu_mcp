import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  ALLOWED_DIRS,
  APPROVAL_DATA_DIR,
  OWNER_DEFAULT_DIRS,
  OWNER_USER_ID,
} from "../config.js";
import {
  canonicalizeDirectoryScope,
  deduplicateRoots,
  isInsideDirectory,
  pathKey,
  type CanonicalDirectoryRoot,
} from "./directoryRoots.js";

export type EffectiveRootSource = "static" | "owner_default" | "session" | "permanent";

export interface DirectoryGrantRecord extends CanonicalDirectoryRoot {
  id: string;
  userId: string;
  createdAt: string;
}

export interface EffectiveRoot extends CanonicalDirectoryRoot {
  source: EffectiveRootSource;
}

export interface DirectoryGrantStoreOptions {
  dataDir?: string;
  staticRoots?: CanonicalDirectoryRoot[];
  ownerUserId?: string;
  ownerRoots?: CanonicalDirectoryRoot[];
}

interface DirectoryGrantFile {
  version: 1;
  grants: DirectoryGrantRecord[];
}

function assertUserId(userId: string): void {
  if (typeof userId !== "string" || userId.length === 0) {
    throw new TypeError("userId must be a non-empty string");
  }
}

function validateRoot(value: unknown): CanonicalDirectoryRoot {
  if (!value || typeof value !== "object") {
    throw new TypeError("directory root must be an object");
  }
  const root = value as Partial<CanonicalDirectoryRoot>;
  if (typeof root.logicalRoot !== "string" || !path.isAbsolute(root.logicalRoot)) {
    throw new TypeError("logicalRoot must be an absolute path");
  }
  if (typeof root.physicalRoot !== "string" || !path.isAbsolute(root.physicalRoot)) {
    throw new TypeError("physicalRoot must be an absolute path");
  }
  return {
    logicalRoot: path.normalize(root.logicalRoot),
    physicalRoot: path.normalize(root.physicalRoot),
  };
}

function validateBatch(roots: CanonicalDirectoryRoot[]): CanonicalDirectoryRoot[] {
  if (!Array.isArray(roots)) throw new TypeError("roots must be an array");
  const validated = roots.map(validateRoot);
  return deduplicateRoots(validated);
}

function recordKey(userId: string, physicalRoot: string): string {
  return `${userId}\u0000${pathKey(physicalRoot)}`;
}

function isStrictRecord(value: unknown): value is DirectoryGrantRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = [
    "createdAt",
    "id",
    "logicalRoot",
    "physicalRoot",
    "userId",
  ];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    return false;
  }
  if (typeof record.id !== "string" || record.id.length === 0) return false;
  if (typeof record.userId !== "string" || record.userId.length === 0) return false;
  if (typeof record.createdAt !== "string") return false;
  try {
    if (new Date(record.createdAt).toISOString() !== record.createdAt) return false;
  } catch {
    return false;
  }
  if (typeof record.logicalRoot !== "string" || !path.isAbsolute(record.logicalRoot)) return false;
  if (typeof record.physicalRoot !== "string" || !path.isAbsolute(record.physicalRoot)) return false;
  return true;
}

function parseGrantFile(value: unknown): DirectoryGrantRecord[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const file = value as Record<string, unknown>;
  const keys = Object.keys(file).sort();
  if (keys.length !== 2 || keys[0] !== "grants" || keys[1] !== "version") return null;
  if (file.version !== 1 || !Array.isArray(file.grants)) return null;
  if (!file.grants.every(isStrictRecord)) return null;

  const ids = new Set<string>();
  const grants = new Map<string, DirectoryGrantRecord>();
  for (const item of file.grants) {
    if (ids.has(item.id)) return null;
    ids.add(item.id);
    const normalized = validateRoot(item);
    const record = { ...item, ...normalized };
    const key = recordKey(record.userId, record.physicalRoot);
    if (grants.has(key)) return null;
    grants.set(key, record);
  }
  return [...grants.values()];
}

function sortedRecords(records: ReadonlyMap<string, DirectoryGrantRecord>): DirectoryGrantRecord[] {
  return [...records.values()].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}

export class DirectoryGrantStore {
  readonly dataDir: string;
  readonly filePath: string;
  private readonly staticRoots: CanonicalDirectoryRoot[];
  private readonly ownerUserId: string;
  private readonly ownerRoots: CanonicalDirectoryRoot[];
  private readonly session = new Map<string, CanonicalDirectoryRoot[]>();
  private permanent = new Map<string, DirectoryGrantRecord>();

  constructor(options: DirectoryGrantStoreOptions = {}) {
    this.dataDir = path.resolve(options.dataDir ?? APPROVAL_DATA_DIR);
    this.filePath = path.join(this.dataDir, "directory-grants.json");
    this.staticRoots = validateBatch(options.staticRoots ?? []);
    this.ownerUserId = options.ownerUserId ?? "";
    this.ownerRoots = validateBatch(options.ownerRoots ?? []);
    this.load();
  }

  effectiveRoots(userId: string | null): EffectiveRoot[] {
    const result: EffectiveRoot[] = [];
    const seen = new Set<string>();
    const append = (roots: readonly CanonicalDirectoryRoot[], source: EffectiveRootSource): void => {
      for (const root of roots) {
        const key = pathKey(root.physicalRoot);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({ ...root, source });
      }
    };

    append(this.staticRoots, "static");
    if (userId !== null && userId === this.ownerUserId) {
      append(this.ownerRoots, "owner_default");
    }
    if (userId !== null) {
      append(this.session.get(userId) ?? [], "session");
      append(this.listForUser(userId), "permanent");
    }
    return result;
  }

  hasAccess(userId: string | null, physicalCandidate: string): boolean {
    if (typeof physicalCandidate !== "string" || !path.isAbsolute(physicalCandidate)) return false;
    const candidate = path.normalize(physicalCandidate);
    return this.effectiveRoots(userId).some((root) =>
      isInsideDirectory(candidate, root.physicalRoot)
    );
  }

  rememberSessionBatch(userId: string, roots: CanonicalDirectoryRoot[]): void {
    assertUserId(userId);
    const batch = validateBatch(roots);
    const next = deduplicateRoots([...(this.session.get(userId) ?? []), ...batch]);
    this.session.set(userId, next);
  }

  rememberPermanentBatch(
    userId: string,
    roots: CanonicalDirectoryRoot[],
  ): DirectoryGrantRecord[] {
    assertUserId(userId);
    const batch = validateBatch(roots);
    const next = new Map(this.permanent);
    const records: DirectoryGrantRecord[] = [];
    let changed = false;

    for (const root of batch) {
      const key = recordKey(userId, root.physicalRoot);
      const existing = next.get(key);
      if (existing) {
        records.push({ ...existing });
        continue;
      }
      const record: DirectoryGrantRecord = {
        ...root,
        id: randomUUID(),
        userId,
        createdAt: new Date().toISOString(),
      };
      next.set(key, record);
      records.push({ ...record });
      changed = true;
    }

    if (changed) {
      this.persist(next);
      this.permanent = next;
    }
    return records;
  }

  listForUser(userId: string): DirectoryGrantRecord[] {
    assertUserId(userId);
    return sortedRecords(this.permanent)
      .filter((record) => record.userId === userId)
      .map((record) => ({ ...record }));
  }

  revoke(id: string): boolean {
    const entry = [...this.permanent.entries()].find(([, record]) => record.id === id);
    if (!entry) return false;
    const next = new Map(this.permanent);
    next.delete(entry[0]);
    this.persist(next);
    this.permanent = next;
    return true;
  }

  clear(userId?: string): void {
    if (userId !== undefined) assertUserId(userId);
    const next = new Map(this.permanent);
    for (const [key, record] of next) {
      if (userId === undefined || record.userId === userId) next.delete(key);
    }
    if (next.size !== this.permanent.size) {
      this.persist(next);
      this.permanent = next;
    }
    if (userId === undefined) this.session.clear();
    else this.session.delete(userId);
  }

  summary(): { session: number; permanent: number } {
    let session = 0;
    for (const roots of this.session.values()) session += roots.length;
    return { session, permanent: this.permanent.size };
  }

  private load(): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    } catch {
      return;
    }
    const records = parseGrantFile(parsed);
    if (records === null) return;
    this.permanent = new Map(
      records.map((record) => [recordKey(record.userId, record.physicalRoot), record]),
    );
  }

  private persist(records: ReadonlyMap<string, DirectoryGrantRecord>): void {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const temporary = path.join(
      this.dataDir,
      `.directory-grants-${process.pid}-${randomUUID()}.tmp`,
    );
    const data: DirectoryGrantFile = { version: 1, grants: sortedRecords(records) };
    try {
      const fd = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`, "utf8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, this.filePath);
      try { fs.chmodSync(this.filePath, 0o600); } catch {}
    } finally {
      try { fs.rmSync(temporary, { force: true }); } catch {}
    }
  }
}

const staticRoots = ALLOWED_DIRS.map((root) => canonicalizeDirectoryScope(root, "directory"));
const ownerRoots = OWNER_DEFAULT_DIRS.map((root) => canonicalizeDirectoryScope(root, "directory"));

export const directoryGrantStore = new DirectoryGrantStore({
  dataDir: APPROVAL_DATA_DIR,
  staticRoots,
  ownerUserId: OWNER_USER_ID,
  ownerRoots,
});
