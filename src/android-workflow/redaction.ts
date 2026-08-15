/**
 * Redaction — strips secrets, credentials, and user-specific paths from any
 * string before it enters logs, evidence, or state checkpoints.
 *
 * Design ref: docs/superpowers/specs/2026-08-15-staging-android-verify-design.md
 * "绑定码、Token、PIN、Cookie、私钥和完整认证响应只可进入内存，日志和证据必须脱敏。"
 */

// ---------------------------------------------------------------------------
// Sensitive value patterns
// ---------------------------------------------------------------------------

/** Bearer tokens in Authorization headers or standalone references. */
const BEARER_RE = /(Bearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi;

/** Basic-auth header values. */
const AUTH_BASIC_RE = /(Authorization:\s*Basic\s+)([A-Za-z0-9+/=]{8,})/gi;

/** Cookie header values. */
const COOKIE_RE = /([Cc]ookie:\s*)([^\r\n]+)/g;

/** PIN assignments: PIN=12345678, PIN: 1234, pin: 12345678 */
const PIN_RE = /(PIN\s*[=:]\s*)(\d{4,8})/gi;

/** Generic token assignments: token=..., token: ... */
const TOKEN_RE = /(token\s*[=:]\s*)([A-Za-z0-9._~+/=-]{8,})/gi;

/** PEM-encoded private keys (RSA, EC, OpenSSH, DSA, PGP). */
const PRIVATE_KEY_RE =
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g;

/** Windows user home directory paths: C:\Users\<username>\... */
const WINDOWS_USER_RE = /(C:\\Users\\)([^\\]+)/gi;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Redact sensitive values from a string. Replaces bearer tokens, basic-auth
 * headers, cookies, PINs, private keys, generic token assignments, and
 * Windows usernames with `[REDACTED]` markers.
 *
 * Non-string input is coerced to an empty string so callers can pass
 * `undefined` / `null` without guarding.
 */
export function redact(input: string): string {
  if (typeof input !== "string") return "";

  let result = input;

  // PEM private keys first (multi-line block, must not be partially consumed)
  result = result.replace(PRIVATE_KEY_RE, "[REDACTED PRIVATE KEY]");

  // Authorization headers
  result = result.replace(BEARER_RE, "$1[REDACTED]");
  result = result.replace(AUTH_BASIC_RE, "$1[REDACTED]");

  // Cookies
  result = result.replace(COOKIE_RE, "$1[REDACTED]");

  // PIN values
  result = result.replace(PIN_RE, "$1[REDACTED]");

  // Generic token assignments
  result = result.replace(TOKEN_RE, "$1[REDACTED]");

  // Windows user paths
  result = result.replace(WINDOWS_USER_RE, "$1[REDACTED]");

  return result;
}
