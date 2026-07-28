export function normalizeGlobPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function escapeRegex(ch: string): string {
  return /[\\.^$+()|]/.test(ch) ? `\\${ch}` : ch;
}

function globSource(pattern: string): string {
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        i += 1;
        if (pattern[i + 1] === "/") {
          i += 1;
          source += "(?:.*/)?";
        } else source += ".*";
      } else source += "[^/]*";
    } else if (ch === "?") source += "[^/]";
    else if (ch === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end === -1) source += "\\[";
      else {
        const body = pattern.slice(i + 1, end).replace(/^!/, "^");
        source += `[${body}]`;
        i = end;
      }
    } else if (ch === "{") {
      const end = pattern.indexOf("}", i + 1);
      if (end === -1) source += "\\{";
      else {
        const alternatives = pattern.slice(i + 1, end).split(",");
        source += `(?:${alternatives.map(globSource).join("|")})`;
        i = end;
      }
    } else source += escapeRegex(ch);
  }
  return source;
}

export function compileGlob(pattern: string): (relativePath: string, baseName?: string) => boolean {
  const normalized = normalizeGlobPath(pattern);
  if (!normalized) throw new Error("Glob pattern cannot be empty");
  let expression: RegExp;
  try { expression = new RegExp(`^${globSource(normalized)}$`, "i"); }
  catch (error) { throw new Error(`Invalid glob pattern: ${(error as Error).message}`); }
  const pathPattern = normalized.includes("/");
  return (relativePath, baseName) => expression.test(
    pathPattern ? normalizeGlobPath(relativePath) : (baseName ?? normalizeGlobPath(relativePath).split("/").at(-1) ?? ""),
  );
}
