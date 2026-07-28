import { logger } from "../security/logger.js";
import {
  QueueTimeoutError,
  type ConcurrencyClass,
  withConcurrency,
} from "./concurrency.js";
import { toolError } from "./results.js";

export interface ToolSubject {
  kind: "command" | "origin" | "path" | "paths";
  key: string;
  display: string;
}

export interface RunToolOptions {
  name: string;
  concurrency: ConcurrencyClass;
  subject: ToolSubject;
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function redactedSubject(subject: ToolSubject): { kind: ToolSubject["kind"]; target: string } {
  return { kind: subject.kind, target: "[REDACTED]" };
}

/**
 * Apply shared execution controls to a tool body. The logger redacts secret
 * fields recursively, so audit metadata never writes configured credentials.
 */
export async function runTool(
  { name, concurrency, subject }: RunToolOptions,
  body: () => Promise<ToolResult>,
): Promise<ToolResult> {
  const auditSubject = redactedSubject(subject);
  logger.info("tool_execution_start", { name, concurrency, subject: auditSubject });
  try {
    const result = await withConcurrency(concurrency, body);
    logger.info("tool_execution_end", {
      name,
      concurrency,
      subject: auditSubject,
      outcome: result.isError ? "error" : "success",
    });
    return result;
  } catch (error) {
    const result = error instanceof QueueTimeoutError
      ? toolError("QUEUE_TIMEOUT", error.message, true)
      : toolError("INTERNAL_ERROR", "Tool execution failed.");
    logger.error("tool_execution_end", {
      name,
      concurrency,
      subject: auditSubject,
      outcome: "error",
      code: error instanceof QueueTimeoutError ? "QUEUE_TIMEOUT" : "INTERNAL_ERROR",
    });
    return result;
  }
}
