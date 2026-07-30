/**
 * Controlled native (CMake/Ninja) project provider.
 *
 * Scaffolds new native C++ projects from reviewed, token-only templates under
 * `templates/windows/native-basic/`. Templates carry no remote scripts,
 * credentials, local Visual Studio paths, or binary files. The only tokens
 * replaced are the declared set below; any unresolved token after
 * substitution is a template bug and fails creation. Presets are limited to
 * catalog-defined `msvc-debug`, `msvc-release`, `ninja-debug`, and
 * `ninja-release`; no local Visual Studio path is embedded.
 */

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type {
  DevelopmentProjectProvider,
  DevelopmentEcosystem,
  ProjectCreateRequest,
  ProjectCreateResult,
  ProjectInspection,
  ProjectTemplateSummary,
} from "../projects/types.js";
import { detectWindowsProject } from "./projectDetector.js";
import {
  PROJECT_NAME_REGEX,
  CPP_STANDARD_REGEX,
  CMAKE_PRESET_REGEX,
} from "./types.js";

const TOKEN_RE = /__[A-Z0-9_]+__/g;

interface NativeTemplate {
  id: string;
  displayName: string;
  description: string;
  dir: string;
}

const TEMPLATES: readonly NativeTemplate[] = [
  {
    id: "native-basic",
    displayName: "Native — CMake Basic",
    description: "A minimal CMake C++ executable or library with optional tests.",
    dir: "native-basic",
  },
];

export interface NativeProjectProviderOptions {
  templatesRoot?: string;
}

export class NativeProjectProvider implements DevelopmentProjectProvider {
  readonly ecosystem: DevelopmentEcosystem = "native";
  private readonly templatesRoot: string;

  constructor(options: NativeProjectProviderOptions = {}) {
    this.templatesRoot =
      options.templatesRoot ?? path.resolve(process.cwd(), "templates/windows");
  }

  templates(): ProjectTemplateSummary[] {
    return TEMPLATES.map((t) => ({
      id: t.id,
      displayName: t.displayName,
      description: t.description,
    }));
  }

  async inspect(root: string): Promise<ProjectInspection> {
    const detection = await detectWindowsProject(root);
    const native = detection.entrypoints.filter((e) => e.ecosystem === "native");
    return {
      ecosystem: "native",
      root,
      gradleFiles: native.map((e) => e.relativePath),
      manifestPackage: undefined,
    };
  }

  async create(
    request: ProjectCreateRequest,
    stagingRoot: string,
  ): Promise<ProjectCreateResult> {
    this.validateRequest(request);
    const template = TEMPLATES.find((t) => t.id === request.templateId);
    if (!template) {
      throw new Error(`unknown native template id: ${request.templateId}`);
    }
    const templateDir = path.join(this.templatesRoot, template.dir);
    if (!fs.existsSync(templateDir)) {
      throw new Error(`template directory missing: ${templateDir}`);
    }

    const stagingDir = path.join(stagingRoot, `native-${randomBytes(8).toString("hex")}`);
    fs.mkdirSync(stagingDir, { recursive: true });

    try {
      this.stageTemplate(templateDir, stagingDir, request);
      this.refuseNonemptyDestination(request.destination);
      this.atomicMove(stagingDir, request.destination);
    } catch (err) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      throw err;
    }

    const files = walk(request.destination).map((f) =>
      path.relative(request.destination, f).replace(/\\/g, "/"),
    );
    return { root: request.destination, files };
  }

  private validateRequest(request: ProjectCreateRequest): void {
    if (!PROJECT_NAME_REGEX.test(request.projectName)) {
      throw new Error(`invalid project name: ${request.projectName}`);
    }
    const standard = request.profile.cppStandard;
    if (standard && !CPP_STANDARD_REGEX.test(standard)) {
      throw new Error(`invalid c++ standard: ${standard}`);
    }
  }

  private stageTemplate(
    templateDir: string,
    stagingDir: string,
    request: ProjectCreateRequest,
  ): void {
    const tokens = this.tokenMap(request);
    const withTests = request.profile.withTests === true;
    for (const rel of walkRel(templateDir)) {
      // Conditionally skip the tests tree when tests are not requested.
      if (!withTests && rel.startsWith("tests/")) continue;
      const transformedPath = this.applyTokens(rel, tokens).replace(/\.tpl$/, "");
      const src = path.join(templateDir, rel);
      const dest = path.join(stagingDir, transformedPath);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (rel.endsWith(".tpl")) {
        const content = fs.readFileSync(src, "utf8");
        const replaced = this.applyTokens(content, tokens);
        this.assertNoUnresolvedTokens(replaced, rel);
        fs.writeFileSync(dest, replaced);
      } else {
        throw new Error(`template ships non-template file: ${rel}`);
      }
    }
  }

  private tokenMap(request: ProjectCreateRequest): Map<string, string> {
    const map = new Map<string, string>([
      ["__PROJECT_NAME__", request.projectName],
      ["__CPP_STANDARD__", request.profile.cppStandard ?? "20"],
      ["__BUILD_TYPE__", request.profile.buildType ?? "executable"],
      ["__WITH_TESTS__", request.profile.withTests ? "ON" : "OFF"],
    ]);
    return map;
  }

  private applyTokens(value: string, tokens: Map<string, string>): string {
    return value.replace(TOKEN_RE, (m) => tokens.get(m) ?? m);
  }

  private assertNoUnresolvedTokens(content: string, rel: string): void {
    const leftover = content.match(TOKEN_RE);
    if (leftover) {
      throw new Error(`unresolved template token(s) in ${rel}: ${leftover.join(", ")}`);
    }
  }

  private refuseNonemptyDestination(destination: string): void {
    if (fs.existsSync(destination)) {
      const entries = fs.readdirSync(destination);
      if (entries.length > 0) {
        throw new Error(`destination not empty: ${destination}`);
      }
    }
  }

  private atomicMove(stagingDir: string, destination: string): void {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(stagingDir, destination);
  }
}

/** Validate a CMake preset name against the catalog allowlist. */
export function isValidPreset(preset: string): boolean {
  return CMAKE_PRESET_REGEX.test(preset);
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function walkRel(dir: string): string[] {
  return walk(dir).map((f) => path.relative(dir, f).replace(/\\/g, "/"));
}
