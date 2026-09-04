/** Local-only networking checks for development server sessions. */

import http from "node:http";
import net from "node:net";
import os from "node:os";
import type { DevServerScope } from "./contracts.js";

export class DevServerNetworkError extends Error {}

export function assertPermittedPort(port: number, range: { min: number; max: number }, global: { min: number; max: number }): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new DevServerNetworkError("invalid server port");
  if (port < range.min || port > range.max || port < global.min || port > global.max) {
    throw new DevServerNetworkError("server port is outside its permitted range");
  }
}

export async function assertPortAvailable(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", () => reject(new DevServerNetworkError("server port is unavailable")));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close((error) => error ? reject(error) : resolve()));
  });
}

export async function waitForServerReady(port: number, healthPath = "/", timeoutMs = 60_000): Promise<void> {
  if (!healthPath.startsWith("/") || /:\/\/|[?#\0\r\n]/.test(healthPath)) throw new DevServerNetworkError("invalid health path");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await new Promise<boolean>((resolve) => {
      const request = http.get({ host: "127.0.0.1", port, path: healthPath, timeout: 1_000 }, (response) => {
        response.resume(); resolve((response.statusCode ?? 500) < 500);
      });
      request.once("error", () => resolve(false));
      request.once("timeout", () => { request.destroy(); resolve(false); });
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new DevServerNetworkError("server readiness timed out");
}

export function publicServerUrls(port: number, scope: DevServerScope): { localUrl: string; lanUrls: string[] } {
  const localUrl = `http://127.0.0.1:${port}`;
  if (scope === "local") return { localUrl, lanUrls: [] };
  const addresses = new Set<string>();
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("127.")) addresses.add(entry.address);
    }
  }
  return { localUrl, lanUrls: [...addresses].sort().map((address) => `http://${address}:${port}`) };
}
