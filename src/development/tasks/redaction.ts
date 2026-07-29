/**
 * Line-aware streaming redaction for development task logs.
 *
 * Output from detached workers is redacted before it reaches disk so that
 * bearer tokens, password-like assignments, Gradle signing properties, and
 * configured secret values are never persisted. The redactor is
 * chunk-aware: it retains a small tail between pushes so that a secret split
 * across two chunks is still matched once the second half arrives.
 */

const REPLACEMENT = "[REDACTED]";

/**
 * Case-insensitive patterns for common secret-bearing shapes. Each match is
 * replaced wholesale with `[REDACTED]`.
 */
const PATTERNS: readonly RegExp[] = [
  /authorization\s*:\s*bearer\s+[^\s]+/gi,
  /\b(password|passwd|token|secret|storepass|keypass)\s*[=:]\s*[^\s]+/gi,
  /-P(android\.inject\.signing\.(store|key)\.password)=[^\s]+/gi,
];

/** Sensitive env-var name fragments; keys matching these are rejected upstream. */
export const SENSITIVE_ENV_NAME_PATTERNS: readonly RegExp[] = [
  /password|passwd|secret|token|credential|api[_-]?key|storepass|keypass/i,
];

const TAIL_CAP = 4096;

function redactOnce(text: string, secrets: readonly string[]): string {
  let out = text;
  // Configured literal secret values, longest first so overlapping short
  // prefixes cannot shadow a longer match.
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join(REPLACEMENT);
  }
  for (const pattern of PATTERNS) {
    // Reset lastIndex because the shared regexes are global.
    pattern.lastIndex = 0;
    out = out.replace(pattern, REPLACEMENT);
  }
  return out;
}

export class StreamingTaskRedactor {
  private buffer = "";
  private readonly maxSecretLength: number;

  constructor(private readonly secrets: readonly string[] = []) {
    let longest = 1;
    for (const secret of secrets) {
      if (secret.length > longest) longest = secret.length;
    }
    this.maxSecretLength = longest;
  }

  /** Process an incoming chunk and return the bytes safe to emit now. */
  push(chunk: string): string {
    if (!chunk) return "";
    this.buffer += chunk;
    const redacted = redactOnce(this.buffer, this.secrets);
    const holdCount = Math.min(redacted.length, Math.min(this.maxSecretLength - 1, TAIL_CAP));
    if (holdCount <= 0) {
      const emit = redacted;
      this.buffer = "";
      return emit;
    }
    const emit = redacted.slice(0, redacted.length - holdCount);
    this.buffer = redacted.slice(redacted.length - holdCount);
    return emit;
  }

  /** Emit all remaining buffered content. */
  flush(): string {
    if (!this.buffer) return "";
    const out = redactOnce(this.buffer, this.secrets);
    this.buffer = "";
    return out;
  }
}

/** Reject env keys whose names look sensitive or values that match a secret. */
export function isSensitiveEnvEntry(
  name: string,
  value: string,
  secrets: readonly string[] = [],
): boolean {
  for (const pattern of SENSITIVE_ENV_NAME_PATTERNS) {
    if (pattern.test(name)) return true;
  }
  for (const secret of secrets) {
    if (secret && value.includes(secret)) return true;
  }
  return false;
}
