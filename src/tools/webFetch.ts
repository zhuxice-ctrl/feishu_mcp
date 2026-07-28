import http from "node:http";
import https from "node:https";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import type { IncomingHttpHeaders } from "node:http";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import {
  FETCH_MAX_BYTES,
  FETCH_MAX_REDIRECTS,
  FETCH_MAX_TIMEOUT_MS,
  FETCH_TIMEOUT_MS,
  SERVER_NAME,
  SERVER_VERSION,
} from "../config.js";
import { getRequestUserId } from "../security/requestContext.js";
import { validateNetworkTarget, type ValidatedNetworkTarget } from "../security/networkGuard.js";
import { digestArguments, requestApproval } from "../security/approval.js";
import { authorizeToolCall } from "../security/toolAccess.js";
import { htmlToMarkdown, htmlToText } from "./html.js";
import { runTool } from "./registry.js";
import { toolError, toolJson } from "./results.js";

interface WebFetchArgs { url: string; format?: "text" | "markdown" | "html"; timeout?: number }
interface FetchResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  truncated: boolean;
  redirect?: URL;
}

function requestOnce(target: ValidatedNetworkTarget, timeoutMs: number, signal: AbortSignal): Promise<FetchResponse> {
  return new Promise((resolve, reject) => {
    const address = target.addresses[0];
    const client = target.url.protocol === "https:" ? https : http;
    let settled = false;
    const finish = (value: FetchResponse) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = client.request(target.url, {
      method: "GET",
      headers: {
        "user-agent": `${SERVER_NAME}/${SERVER_VERSION}`,
        accept: "text/html,application/json,text/plain;q=0.9,*/*;q=0.8",
        "accept-encoding": "identity",
      },
      servername: target.url.protocol === "https:" ? target.url.hostname : undefined,
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
      timeout: timeoutMs,
      signal,
    }, (response) => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.resume();
        finish({ status, headers: response.headers, body: Buffer.alloc(0), truncated: false, redirect: new URL(location, target.url) });
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      let truncated = false;
      const complete = () => finish({ status, headers: response.headers, body: Buffer.concat(chunks), truncated });
      response.on("data", (chunk: Buffer) => {
        if (bytes >= FETCH_MAX_BYTES) {
          truncated = true;
          complete();
          response.destroy();
          return;
        }
        const remaining = FETCH_MAX_BYTES - bytes;
        const kept = chunk.subarray(0, remaining);
        chunks.push(kept);
        bytes += kept.length;
        if (kept.length < chunk.length) {
          truncated = true;
          complete();
          response.destroy();
        }
      });
      response.once("end", complete);
      response.once("close", complete);
      response.once("error", reject);
    });
    request.once("timeout", () => request.destroy(new Error(`Request timed out after ${timeoutMs}ms`)));
    request.once("error", (error) => { if (!settled) { settled = true; reject(error); } });
    request.end();
  });
}

async function validateWithTimeout(input: string | URL, timeoutMs: number): Promise<ValidatedNetworkTarget> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      validateNetworkTarget(input),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("DNS validation timed out.")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function charsetOf(contentType: string): BufferEncoding {
  const charset = /charset=([\w-]+)/i.exec(contentType)?.[1]?.toLowerCase();
  return charset && Buffer.isEncoding(charset) ? charset as BufferEncoding : "utf8";
}

export async function webFetch(args: WebFetchArgs, ctx: ServerContext) {
  const timeoutMs = Math.min(args.timeout ?? FETCH_TIMEOUT_MS, FETCH_MAX_TIMEOUT_MS);
  const format = args.format ?? "text";
  let initial: ValidatedNetworkTarget;
  try { initial = await validateWithTimeout(args.url, timeoutMs); }
  catch (error) { return toolError("NETWORK_DENIED", (error as Error).message); }
  const argsDigest = digestArguments(args);
  return runTool(
    { name: "web_fetch", concurrency: "fetch", subject: { kind: "origin", key: initial.origin, display: initial.origin } },
    async () => {
      const started = performance.now();
      const deadline = Date.now() + timeoutMs;
      const approvedOrigins: string[] = [];
      const redirects: Array<{ from: string; to: string; status: number }> = [];
      let current = initial;
      for (let hop = 0; hop <= FETCH_MAX_REDIRECTS; hop += 1) {
        if (!approvedOrigins.includes(current.origin)) {
          const approval = await requestApproval(ctx, {
            tool: "web_fetch",
            userId: getRequestUserId(),
            subject: { kind: "origin", key: current.origin, display: current.origin },
            argsDigest,
            reasons: ["This request can reach public, local, or private network services from your computer."],
            priorSubjectKeys: approvedOrigins,
          });
          if (approval !== true) return approval;
          approvedOrigins.push(current.origin);
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) return toolError("EXECUTION_TIMEOUT", "The web request timed out.", true);
        let response: FetchResponse;
        try { response = await requestOnce(current, remaining, ctx.mcpReq.signal); }
        catch (error) { return toolError("PROCESS_FAILED", (error as Error).message, true); }
        if (response.redirect) {
          if (hop === FETCH_MAX_REDIRECTS) return toolError("NETWORK_DENIED", "Redirect limit exceeded.");
          redirects.push({ from: current.url.href, to: response.redirect.href, status: response.status });
          try { current = await validateWithTimeout(response.redirect, Math.max(1, deadline - Date.now())); }
          catch (error) { return toolError("NETWORK_DENIED", (error as Error).message); }
          continue;
        }
        const contentType = String(response.headers["content-type"] ?? "");
        const raw = response.body.toString(charsetOf(contentType));
        const isHtml = /\bhtml\b/i.test(contentType) || /^\s*<(!doctype|html)/i.test(raw);
        const content = format === "html" || !isHtml ? raw : format === "markdown" ? htmlToMarkdown(raw) : htmlToText(raw);
        return toolJson({
          ok: true,
          url: args.url,
          finalUrl: current.url.href,
          status: response.status,
          contentType: contentType || null,
          format: isHtml ? format : "raw",
          content,
          bytes: response.body.length,
          redirects,
          truncated: response.truncated,
          durationMs: Math.round(performance.now() - started),
        });
      }
      return toolError("NETWORK_DENIED", "Redirect limit exceeded.");
    },
  );
}

export function registerWebFetchTool(server: McpServer): void {
  server.registerTool("web_fetch", {
    description: "Fetch an HTTP(S) resource from this computer after exact-origin approval.",
    inputSchema: {
      url: z.string().url(),
      format: z.enum(["text", "markdown", "html"]).optional(),
      timeout: z.number().int().positive().optional(),
    },
  }, async (args, ctx) => authorizeToolCall("web_fetch", args) ?? webFetch(args, ctx));
}
