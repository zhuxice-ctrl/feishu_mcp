export type PatchLine = { type: "add" | "remove" | "context"; content: string };
export interface StructuredHunk { anchor: string; lines: PatchLine[] }
export type PatchOperation =
  | { kind: "add"; path: string; content: string }
  | { kind: "update"; path: string; moveTo?: string; hunks: StructuredHunk[] }
  | { kind: "delete"; path: string };
export interface UnifiedHunk {
  oldStart: number; oldCount: number; newStart: number; newCount: number; lines: PatchLine[];
}

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";

export function detectPatchFormat(patch: string): "structured" | "unified" {
  return patch.includes(BEGIN) ? "structured" : "unified";
}

export function parseStructuredPatch(patch: string): PatchOperation[] {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  let index = lines.findIndex((line) => line.trim() === BEGIN);
  if (index === -1) throw new Error(`Structured patch is missing "${BEGIN}".`);
  index += 1;
  const operations: PatchOperation[] = [];
  let ended = false;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === END) { ended = true; break; }
    if (!line.trim()) { index += 1; continue; }
    let match = /^\*\*\* Add File:\s*(.+?)\s*$/.exec(line);
    if (match) {
      const target = match[1];
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith("*** ")) {
        if (lines[index].startsWith("+")) body.push(lines[index].slice(1));
        else if (!lines[index].trim()) body.push("");
        else throw new Error(`Add File ${target} content lines must start with +.`);
        index += 1;
      }
      operations.push({ kind: "add", path: target, content: body.length ? `${body.join("\n")}\n` : "" });
      continue;
    }
    match = /^\*\*\* Delete File:\s*(.+?)\s*$/.exec(line);
    if (match) { operations.push({ kind: "delete", path: match[1] }); index += 1; continue; }
    match = /^\*\*\* Update File:\s*(.+?)\s*$/.exec(line);
    if (match) {
      const target = match[1];
      index += 1;
      const move = index < lines.length ? /^\*\*\* Move to:\s*(.+?)\s*$/.exec(lines[index]) : null;
      if (move) index += 1;
      const hunks: StructuredHunk[] = [];
      let current: StructuredHunk | null = null;
      while (index < lines.length && !lines[index].startsWith("*** ")) {
        const bodyLine = lines[index];
        if (bodyLine.startsWith("@@")) {
          current = { anchor: bodyLine.slice(2).trim(), lines: [] };
          hunks.push(current);
          index += 1;
          continue;
        }
        if (!current) { current = { anchor: "", lines: [] }; hunks.push(current); }
        if (bodyLine.startsWith("+")) current.lines.push({ type: "add", content: bodyLine.slice(1) });
        else if (bodyLine.startsWith("-")) current.lines.push({ type: "remove", content: bodyLine.slice(1) });
        else if (!bodyLine.startsWith("\\")) {
          current.lines.push({ type: "context", content: bodyLine.startsWith(" ") ? bodyLine.slice(1) : bodyLine });
        }
        index += 1;
      }
      if (!hunks.length) throw new Error(`Update File ${target} has no hunks.`);
      operations.push({ kind: "update", path: target, ...(move ? { moveTo: move[1] } : {}), hunks });
      continue;
    }
    throw new Error(`Unrecognized patch instruction: ${line.slice(0, 100)}`);
  }
  if (!ended) throw new Error(`Structured patch is missing "${END}".`);
  if (!operations.length) throw new Error("Structured patch contains no file operations.");
  return operations;
}

function findAll(haystack: string[], needle: string[]): number[] {
  const positions: number[] = [];
  if (!needle.length || needle.length > haystack.length) return positions;
  outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) if (haystack[i + j] !== needle[j]) continue outer;
    positions.push(i);
  }
  return positions;
}

export function applyStructuredHunks(content: string, hunks: StructuredHunk[], filePath: string): string {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  let lines = content.split(/\r?\n/);
  const trailing = /\r?\n$/.test(content);
  if (trailing) lines.pop();
  for (const hunk of hunks) {
    const oldBlock = hunk.lines.filter((line) => line.type !== "add").map((line) => line.content);
    const newBlock = hunk.lines.filter((line) => line.type !== "remove").map((line) => line.content);
    if (!oldBlock.length) throw new Error(`${filePath}: an add-only hunk has no context and cannot be located.`);
    const positions = findAll(lines, oldBlock);
    if (!positions.length) throw new Error(`${filePath}: hunk context was not found.`);
    let at: number;
    if (positions.length === 1) at = positions[0];
    else {
      const anchorIndex = hunk.anchor ? lines.findIndex((line) => line.includes(hunk.anchor)) : -1;
      const candidates = anchorIndex < 0 ? [] : positions.filter((position) => position >= anchorIndex);
      if (candidates.length !== 1) {
        throw new Error(`${filePath}: hunk matches ${positions.length} locations and its anchor is not unique.`);
      }
      at = candidates[0];
    }
    lines = [...lines.slice(0, at), ...newBlock, ...lines.slice(at + oldBlock.length)];
  }
  return lines.join(eol) + (trailing ? eol : "");
}

export function parseUnifiedDiff(patch: string): UnifiedHunk[] {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  let index = lines.findIndex((line) => line.startsWith("@@"));
  const hunks: UnifiedHunk[] = [];
  while (index >= 0 && index < lines.length) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[index]);
    if (!match) throw new Error(`Invalid unified hunk header: ${lines[index]}`);
    const hunk: UnifiedHunk = {
      oldStart: Number(match[1]), oldCount: match[2] === undefined ? 1 : Number(match[2]),
      newStart: Number(match[3]), newCount: match[4] === undefined ? 1 : Number(match[4]), lines: [],
    };
    index += 1;
    while (index < lines.length && !lines[index].startsWith("@@")) {
      const line = lines[index];
      if (line.startsWith("+")) hunk.lines.push({ type: "add", content: line.slice(1) });
      else if (line.startsWith("-")) hunk.lines.push({ type: "remove", content: line.slice(1) });
      else if (line.startsWith(" ")) hunk.lines.push({ type: "context", content: line.slice(1) });
      else if (line && !line.startsWith("\\") && !line.startsWith("---") && !line.startsWith("+++")) {
        throw new Error(`Invalid unified diff line: ${line.slice(0, 100)}`);
      }
      index += 1;
    }
    const oldCount = hunk.lines.filter((line) => line.type !== "add").length;
    const newCount = hunk.lines.filter((line) => line.type !== "remove").length;
    if (oldCount !== hunk.oldCount || newCount !== hunk.newCount) {
      throw new Error("Unified hunk line counts do not match its header.");
    }
    hunks.push(hunk);
    if (index >= lines.length) break;
  }
  return hunks;
}

export function applyUnifiedHunks(content: string, hunks: UnifiedHunk[]): string {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const trailing = /\r?\n$/.test(content);
  const fileLines = content.split(/\r?\n/);
  if (trailing) fileLines.pop();
  const output: string[] = [];
  let cursor = 0;
  for (const hunk of hunks) {
    const start = Math.max(0, hunk.oldStart - 1);
    if (start < cursor) throw new Error("Unified hunks overlap or are out of order.");
    output.push(...fileLines.slice(cursor, start));
    cursor = start;
    for (const line of hunk.lines) {
      if (line.type === "add") { output.push(line.content); continue; }
      if (fileLines[cursor] !== line.content) {
        throw new Error(`Unified hunk mismatch at line ${cursor + 1}: expected ${JSON.stringify(line.content)}.`);
      }
      if (line.type === "context") output.push(line.content);
      cursor += 1;
    }
  }
  output.push(...fileLines.slice(cursor));
  return output.join(eol) + (trailing || hunks.some((hunk) => hunk.lines.length) ? eol : "");
}
