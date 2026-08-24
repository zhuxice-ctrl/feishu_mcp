import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const projectDir = path.resolve(import.meta.dirname, "..");

let seq = 0;

async function loadConfig(env) {
  process.env.AUTH_MODE = "none";
  process.env.AUTH_PIN = "";
  process.env.MCP_AUTH_TOKEN = "";
  process.env.OWNER_USER_ID = "";
  process.env.ALLOWED_DIRS = "";
  process.env.OWNER_DEFAULT_DIRS = "";
  process.env.PUBLIC_HOST = env.PUBLIC_HOST ?? "";
  process.env.NGROK_DOMAIN = env.NGROK_DOMAIN ?? "";
  process.env.APPROVAL_DATA_DIR = await mkdtemp(
    path.join(os.tmpdir(), "feishu-public-host-"),
  );
  const url = pathToFileURL(path.join(projectDir, "dist", "config.js"));
  url.searchParams.set("case", String(seq++));
  return import(url.href);
}

test("PUBLIC_HOST overrides legacy NGROK_DOMAIN", async () => {
  const mod = await loadConfig({ PUBLIC_HOST: "mcp.example.com", NGROK_DOMAIN: "old.ngrok.app" });
  assert.equal(mod.PUBLIC_HOST, "mcp.example.com");
});

test("legacy NGROK_DOMAIN remains a temporary fallback", async () => {
  const mod = await loadConfig({ NGROK_DOMAIN: "old.ngrok.app" });
  assert.equal(mod.PUBLIC_HOST, "old.ngrok.app");
});

test("no public host falls back to the empty value", async () => {
  const mod = await loadConfig({});
  assert.equal(mod.PUBLIC_HOST, "");
  assert.equal(mod.LEGACY_NGROK_DOMAIN, "");
});

test("index.ts allows the transport-neutral public host", () => {
  const source = readFileSync(path.join(projectDir, "src", "index.ts"), "utf8");
  assert.match(source, /PUBLIC_HOST/);
  assert.doesNotMatch(source, /allowedRequestHosts[\s\S]{0,120}NGROK_DOMAIN/);
});