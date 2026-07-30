/**
 * Stable project-provider contracts shared by the Android (and future
 * Windows/native) development adapters.
 *
 * The registry is a closed map keyed by ecosystem — it is not a generic
 * plug-in loader. A provider inspects an existing project root, enumerates the
 * reviewed templates it can scaffold, and stages a new project from a reviewed
 * template into an authorized destination. Templates carry no remote scripts,
 * credentials, local paths, wrapper JAR, or binary files.
 */

export type DevelopmentEcosystem = "android" | "dotnet" | "native" | "electron";

export interface ProjectInspection {
  ecosystem: DevelopmentEcosystem;
  root: string;
  gradleFiles: string[];
  manifestPackage?: string;
}

export interface ProjectTemplateSummary {
  id: string;
  displayName: string;
  description: string;
}

export interface ProjectTemplateProfile {
  compileSdk: number;
  minSdk: number;
  targetSdk: number;
  agp: string;
  kotlin: string;
  gradle: string;
  composeCompiler?: string;
  // --- Windows adapter fields (optional; ignored by Android) ---
  /** .NET target framework moniker, e.g. `net8.0`. */
  framework?: string;
  /** MSBuild configuration, e.g. `Debug` / `Release`. */
  configuration?: string;
  /** MSBuild platform, e.g. `AnyCPU` / `x64`. */
  platform?: string;
  /** C++ standard enum, e.g. `17` / `20`. */
  cppStandard?: string;
  /** Native build type: executable or library. */
  buildType?: "executable" | "library";
  /** Whether the native template includes a test target. */
  withTests?: boolean;
  /** Package manager for Electron projects. */
  packageManager?: "npm" | "pnpm" | "yarn";
}

export interface ProjectCreateRequest {
  templateId: string;
  projectName: string;
  packageId: string;
  destination: string;
  profile: ProjectTemplateProfile;
}

export interface ProjectCreateResult {
  root: string;
  files: string[];
}

export interface DevelopmentProjectProvider {
  readonly ecosystem: DevelopmentEcosystem;
  inspect(root: string): Promise<ProjectInspection>;
  templates(): ProjectTemplateSummary[];
  create(
    request: ProjectCreateRequest,
    stagingRoot: string,
  ): Promise<ProjectCreateResult>;
}
