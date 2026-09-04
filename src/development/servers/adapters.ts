/** Closed runtime adapters for catalog-declared local development servers. */

import path from "node:path";
import { existsSync, realpathSync } from "node:fs";
import type { CanonicalDevServer, DevServerRuntime, DevServerScope } from "./contracts.js";

export class DevServerAdapterError extends Error {
  constructor(
    public readonly code: "RUNTIME_UNAVAILABLE" | "ANDROID_ENVIRONMENT_UNAVAILABLE" | "UNSUPPORTED_SERVICE_TEMPLATE",
    message: string,
  ) { super(message); }
}

export interface DevServerLaunchPlan {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  port: number;
  bindHost: "127.0.0.1" | "0.0.0.0";
  healthPath?: string;
}

export interface DevServerAdapter {
  readonly runtime: DevServerRuntime;
  build(service: CanonicalDevServer, input: { port: number; scope: DevServerScope }): DevServerLaunchPlan;
}

export interface DevServerExecutableResolver {
  resolve(name: "node" | "npm" | "pnpm" | "yarn" | "python" | "adb" | "gradle"): string | undefined;
}

function absoluteExisting(candidate: string | undefined): string | undefined {
  if (!candidate || !path.isAbsolute(candidate) || !existsSync(candidate)) return undefined;
  try { return realpathSync.native(candidate); } catch { return undefined; }
}

/** Production resolver intentionally trusts only absolute, existing executables. */
export const environmentExecutableResolver: DevServerExecutableResolver = {
  resolve(name) {
    if (name === "node" && process.execPath) return absoluteExisting(process.execPath);
    const envNames: Record<Exclude<typeof name, "node">, string> = {
      npm: "NPM_EXECUTABLE", pnpm: "PNPM_EXECUTABLE", yarn: "YARN_EXECUTABLE",
      python: "PYTHON_EXECUTABLE", adb: "ADB_EXECUTABLE", gradle: "GRADLE_EXECUTABLE",
    };
    return absoluteExisting(process.env[envNames[name as Exclude<typeof name, "node">]]);
  },
};

function executable(
  resolver: DevServerExecutableResolver,
  name: Parameters<DevServerExecutableResolver["resolve"]>[0],
  android = false,
): string {
  const resolved = resolver.resolve(name);
  if (!resolved || !path.isAbsolute(resolved)) {
    throw new DevServerAdapterError(
      android ? "ANDROID_ENVIRONMENT_UNAVAILABLE" : "RUNTIME_UNAVAILABLE",
      `${name} runtime is unavailable`,
    );
  }
  return resolved;
}

function plan(
  executablePath: string,
  args: string[],
  service: CanonicalDevServer,
  input: { port: number; scope: DevServerScope },
): DevServerLaunchPlan {
  return {
    executable: executablePath,
    args,
    cwd: service.workingDirectory,
    env: { NODE_ENV: "development" },
    port: input.port,
    bindHost: input.scope === "lan" ? "0.0.0.0" : "127.0.0.1",
    ...(service.healthPath === undefined ? {} : { healthPath: service.healthPath }),
  };
}

function nodeAdapter(resolver: DevServerExecutableResolver): DevServerAdapter {
  return {
    runtime: "node",
    build(service, input) {
      if (service.runtime !== "node") throw new DevServerAdapterError("UNSUPPORTED_SERVICE_TEMPLATE", "node service required");
      const manager = service.template === "pnpm_dev" ? "pnpm" : service.template === "npm_dev" ? "npm" : service.template === "yarn_dev" ? "yarn" : undefined;
      if (!manager) throw new DevServerAdapterError("UNSUPPORTED_SERVICE_TEMPLATE", "unsupported service template");
      const command = executable(resolver, manager);
      const base = manager === "npm" ? ["run", service.script] : ["run", service.script];
      return plan(command, [...base, "--", "--host", input.scope === "lan" ? "0.0.0.0" : "127.0.0.1", "--port", String(input.port)], service, input);
    },
  };
}

function pythonAdapter(resolver: DevServerExecutableResolver): DevServerAdapter {
  return {
    runtime: "python",
    build(service, input) {
      if (service.runtime !== "python") throw new DevServerAdapterError("UNSUPPORTED_SERVICE_TEMPLATE", "python service required");
      const command = executable(resolver, "python");
      const host = input.scope === "lan" ? "0.0.0.0" : "127.0.0.1";
      const args = service.template === "flask"
        ? ["-m", "flask", "--app", service.app, "run", "--host", host, "--port", String(input.port)]
        : service.template === "django"
          ? ["-m", "django", "runserver", `${host}:${input.port}`]
          : service.template === "uvicorn"
            ? ["-m", "uvicorn", service.app, "--host", host, "--port", String(input.port)]
            : undefined;
      if (!args) throw new DevServerAdapterError("UNSUPPORTED_SERVICE_TEMPLATE", "unsupported service template");
      return plan(command, args, service, input);
    },
  };
}

function androidAdapter(resolver: DevServerExecutableResolver): DevServerAdapter {
  return {
    runtime: "android",
    build(service, input) {
      if (service.runtime !== "android") throw new DevServerAdapterError("UNSUPPORTED_SERVICE_TEMPLATE", "android service required");
      if (service.template === "adb_reverse") {
        return plan(executable(resolver, "adb", true), ["-s", service.target, "reverse", `tcp:${input.port}`, `tcp:${input.port}`], service, input);
      }
      if (service.template === "gradle_install") {
        const wrapper = process.platform === "win32" ? path.join(service.workingDirectory, "gradlew.bat") : path.join(service.workingDirectory, "gradlew");
        if (!existsSync(wrapper)) throw new DevServerAdapterError("ANDROID_ENVIRONMENT_UNAVAILABLE", "Gradle wrapper is unavailable");
        return plan(path.resolve(wrapper), [service.target], service, input);
      }
      throw new DevServerAdapterError("UNSUPPORTED_SERVICE_TEMPLATE", "unsupported service template");
    },
  };
}

function genericAdapter(resolver: DevServerExecutableResolver): DevServerAdapter {
  return {
    runtime: "generic",
    build(service, input) {
      if (service.runtime !== "generic" || service.template !== "static_node") {
        throw new DevServerAdapterError("UNSUPPORTED_SERVICE_TEMPLATE", "unsupported service template");
      }
      const command = executable(resolver, "node");
      // This program is adapter-owned, not catalog/caller supplied. It serves
      // only the catalog directory and has no shell interpolation.
      const program = "const http=require('node:http'),fs=require('node:fs'),path=require('node:path');const root=process.argv[1],host=process.argv[2],port=Number(process.argv[3]);http.createServer((q,r)=>{const p=path.resolve(root,'.'+new URL(q.url,'http://x').pathname);if(!p.startsWith(root)||!fs.existsSync(p)){r.statusCode=404;r.end();return}r.end(fs.readFileSync(p))}).listen(port,host)";
      return plan(command, ["-e", program, path.resolve(service.workingDirectory, service.directory), input.scope === "lan" ? "0.0.0.0" : "127.0.0.1", String(input.port)], service, input);
    },
  };
}

export function createDevServerAdapters(
  resolver: DevServerExecutableResolver = environmentExecutableResolver,
): Map<DevServerRuntime, DevServerAdapter> {
  return new Map([
    ["node", nodeAdapter(resolver)], ["python", pythonAdapter(resolver)],
    ["android", androidAdapter(resolver)], ["generic", genericAdapter(resolver)],
  ]);
}

export function buildServerLaunchPlan(
  service: CanonicalDevServer,
  input: { port: number; scope: DevServerScope },
  adapters = createDevServerAdapters(),
): DevServerLaunchPlan {
  const adapter = adapters.get(service.runtime);
  if (!adapter) throw new DevServerAdapterError("UNSUPPORTED_SERVICE_TEMPLATE", "unsupported service runtime");
  return adapter.build(service, input);
}
