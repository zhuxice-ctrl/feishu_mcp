import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { APPROVAL_DATA_DIR } from "../config.js";

export type ApprovalSubjectKind = "command" | "origin" | "path" | "paths";

export interface StoredApproval {
  id: string;
  userId: string;
  tool: string;
  subjectKind: ApprovalSubjectKind;
  subjectKey: string;
  display: string;
  createdAt: string;
}

interface StoreFile {
  version: 1;
  approvals: StoredApproval[];
}

function identity(userId: string | null): string {
  return userId ?? "__anonymous__";
}

function grantKey(userId: string | null, tool: string, subjectKey: string): string {
  return `${identity(userId)}\u0000${tool}\u0000${subjectKey}`;
}

export class ApprovalStore {
  readonly dataDir: string;
  readonly filePath: string;
  readonly keyPath: string;
  private readonly session = new Set<string>();
  private permanent = new Map<string, StoredApproval>();

  constructor(dataDir = APPROVAL_DATA_DIR) {
    this.dataDir = path.resolve(dataDir);
    this.filePath = path.join(this.dataDir, "approvals.json");
    this.keyPath = path.join(this.dataDir, "approval.key");
    this.load();
  }

  has(userId: string | null, tool: string, subjectKey: string): boolean {
    const key = grantKey(userId, tool, subjectKey);
    return this.session.has(key) || this.permanent.has(key);
  }

  rememberSession(userId: string | null, tool: string, subjectKey: string): void {
    this.session.add(grantKey(userId, tool, subjectKey));
  }

  rememberPermanent(
    userId: string | null,
    tool: string,
    subjectKind: ApprovalSubjectKind,
    subjectKey: string,
    display: string,
  ): StoredApproval {
    const key = grantKey(userId, tool, subjectKey);
    const existing = this.permanent.get(key);
    if (existing) return existing;
    const record: StoredApproval = {
      id: randomUUID(),
      userId: identity(userId),
      tool,
      subjectKind,
      subjectKey,
      display,
      createdAt: new Date().toISOString(),
    };
    this.permanent.set(key, record);
    this.persist();
    return record;
  }

  list(): StoredApproval[] {
    return [...this.permanent.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  revoke(id: string): boolean {
    const entry = [...this.permanent.entries()].find(([, value]) => value.id === id);
    if (!entry) return false;
    this.permanent.delete(entry[0]);
    this.persist();
    return true;
  }

  clear(): void {
    this.permanent.clear();
    this.session.clear();
    this.persist();
  }

  summary(): { session: number; permanent: number } {
    return { session: this.session.size, permanent: this.permanent.size };
  }

  isInternalPath(candidate: string): boolean {
    const resolved = path.resolve(candidate);
    const relative = path.relative(this.dataDir, resolved);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }

  private load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<StoreFile>;
      if (parsed.version !== 1 || !Array.isArray(parsed.approvals)) return;
      for (const item of parsed.approvals) {
        if (!item || typeof item.id !== "string" || typeof item.userId !== "string" ||
            typeof item.tool !== "string" || typeof item.subjectKey !== "string" ||
            typeof item.display !== "string" || typeof item.createdAt !== "string" ||
            !["command", "origin", "path", "paths"].includes(item.subjectKind)) continue;
        this.permanent.set(grantKey(item.userId, item.tool, item.subjectKey), item);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private persist(): void {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const temporary = path.join(this.dataDir, `.approvals-${process.pid}-${randomUUID()}.tmp`);
    const data: StoreFile = { version: 1, approvals: this.list() };
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

export const approvalStore = new ApprovalStore();

export function isInternalApprovalPath(candidate: string): boolean {
  return approvalStore.isInternalPath(candidate);
}
