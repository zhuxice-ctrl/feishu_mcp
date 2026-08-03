import { z } from "zod";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { BINARY_ARTIFACT_CHUNK_BYTES, OWNER_USER_ID } from "../config.js";
import { authorizeOwnerToolCall } from "../security/toolAccess.js";
import { getRequestUserId } from "../security/requestContext.js";
import { directoryGrantStore } from "../security/directoryGrantStore.js";
import { materializeArtifact } from "../artifacts/materialize.js";
import { BinaryArtifactStore } from "../artifacts/store.js";
import { ArtifactUploadService } from "../artifacts/uploads.js";
import { importArtifactUrl } from "../artifacts/urlImport.js";
import { runTool } from "./registry.js";
import { toolError, toolJson } from "./results.js";

const artifactClass = z.enum(["project_asset", "archive", "executable"]);
const encodedChunkLimit = Math.ceil(BINARY_ARTIFACT_CHUNK_BYTES / 3) * 4 + 8;
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("inspect"), artifact: z.string().optional(), uploadSessionId: z.string().uuid().optional() }).strict(),
  z.object({ action: z.literal("upload_begin"), displayName: z.string().min(1).max(255), declaredMediaType: z.string().min(1).max(128), expectedSize: z.number().int().positive(), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), class: artifactClass }).strict(),
  z.object({ action: z.literal("upload_chunk"), uploadSessionId: z.string().uuid(), chunkIndex: z.number().int().min(0), base64: z.string().min(4).max(encodedChunkLimit) }).strict(),
  z.object({ action: z.literal("upload_commit"), uploadSessionId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("import_url"), url: z.string().url(), displayName: z.string().min(1).max(255), declaredMediaType: z.string().min(1).max(128), expectedSize: z.number().int().positive().optional(), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), class: artifactClass }).strict(),
  z.object({ action: z.literal("materialize"), artifact: z.string().regex(/^sha256:[a-f0-9]{64}$/), destination: z.string().min(1), overwrite: z.enum(["refuse", "replace_with_backup"]).default("refuse") }).strict(),
]);

function errorFrom(error: unknown) {
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code: unknown }).code);
    if (code.startsWith("BINARY_ARTIFACT_")) return toolError(code as never, "Binary artifact operation failed.");
  }
  return toolError("BINARY_ARTIFACT_STORE_FAILED", "Binary artifact operation failed.");
}

export function registerBinaryArtifactTool(
  server: McpServer,
  services: { store: BinaryArtifactStore; uploads: ArtifactUploadService },
): void {
  server.registerTool("manage_binary_artifact", {
    description: "Owner-only binary artifact transfer. Imports verified bytes from HTTPS URLs or ordered Base64 chunks, then atomically materializes them in an authorized project directory. It never executes or extracts artifacts.",
    inputSchema: schema,
  }, async (args, ctx: ServerContext) => {
    const access = authorizeOwnerToolCall("manage_binary_artifact", args);
    if (access) return access;
    return runTool({ name: "manage_binary_artifact", concurrency: "artifact", subject: { kind: "artifact", key: "artifact", display: "artifact" } }, async () => {
      const userId = getRequestUserId();
      if (!userId || userId !== OWNER_USER_ID) return toolError("OWNER_REQUIRED", "Binary artifacts are restricted to the configured owner.");
      try {
        switch (args.action) {
          case "inspect":
            if (args.uploadSessionId) return toolJson({ ok: true, upload: services.uploads.inspect(userId, args.uploadSessionId) });
            if (args.artifact) {
              const artifact = services.store.inspect(args.artifact);
              return artifact ? toolJson({ ok: true, artifact }) : toolError("BINARY_ARTIFACT_NOT_FOUND", "Artifact was not found.");
            }
            return toolError("INVALID_ARGUMENT", "Provide an artifact or upload session.");
          case "upload_begin":
            return toolJson({ ok: true, upload: services.uploads.begin(userId, args) });
          case "upload_chunk":
            return toolJson({ ok: true, upload: services.uploads.append(userId, args.uploadSessionId, args.chunkIndex, args.base64) });
          case "upload_commit":
            return toolJson({ ok: true, artifact: services.uploads.commit(userId, args.uploadSessionId) });
          case "import_url":
            return toolJson({ ok: true, artifact: await importArtifactUrl(services.store, {
              ...args, expectedSize: args.expectedSize ?? null, expectedSha256: args.expectedSha256 ?? null,
            }, ctx.mcpReq.signal) });
          case "materialize": {
            const roots = directoryGrantStore.effectiveRoots(userId);
            if (roots.length === 0) return toolError("OUTSIDE_ALLOWED_DIRS", "No authorized project directory is configured.");
            return toolJson({ ok: true, materialized: materializeArtifact({
              store: services.store, artifact: args.artifact as `sha256:${string}`, target: args.destination,
              authorizedRoots: roots, overwrite: args.overwrite,
            }) });
          }
        }
      } catch (error) {
        return errorFrom(error);
      }
    });
  });
}
