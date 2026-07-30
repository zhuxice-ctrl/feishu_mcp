/**
 * Controlled Electron project provider.
 *
 * Scaffolds new Electron projects from a reviewed, locked template under
 * `templates/windows/electron-basic/`. The template pins Electron and
 * packager versions in both template files, includes scripts `start`, `test`,
 * and `package`, and contains no postinstall download script outside the
 * pinned dependency lifecycle. Rendering replaces only project name, package
 * id, product name, and package-manager profile — no install is performed
 * during rendering. Manifest inspection is delegated to
 * {@link inspectElectronManifest}.
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
import { PROJECT_NAME_REGEX, PACKAGE_ID_REGEX, PACKAGE_MANAGER_REGEX } from "./types.js";
import { inspectElectronManifest } from "./electronManifest.js";

const TOKEN_RE = /__[A-Z0-9_]+__/g;

interface ElectronTemplate {
  id: string;
  displayName: string;
  description: string;
  dir: string;
}

const TEMPLATES: readonly ElectronTemplate[] = [
  {
    id: "electron-basic",
    displayName: "Electron — Basic",
    description: "A locked Electron desktop application with start/test/package scripts.",
    dir: "electron-basic",
  },
];

export interface ElectronProjectProviderOptions {
  templatesRoot?: string;
}

export class ElectronProjectProvider implements DevelopmentProjectProvider {
  readonly ecosystem: DevelopmentEcosystem = "electron";
  private readonly templatesRoot: string;

  constructor(options: ElectronProjectProviderOptions = {}) {
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
    const electron = detection.entrypoints.filter((e) => e.ecosystem === "electron");
    return {
      ecosystem: "electron",
      root,
      gradleFiles: electron.map((e) => e.relativePath),
      manifestPackage: undefined,
    };
  }

  /**
   * Strict manifest inspection: parse JSON without prototype keys, require one
   * recognized lockfile, map it to exactly one package manager, and return
   * script names plus SHA-256 of exact script text. Never returns registry
   * credentials.
   */
  inspectManifest(root: string): ReturnType<typeof inspectElectronManifest> {
    return inspectElectronManifest(root);
  }

  async create(
    request: ProjectCreateRequest,
    stagingRoot: string,
  ): Promise<ProjectCreateResult> {
    this.validateRequest(request);
    const template = TEMPLATES.find((t) => t.id === request.templateId);
    if (!template) {
      throw new Error(`unknown electron template id: ${request.templateId}`);
    }
    const templateDir = path.join(this.templatesRoot, template.dir);
    if (!fs.existsSync(templateDir)) {
      throw new Error(`template directory missing: ${templateDir}`);
    }

    const stagingDir = path.join(stagingRoot, `electron-${randomBytes(8).toString("hex")}`);
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
    if (!PACKAGE_ID_REGEX.test(request.packageId)) {
      throw new Error(`invalid package id: ${request.packageId}`);
    }
    const pm = request.profile.packageManager;
    if (pm && !PACKAGE_MANAGER_REGEX.test(pm)) {
      throw new Error(`invalid package manager: ${pm}`);
    }
  }

  private stageTemplate(
    templateDir: string,
    stagingDir: string,
    request: ProjectCreateRequest,
  ): void {
    const tokens = this.tokenMap(request);
    for (const rel of walkRel(templateDir)) {
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
    const pm = request.profile.packageManager ?? "npm";
    return new Map<string, string>([
      ["__PROJECT_NAME__", request.projectName],
      ["__PACKAGE_ID__", request.packageId],
      ["__PRODUCT_NAME__", request.projectName],
      ["__PACKAGE_MANAGER__", pm],
    ]);
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
