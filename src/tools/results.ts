export type ToolErrorCode =
  | "AUTHENTICATION_REQUIRED" | "CLIENT_ELICITATION_UNSUPPORTED"
  | "APPROVAL_REQUIRED" | "APPROVAL_DENIED" | "APPROVAL_EXPIRED"
  | "DIRECTORY_APPROVAL_DENIED" | "DIRECTORY_GRANT_PERSIST_FAILED"
  | "DIRECTORY_IDENTITY_REQUIRED" | "DIRECTORY_APPROVAL_REQUIRED"
  | "DIRECTORY_APPROVAL_EXPIRED"
  | "QUEUE_TIMEOUT" | "EXECUTION_TIMEOUT" | "OUTSIDE_ALLOWED_DIRS"
  | "SENSITIVE_PATH" | "INVALID_ARGUMENT" | "INVALID_PATTERN"
  | "INVALID_PATCH" | "PROCESS_FAILED" | "GIT_FAILED"
  | "NETWORK_DENIED" | "RESPONSE_TOO_LARGE" | "ROLLBACK_FAILED"
  | "OWNER_REQUIRED" | "OWNER_NOT_CONFIGURED"
  | "TASK_NOT_FOUND" | "TASK_QUEUE_FULL" | "TASK_INTERRUPTED" | "TASK_CANCELLED"
  | "INTERNAL_ERROR";

export function toolJson(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

export function toolError(
  code: ToolErrorCode,
  message: string,
  retryable = false,
  details: Record<string, unknown> = {},
) {
  const body = { ...details, ok: false, code, message, retryable };
  return { ...toolJson(body), isError: true };
}
