import fs from "node:fs";
import { z } from "zod";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { TEXT_TRANSFER_CHUNK_BYTES } from "../config.js";
import { TextTransferError, TextTransferService } from "../textTransfers/service.js";
import { authorizeOwnerToolCall } from "../security/toolAccess.js";
import { getRequestUserId, getRequestToken } from "../security/requestContext.js";
import { logOperation } from "../security/logger.js";
import { atomicWriteFile } from "./atomicWrite.js";
import { resolveGuardAndAuthorize } from "./helpers.js";
import { runTool } from "./registry.js";
import { toolError, toolJson } from "./results.js";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("begin"), path: z.string().min(1), expectedBytes: z.number().int().min(0), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i) }).strict(),
  z.object({ action: z.literal("append"), sessionId: z.string().uuid(), chunkIndex: z.number().int().min(0), content: z.string().max(TEXT_TRANSFER_CHUNK_BYTES) }).strict(),
  z.object({ action: z.literal("inspect"), sessionId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("commit"), sessionId: z.string().uuid() }).strict(),
]);

function errorFrom(error: unknown) {
  if (error instanceof TextTransferError) {
    return toolError(error.code, "Text transfer operation failed.");
  }
  return toolError("TEXT_TRANSFER_STORE_FAILED", "Text transfer operation failed.");
}

function owner(): string | null {
  return getRequestUserId();
}

/**
 * Owner-only staged source transfer. Destinations are captured in the
 * protected service metadata and are intentionally absent from inspect data.
 */
export function registerTextTransferTool(server: McpServer, service: TextTransferService): void {
  server.registerTool("manage_text_transfer", {
    description: "Owner-only resumable transfer for source text that is too large for one MCP request. Upload ordered UTF-8 chunks, inspect progress, then verify and atomically commit to an authorized file. It never executes content.",
    inputSchema: schema,
  }, async (args, ctx: ServerContext) => {
    const access = authorizeOwnerToolCall("manage_text_transfer", args);
    if (access) return access;
    const userId = owner();
    if (!userId) return toolError("OWNER_REQUIRED", "Text transfers are restricted to the configured owner.");
    return runTool({ name: "manage_text_transfer", concurrency: "artifact", subject: { kind: "artifact", key: "text-transfer", display: "text transfer" } }, async () => {
      try {
        switch (args.action) {
          case "begin": {
            const guard = await resolveGuardAndAuthorize("manage_text_transfer", "path", args.path, "write", args, ctx, { scope: "file", access: "write" });
            if (!guard.ok) return guard.result ?? toolError("INVALID_ARGUMENT", guard.error ?? "Invalid destination.");
            const transfer = service.begin(userId, {
              expectedBytes: args.expectedBytes,
              expectedSha256: args.expectedSha256,
              target: guard.resolvedPath,
            });
            logOperation("manage_text_transfer", guard.resolvedPath, getRequestToken(), "success");
            return toolJson({ ok: true, transfer });
          }
          case "append":
            return toolJson({ ok: true, transfer: service.append(userId, args.sessionId, args.chunkIndex, args.content) });
          case "inspect":
            return toolJson({ ok: true, transfer: service.inspect(userId, args.sessionId) });
          case "commit": {
            const target = service.target(userId, args.sessionId);
            // Re-validate every filesystem boundary after a potentially long upload.
            const guard = await resolveGuardAndAuthorize("manage_text_transfer", "path", target, "write", args, ctx, { scope: "file", access: "write" });
            if (!guard.ok) return guard.result ?? toolError("INVALID_ARGUMENT", guard.error ?? "Invalid destination.");
            const verification = service.verify(userId, args.sessionId);
            const source = service.readVerified(userId, args.sessionId);
            const content = fs.readFileSync(source.path, "utf8");
            const written = atomicWriteFile(guard.resolvedPath, content, { trashOriginal: true });
            // Only terminally discard after the replacement is durably in place.
            service.discard(userId, args.sessionId);
            logOperation("manage_text_transfer", guard.resolvedPath, getRequestToken(), "success");
            return toolJson({ ok: true, committed: { bytes: written.bytes, sha256: verification.sha256 } });
          }
        }
      } catch (error) {
        return errorFrom(error);
      }
    });
  });
}
