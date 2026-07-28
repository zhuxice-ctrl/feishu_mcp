import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { getRequestUserId } from "../security/requestContext.js";
import { authorizeToolCall } from "../security/toolAccess.js";
import { runTool } from "./registry.js";
import { toolError, toolJson } from "./results.js";

const statuses = ["pending", "in_progress", "completed"] as const;
const priorities = ["high", "medium", "low"] as const;
const itemSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  content: z.string().trim().min(1).max(500),
  status: z.enum(statuses).default("pending"),
  priority: z.enum(priorities).optional(),
});

export type TodoItem = z.infer<typeof itemSchema> & { id: string };
const lists = new Map<string, TodoItem[]>();

function userKey(): string {
  return getRequestUserId() ?? "__anonymous__";
}

function counts(items: TodoItem[]) {
  return {
    total: items.length,
    pending: items.filter((item) => item.status === "pending").length,
    in_progress: items.filter((item) => item.status === "in_progress").length,
    completed: items.filter((item) => item.status === "completed").length,
  };
}

export async function todoWrite(rawItems: unknown) {
  const parsed = z.array(itemSchema).max(100).safeParse(rawItems);
  if (!parsed.success) {
    return toolError("INVALID_ARGUMENT", "Todos must be a list of at most 100 valid todo items.");
  }
  const items = parsed.data.map((item, index) => ({
    ...item,
    id: String(item.id ?? index + 1),
  }));
  lists.set(userKey(), items);
  const summary = counts(items);
  return toolJson({
    ok: true,
    todos: items,
    counts: summary,
    ...(summary.in_progress > 1
      ? { warning: `${summary.in_progress} items are in progress; one at a time is recommended.` }
      : {}),
  });
}

export async function todoRead() {
  const items = lists.get(userKey()) ?? [];
  return toolJson({ ok: true, todos: items, counts: counts(items) });
}

export function todoSummary() {
  let items = 0;
  for (const list of lists.values()) items += list.length;
  return { users: lists.size, items };
}

export function registerTodoTools(server: McpServer): void {
  server.registerTool("todo_write", {
    description: "Replace the authenticated user's in-memory development task list.",
    inputSchema: { todos: z.array(itemSchema).max(100) },
  }, async (args) => {
    const accessError = authorizeToolCall("todo_write", args);
    if (accessError) return accessError;
    return runTool(
      { name: "todo_write", concurrency: "ungated", subject: { kind: "paths", key: userKey(), display: "user todo list" } },
      () => todoWrite(args.todos),
    );
  });
  server.registerTool("todo_read", {
    description: "Read the authenticated user's in-memory development task list.",
    inputSchema: {},
  }, async (args) => {
    const accessError = authorizeToolCall("todo_read", args);
    if (accessError) return accessError;
    return runTool(
      { name: "todo_read", concurrency: "ungated", subject: { kind: "paths", key: userKey(), display: "user todo list" } },
      todoRead,
    );
  });
}
