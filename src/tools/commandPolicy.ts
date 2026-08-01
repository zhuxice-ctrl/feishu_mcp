export interface CommandRisk {
  level: "read_only" | "approval_required";
  reasons: string[];
  normalized: string;
  gitCategory?: "ordinary" | "confirmation_required";
}

const SAFE_ZERO_TARGET = new Set(["whoami", "hostname", "cd", "pwd"]);
const ALWAYS_APPROVE = new Set([
  "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe",
  "bash", "sh", "zsh", "python", "python3", "py", "node", "ruby", "perl",
  "npm", "npx", "pnpm", "yarn", "bun", "deno", "make", "cmake", "msbuild",
  "cargo", "go", "dotnet", "java", "javac", "gradle", "mvn", "taskkill",
  "kill", "sc", "reg", "net", "netsh", "rm", "del", "erase", "move", "copy",
  "ren", "rename", "mkdir", "rmdir", "chmod", "chown", "curl", "wget",
]);

function tokenize(command: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let quote: "\"" | "'" | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === "\"" && i + 1 < command.length) current += command[++i];
      else current += ch;
      continue;
    }
    if (ch === "\"" || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) {
      if (current) { tokens.push(current); current = ""; }
      continue;
    }
    current += ch;
  }
  if (quote) return null;
  if (current) tokens.push(current);
  return tokens;
}

function hasMetacharacters(command: string): boolean {
  return /[|&;<>`\r\n]/.test(command) || /\$\s*\(/.test(command) || /%[^%\r\n]+%/.test(command);
}

function baseName(executable: string): string {
  return executable.replace(/^.*[\\/]/, "").toLowerCase();
}

function gitCategory(tokens: string[]): CommandRisk["gitCategory"] {
  const args = tokens.slice(1);
  const [subcommand, ...subcommandArgs] = args;
  if (
    (subcommand === "status" && subcommandArgs.every((arg) =>
      ["--short", "-s", "--branch", "-b", "--porcelain", "--porcelain=v1", "--porcelain=v2"].includes(arg))) ||
    (subcommand === "add" && subcommandArgs.length === 1 && !subcommandArgs[0].startsWith("-")) ||
    (subcommand === "commit" && subcommandArgs.length === 2 && subcommandArgs[0] === "-m") ||
    (subcommand === "merge" && subcommandArgs.length === 1 && !subcommandArgs[0].startsWith("-")) ||
    (subcommand === "push" && subcommandArgs.length === 2 && !subcommandArgs.some((arg) => arg.startsWith("-")))
  ) {
    return "ordinary";
  }
  return "confirmation_required";
}

export function classifyCommand(command: string): CommandRisk {
  const normalized = command.trim();
  const reasons: string[] = [];
  if (!normalized) return { level: "approval_required", reasons: ["The command is empty."], normalized };
  if (hasMetacharacters(normalized)) {
    return {
      level: "approval_required",
      reasons: ["Shell operators, redirection, substitution, or multiple commands were detected."],
      normalized,
    };
  }
  const tokens = tokenize(normalized);
  if (!tokens?.length) {
    return { level: "approval_required", reasons: ["The complete command could not be parsed safely."], normalized };
  }
  const executable = baseName(tokens[0]);
  if (ALWAYS_APPROVE.has(executable)) {
    return { level: "approval_required", reasons: [`${executable} can execute or modify local state.`], normalized };
  }
  if (SAFE_ZERO_TARGET.has(executable) && tokens.length === 1) {
    return { level: "read_only", reasons: [], normalized };
  }
  if (executable === "dir" && tokens.slice(1).every((token) => /^\/[a-z]+(?::[^\\/]*)?$/i.test(token))) {
    return { level: "read_only", reasons: [], normalized };
  }
  if (executable === "git" || executable === "git.exe") {
    reasons.push("Git configuration can invoke local helpers; use the dedicated Git tools for automatic read-only access.");
    return { level: "approval_required", reasons, normalized, gitCategory: gitCategory(tokens) };
  } else if (executable === "rg" || executable === "rg.exe" || executable === "ripgrep") {
    reasons.push("Command-line search paths can escape the allowed directory; use search_content for automatic access.");
  } else if (executable === "findstr" || executable === "findstr.exe") {
    reasons.push("Command-line search paths can escape the allowed directory; use search_content for automatic access.");
  } else if (["type", "where"].includes(executable)) {
    reasons.push("Command path arguments require approval; use the dedicated filesystem tools for automatic access.");
  } else {
    reasons.push("The executable is not on the strict read-only allowlist.");
  }
  return { level: "approval_required", reasons, normalized };
}
