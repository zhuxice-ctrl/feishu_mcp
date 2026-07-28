export type ToolErrorCode =
  | "AUTHENTICATION_REQUIRED" | "CLIENT_ELICITATION_UNSUPPORTED"
  | "APPROVAL_REQUIRED" | "APPROVAL_DENIED" | "APPROVAL_EXPIRED"
  | "QUEUE_TIMEOUT" | "EXECUTION_TIMEOUT" | "OUTSIDE_ALLOWED_DIRS"
  | "SENSITIVE_PATH" | "INVALID_ARGUMENT" | "INVALID_PATTERN"
  | "INVALID_PATCH" | "PROCESS_FAILED" | "GIT_FAILED"
  | "NETWORK_DENIED" | "RESPONSE_TOO_LARGE" | "ROLLBACK_FAILED"
  | "INTERNAL_ERROR";

export function toolJson(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

export function toolError(code: ToolErrorCode, message: string, retryable = false) {
  const body = { ok: false, code, message, retryable };
  return { ...toolJson(body), isError: true };
}
