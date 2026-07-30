/**
 * Gradle build/test planning and project-script integrity.
 *
 * Before any Gradle task runs, the adapter verifies the project's wrapper is
 * aligned with the trusted catalog (distribution on `services.gradle.org`,
 * `distributionSha256Sum` present, `gradlew` present), digests the executable
 * project scripts (with sensitive `gradle.properties` entries redacted), and
 * binds that digest to the approval subject so a changed build script forces
 * re-approval. A caller never supplies a Gradle task or flag — the action is
 * mapped to exactly one fixed task by {@link buildGradleCommand}.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AndroidToolchain } from "./toolchain.js";
import { buildGradleCommand } from "./commands.js";
import type { GradleCommand } from "./types.js";

const ALLOWED_DISTRIBUTION_HOST = "services.gradle.org";
const HEX64 = /^[0-9a-f]{64}$/;
const SENSITIVE_PROP_RE = /(password|secret|key|token|credential)/i;

export interface GradleWrapperValidation {
  valid: boolean;
  distributionUrl?: string;
  distributionSha256Sum?: string;
  reason?: string;
}

export interface GradleActionPlan {
  executable: string;
  args: string[];
  cwd: string;
  scriptDigest: string;
  artifactRoots: string[];
  timeoutMs: number;
  successExitCodes: number[];
}

export interface GradleActionRequest {
  root: string;
  module: string;
  variant: "debug" | "release";
  action: "build" | "bundle" | "test_unit" | "test_instrumented" | "clean";
  timeoutMs: number;
}

function readWrapperProperties(root: string): Record<string, string> | undefined {
  const propsPath = path.join(root, "gradle/wrapper/gradle-wrapper.properties");
  if (!fs.existsSync(propsPath)) return undefined;
  const text = fs.readFileSync(propsPath, "utf8");
  const map: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) map[m[1].trim()] = m[2].trim();
  }
  return map;
}

function unescapePropsUrl(value: string): string {
  return value.replace(/\\:/g, ":");
}

export function validateGradleWrapper(root: string): GradleWrapperValidation {
  const gradlew = fs.existsSync(path.join(root, "gradlew")) || fs.existsSync(path.join(root, "gradlew.bat"));
  if (!gradlew) {
    return { valid: false, reason: "missing gradlew" };
  }
  const props = readWrapperProperties(root);
  if (!props) {
    return { valid: false, reason: "missing gradle-wrapper.properties" };
  }
  const rawUrl = props.distributionUrl;
  if (!rawUrl) {
    return { valid: false, reason: "missing distributionUrl" };
  }
  const url = unescapePropsUrl(rawUrl);
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return { valid: false, reason: "invalid distributionUrl" };
  }
  if (host !== ALLOWED_DISTRIBUTION_HOST) {
    return { valid: false, distributionUrl: url, reason: `distribution host not allowed: ${host}` };
  }
  const sha = props.distributionSha256Sum;
  if (!sha || !HEX64.test(sha)) {
    return { valid: false, distributionUrl: url, reason: "missing or invalid distributionSha256Sum" };
  }
  return { valid: true, distributionUrl: url, distributionSha256Sum: sha };
}

export function discoverModules(root: string): string[] {
  const modules: string[] = [];
  for (const name of ["settings.gradle.kts", "settings.gradle"]) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    const re = /include\s*\(\s*"([^"]+)"\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const mod = m[1].replace(/^:/, "");
      if (mod) modules.push(mod);
    }
  }
  return modules;
}

function readFileText(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

function redactProperties(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (!m) return line;
      const key = m[1].trim();
      if (SENSITIVE_PROP_RE.test(key)) return `${key}=<redacted>`;
      return line;
    })
    .join("\n");
}

function sha256File(file: string): string | undefined {
  if (!fs.existsSync(file)) return undefined;
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function digestProjectScripts(root: string, module: string): string {
  const entries: Record<string, string | undefined> = {
    module,
    settings: readFileText(path.join(root, "settings.gradle.kts")) || readFileText(path.join(root, "settings.gradle")),
    rootBuild: readFileText(path.join(root, "build.gradle.kts")) || readFileText(path.join(root, "build.gradle")),
    moduleBuild: readFileText(path.join(root, module, "build.gradle.kts")) || readFileText(path.join(root, module, "build.gradle")),
    gradleProperties: redactProperties(readFileText(path.join(root, "gradle.properties"))),
    versionCatalog: readFileText(path.join(root, "gradle/libs.versions.toml")),
    wrapperProperties: readFileText(path.join(root, "gradle/wrapper/gradle-wrapper.properties")),
    wrapperJarSha256: sha256File(path.join(root, "gradle/wrapper/gradle-wrapper.jar")),
  };
  return createHash("sha256").update(JSON.stringify(entries), "utf8").digest("hex");
}

function artifactRootsFor(root: string, module: string, variant: string, action: GradleActionRequest["action"]): string[] {
  const v = cap(variant);
  const base = path.join(root, module, "build");
  switch (action) {
    case "build":
      return [
        path.join(base, "outputs", "apk", variant),
        path.join(base, "outputs", "bundle", variant),
      ];
    case "bundle":
      return [path.join(base, "outputs", "bundle", variant)];
    case "test_unit":
      return [
        path.join(base, "test-results", `test${v}UnitTest`),
        path.join(base, "reports", "tests", `test${v}UnitTest`),
      ];
    case "test_instrumented":
      return [
        path.join(base, "outputs", "androidTest-results", "connected", variant),
        path.join(base, "reports", "androidTest", "connected", variant),
      ];
    case "clean":
      return [];
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function planGradleAction(
  toolchain: AndroidToolchain,
  request: GradleActionRequest,
): GradleActionPlan {
  const wrapper = validateGradleWrapper(request.root);
  if (!wrapper.valid) {
    throw new Error(`untrusted gradle wrapper: ${wrapper.reason}`);
  }
  const modules = discoverModules(request.root);
  if (!modules.includes(request.module)) {
    throw new Error(`unknown gradle module: ${request.module}`);
  }
  const built = buildGradleCommand(toolchain, {
    action: request.action,
    module: request.module,
    variant: request.variant,
    projectDir: request.root,
  } satisfies GradleCommand);
  const scriptDigest = digestProjectScripts(request.root, request.module);
  return {
    executable: built.executable,
    args: built.args,
    cwd: request.root,
    scriptDigest,
    artifactRoots: artifactRootsFor(request.root, request.module, request.variant, request.action),
    timeoutMs: request.timeoutMs,
    successExitCodes: [0],
  };
}
