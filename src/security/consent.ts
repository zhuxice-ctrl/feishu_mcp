import path from "node:path";
import {
  CONSENT_ABSOLUTE_PATH,
  CONSENT_SENSITIVE_FILE,
  CONSENT_TIMEOUT_MS,
  NON_INTERACTIVE,
  type ConsentPolicy,
  type NonInteractivePolicy,
} from "../config.js";
import { isSensitiveFile } from "./fileGuard.js";
import { logger } from "./logger.js";
import { terminal as defaultTerminal, type TerminalInterface } from "./terminal.js";

export type ConsentKind = "absolute_path" | "sensitive_file";

export interface ConsentRequest {
  kinds: ConsentKind[];
  tool: string;
  userId: string | null;
  argName: string;
  raw: string;
  resolved: string;
}

export interface ConsentResult {
  allowed: boolean;
  source: "policy" | "remembered" | "operator" | "timeout" | "non_interactive_policy";
  remembered?: boolean;
}

export interface ConsentGateOptions {
  absolutePathPolicy?: ConsentPolicy;
  sensitiveFilePolicy?: ConsentPolicy;
  timeoutMs?: number;
  nonInteractivePolicy?: NonInteractivePolicy;
}

export interface ConsentGate {
  request(request: ConsentRequest): Promise<ConsentResult>;
  isInteractive(): boolean;
  summary(): object;
  reset(): void;
  close(): void;
}

export const PATH_ARGS: Record<string, string[]> = {
  read_file: ["path"],
  write_file: ["path"],
  edit_file: ["path"],
  list_directory: ["path"],
  create_directory: ["path"],
  move_file: ["source", "destination"],
  search_files: ["path"],
  get_file_info: ["path"],
  search_content: ["path"],
  git_status: ["path"],
  git_diff: ["path"],
  compare_files: ["path_a", "path_b"],
  apply_patch: ["path"],
};

const CONTENT_TOOLS = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "search_content",
  "compare_files",
  "apply_patch",
]);

export function inspectPath(
  toolName: string,
  raw: string,
  resolved: string
): ConsentKind[] {
  const kinds: ConsentKind[] = [];
  if (path.isAbsolute(raw)) kinds.push("absolute_path");
  if (CONTENT_TOOLS.has(toolName) && isSensitiveFile(resolved)) {
    kinds.push("sensitive_file");
  }
  return kinds;
}

export function createConsentGate(
  term: TerminalInterface = defaultTerminal,
  options: ConsentGateOptions = {}
): ConsentGate {
  const policies: Record<ConsentKind, ConsentPolicy> = {
    absolute_path: options.absolutePathPolicy ?? CONSENT_ABSOLUTE_PATH,
    sensitive_file: options.sensitiveFilePolicy ?? CONSENT_SENSITIVE_FILE,
  };
  const timeoutMs = options.timeoutMs ?? CONSENT_TIMEOUT_MS;
  const nonInteractivePolicy = options.nonInteractivePolicy ?? NON_INTERACTIVE;
  const decisions = new Map<string, "allow" | "deny">();

  function normalizeKinds(kinds: ConsentKind[]): ConsentKind[] {
    return [...new Set(kinds)].sort();
  }

  function keyFor(kinds: ConsentKind[], subject: string): string {
    return `${normalizeKinds(kinds).join("+")}|${subject}`;
  }

  function logDecision(request: ConsentRequest, result: ConsentResult): ConsentResult {
    logger.info("consent_decision", {
      toolName: request.tool,
      kinds: normalizeKinds(request.kinds),
      allowed: result.allowed,
      source: result.source,
      remembered: result.remembered === true,
    });
    return result;
  }

  function render(request: ConsentRequest, queuedBehind: number): string {
    const kinds = normalizeKinds(request.kinds).join(", ");
    return [
      "",
      `Consent required for ${kinds}`,
      `Tool: ${request.tool}`,
      `Path: ${request.resolved}`,
      `Timeout: ${Math.ceil(timeoutMs / 1000)}s (default deny)`,
      queuedBehind > 0 ? `Queued requests behind this prompt: ${queuedBehind}` : "",
      "Allow once [y], remember allow [a], remember deny [d], or deny [n]: ",
    ]
      .filter(Boolean)
      .join("\n");
  }

  async function request(consentRequest: ConsentRequest): Promise<ConsentResult> {
    const kinds = normalizeKinds(consentRequest.kinds);
    if (kinds.some((kind) => policies[kind] === "deny")) {
      return logDecision(consentRequest, { allowed: false, source: "policy" });
    }
    if (kinds.every((kind) => policies[kind] === "allow")) {
      return logDecision(consentRequest, { allowed: true, source: "policy" });
    }

    const key = keyFor(kinds, consentRequest.resolved);
    const remembered = decisions.get(key);
    if (remembered) {
      return logDecision(consentRequest, {
        allowed: remembered === "allow",
        source: "remembered",
      });
    }
    if (!term.isInteractive()) {
      return logDecision(consentRequest, {
        allowed: nonInteractivePolicy === "allow",
        source: "non_interactive_policy",
      });
    }

    const result = await term.prompt({
      render: ({ queuedBehind }) => render(consentRequest, queuedBehind),
      timeoutMs,
      beforeRender: () => {
        const current = decisions.get(key);
        return current
          ? { answer: current, timedOut: false, skipped: true }
          : null;
      },
      onResult: (promptResult) => {
        if (promptResult.skipped) return;
        const answer = promptResult.answer?.toLowerCase();
        if (answer === "a") decisions.set(key, "allow");
        if (answer === "d") decisions.set(key, "deny");
      },
    });
    if (result.skipped) {
      return logDecision(consentRequest, {
        allowed: result.answer === "allow",
        source: "remembered",
      });
    }
    if (result.timedOut) {
      return logDecision(consentRequest, { allowed: false, source: "timeout" });
    }
    if (result.answer?.toLowerCase() === "a") {
      decisions.set(key, "allow");
      return logDecision(consentRequest, {
        allowed: true,
        source: "operator",
        remembered: true,
      });
    }
    if (result.answer?.toLowerCase() === "d") {
      decisions.set(key, "deny");
      return logDecision(consentRequest, {
        allowed: false,
        source: "operator",
        remembered: true,
      });
    }
    return logDecision(consentRequest, {
      allowed: result.answer?.toLowerCase() === "y",
      source: "operator",
    });
  }

  return {
    request,
    isInteractive: () => term.isInteractive(),
    summary: () => ({
      absolutePathPolicy: policies.absolute_path,
      sensitiveFilePolicy: policies.sensitive_file,
      timeoutMs,
      nonInteractivePolicy,
      interactive: term.isInteractive(),
      remembered: decisions.size,
      waiting: term.pending(),
    }),
    reset: () => decisions.clear(),
    close: () => term.close(),
  };
}

export const consentGate = createConsentGate();
