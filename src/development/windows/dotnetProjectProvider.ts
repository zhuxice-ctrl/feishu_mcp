/**
 * Controlled .NET project provider.
 *
 * Scaffolds new .NET projects through the trusted `dotnet` executable: it
 * enumerates installed templates via `dotnet new list --format json` and
 * invokes `dotnet new <shortName> --name <validated> --output <staging>
 * --framework <enum>` with no caller switches, then moves the staging
 * directory atomically into the authorized destination. Only catalog-approved
 * short names are accepted. The provider never downloads templates, never
 * installs workload packs, and never accepts a caller-supplied template path
 * or NuGet source.
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
  DOTNET_TEMPLATE_SHORT_NAME_REGEX,
  TFM_REGEX,
} from "./types.js";

/**
 * Catalog-approved `dotnet new` short names. A caller may request only one of
 * these; WinUI/MSIX profiles require the matching workload to be installed.
 */
export const DOTNET_APPROVED_SHORT_NAMES = [
  "console",
  "classlib",
  "xunit",
  "wpf",
  "winui",
  "msix",
] as const;

export interface DotnetRunnerResult {
  stdout: string;
  exitCode: number | null;
}

export interface DotnetProjectProviderOptions {
  /** Run a trusted `dotnet` subcommand. In tests a fake returns canned output. */
  runDotnet: (args: string[]) => DotnetRunnerResult;
  /** Override the default approved short-name set (tests). */
  approvedShortNames?: readonly string[];
}

interface DotnetTemplateEntry {
  shortName: string;
}

export class DotnetProjectProvider implements DevelopmentProjectProvider {
  readonly ecosystem: DevelopmentEcosystem = "dotnet";
  private readonly runDotnet: DotnetProjectProviderOptions["runDotnet"];
  private readonly approved: readonly string[];

  constructor(options: DotnetProjectProviderOptions) {
    this.runDotnet = options.runDotnet;
    this.approved = options.approvedShortNames ?? DOTNET_APPROVED_SHORT_NAMES;
  }

  templates(): ProjectTemplateSummary[] {
    const installed = this.listInstalledShortNames();
    return this.approved
      .filter((id) => installed.includes(id))
      .map((id) => ({
        id,
        displayName: displayNameFor(id),
        description: descriptionFor(id),
      }));
  }

  async inspect(root: string): Promise<ProjectInspection> {
    const detection = await detectWindowsProject(root);
    const dotnet = detection.entrypoints.filter((e) => e.ecosystem === "dotnet");
    return {
      ecosystem: "dotnet",
      root,
      gradleFiles: dotnet.map((e) => e.relativePath),
      manifestPackage: undefined,
    };
  }

  async create(
    request: ProjectCreateRequest,
    stagingRoot: string,
  ): Promise<ProjectCreateResult> {
    this.validateRequest(request);
    if (!this.approved.includes(request.templateId)) {
      throw new Error(`unapproved dotnet template short name: ${request.templateId}`);
    }
    const installed = this.listInstalledShortNames();
    if (!installed.includes(request.templateId)) {
      // WinUI/MSIX profiles fail explicitly when the workload/template is missing.
      throw new Error(`dotnet template not installed: ${request.templateId}`);
    }

    const stagingDir = path.join(stagingRoot, `dotnet-${randomBytes(8).toString("hex")}`);
    fs.mkdirSync(stagingDir, { recursive: true });

    try {
      const args = [
        "new",
        request.templateId,
        "--name",
        request.projectName,
        "--output",
        stagingDir,
      ];
      const framework = request.profile.framework;
      if (framework) {
        if (!TFM_REGEX.test(framework)) {
          throw new Error(`invalid target framework: ${framework}`);
        }
        args.push("--framework", framework);
      }
      const result = this.runDotnet(args);
      if (result.exitCode !== 0) {
        throw new Error(`dotnet new failed (exit ${result.exitCode})`);
      }
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
    if (!DOTNET_TEMPLATE_SHORT_NAME_REGEX.test(request.templateId)) {
      throw new Error(`invalid dotnet template short name: ${request.templateId}`);
    }
  }

  private listInstalledShortNames(): string[] {
    const result = this.runDotnet(["new", "list", "--format", "json"]);
    if (result.exitCode !== 0) return [];
    try {
      const parsed = JSON.parse(result.stdout);
      const entries: unknown = Array.isArray(parsed) ? parsed : parsed?.templates;
      if (!Array.isArray(entries)) return [];
      return entries
        .map((e: unknown) => (e as DotnetTemplateEntry)?.shortName)
        .filter((s: unknown): s is string => typeof s === "string");
    } catch {
      return [];
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

function displayNameFor(id: string): string {
  switch (id) {
    case "console":
      return ".NET — Console";
    case "classlib":
      return ".NET — Class Library";
    case "xunit":
      return ".NET — xUnit Test";
    case "wpf":
      return ".NET — WPF";
    case "winui":
      return ".NET — WinUI";
    case "msix":
      return ".NET — MSIX Packaging";
    default:
      return id;
  }
}

function descriptionFor(id: string): string {
  switch (id) {
    case "console":
      return "A minimal .NET console application.";
    case "classlib":
      return "A .NET class library.";
    case "xunit":
      return "An xUnit test project.";
    case "wpf":
      return "A WPF desktop application (managed desktop workload).";
    case "winui":
      return "A WinUI 3 desktop application (Universal workload).";
    case "msix":
      return "An MSIX packaging project (Universal workload).";
    default:
      return id;
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
