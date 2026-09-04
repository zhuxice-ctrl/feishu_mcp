import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

const { buildServerLaunchPlan, createDevServerAdapters, DevServerAdapterError } = await import("../dist/development/servers/adapters.js");
const root = path.resolve(import.meta.dirname);
const executable = process.execPath;
const resolver = { resolve: () => executable };
const adapters = createDevServerAdapters(resolver);

function service(overrides = {}) {
  return { id: "web", label: "Web", runtime: "node", template: "pnpm_dev", script: "dev", workingDirectory: root, scopes: ["local", "lan"], portRange: { min: 5173, max: 5179 }, healthPath: "/", ...overrides };
}

test("node adapter creates an absolute closed launch plan and only scope changes host", () => {
  const local = buildServerLaunchPlan(service(), { port: 5173, scope: "local" }, adapters);
  const lan = buildServerLaunchPlan(service(), { port: 5173, scope: "lan" }, adapters);
  assert.equal(path.isAbsolute(local.executable), true);
  assert.equal(local.cwd, root);
  assert.deepEqual(local.args, ["run", "dev", "--", "--host", "127.0.0.1", "--port", "5173"]);
  assert.deepEqual(lan.args, ["run", "dev", "--", "--host", "0.0.0.0", "--port", "5173"]);
  assert.deepEqual(local.env, { NODE_ENV: "development" });
});

test("closed adapters reject unsupported templates and unavailable runtimes", () => {
  assert.throws(() => buildServerLaunchPlan(service({ template: "shell" }), { port: 5173, scope: "local" }, adapters), DevServerAdapterError);
  assert.throws(() => buildServerLaunchPlan(service(), { port: 5173, scope: "local" }, createDevServerAdapters({ resolve: () => undefined })), /runtime is unavailable/);
});

test("python, Android and generic adapters accept only their catalog tokens", () => {
  assert.deepEqual(buildServerLaunchPlan({ ...service({ runtime: "python", template: "uvicorn", app: "api:app" }) }, { port: 5173, scope: "lan" }, adapters).args, ["-m", "uvicorn", "api:app", "--host", "0.0.0.0", "--port", "5173"]);
  assert.deepEqual(buildServerLaunchPlan({ ...service({ runtime: "android", template: "adb_reverse", target: "emulator-5554" }) }, { port: 5173, scope: "local" }, adapters).args, ["-s", "emulator-5554", "reverse", "tcp:5173", "tcp:5173"]);
  const generic = buildServerLaunchPlan({ ...service({ runtime: "generic", template: "static_node", directory: "." }) }, { port: 5173, scope: "local" }, adapters);
  assert.equal(generic.args[0], "-e");
});
