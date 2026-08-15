/**
 * ProfileRegistry — application Profile and plugin registration with version,
 * capability, and fixed-policy validation.
 *
 * Core modules import ONLY this registry's generic interface; they never
 * import a concrete Profile (such as ZeroXCore).  `coreSchema()` exposes the
 * generic contract surface and deliberately excludes application-specific
 * values (package names, UI text, API paths) so the core coordinator cannot
 * accidentally branch on them.
 *
 * Design ref: docs/superpowers/specs/2026-08-15-staging-android-verify-design.md
 * "新增普通 App 只添加新 Profile，不改核心协调器。"
 */

import {
  ALLOWED_NODE_ACTIONS,
  WORKFLOW_STATES,
  validateGraph,
  type AndroidAppProfile,
  type ProfileCapability,
  type ProfilePlugin,
} from "./contracts.js";
import type { ProfileNode } from "./topology.js";

const ALLOWED_CAPABILITIES: ReadonlySet<ProfileCapability> = new Set([
  "ui", "http", "offline", "recovery",
]);

// ---------------------------------------------------------------------------
// ProfileRegistry
// ---------------------------------------------------------------------------

export class ProfileRegistry {
  private readonly profiles = new Map<string, AndroidAppProfile>();
  private readonly plugins = new Map<string, ProfilePlugin>();

  /**
   * Register an application Profile.
   *
   * Validation:
   * - version must be a positive integer
   * - id must be unique and non-empty
   * - capabilities must be a subset of the allowed set
   * - tunnel ports must both be 3100 (fixed staging loopback)
   * - graph node action types must be declared
   * - every ProfileNode.fromState must be a known workflow state
   */
  register(profile: AndroidAppProfile): void {
    if (!profile.id || typeof profile.id !== "string") {
      throw new Error("Profile.id is required");
    }
    if (!Number.isInteger(profile.version) || profile.version <= 0) {
      throw new Error(`Profile ${profile.id}: version must be a positive integer`);
    }
    if (this.profiles.has(profile.id)) {
      throw new Error(`Profile ${profile.id} is already registered`);
    }
    for (const cap of profile.capabilities) {
      if (!ALLOWED_CAPABILITIES.has(cap)) {
        throw new Error(`Profile ${profile.id}: unknown capability ${cap}`);
      }
    }
    if (profile.tunnel.localPort !== 3100 || profile.tunnel.remotePort !== 3100) {
      throw new Error(
        `Profile ${profile.id}: tunnel ports must be 3100, got local=${profile.tunnel.localPort} remote=${profile.tunnel.remotePort}`,
      );
    }
    // validateGraph checks node action types + onSuccess/onFailure states.
    validateGraph(profile.graph);
    // Validate ProfileNode.fromState for every node.
    for (const node of profile.graph.nodes as ReadonlyArray<ProfileNode>) {
      const fromState = (node as ProfileNode).fromState;
      if (typeof fromState === "string") {
        if (!WORKFLOW_STATES.has(fromState)) {
          throw new Error(`Profile ${profile.id}: node ${node.id} has unknown fromState ${fromState}`);
        }
      }
    }
    this.profiles.set(profile.id, profile);
  }

  /** Resolve a Profile by id.  Throws if unknown. */
  get(id: string): AndroidAppProfile {
    const profile = this.profiles.get(id);
    if (!profile) {
      throw new Error(`unknown profile: ${id}`);
    }
    return profile;
  }

  /** True if a Profile is registered. */
  has(id: string): boolean {
    return this.profiles.has(id);
  }

  /** List all registered Profile ids. */
  list(): string[] {
    return [...this.profiles.keys()];
  }

  /**
   * Register a restricted plugin.  Plugins are keyed by explicit registry
   * entry only — the core never loads arbitrary paths.  Plugin capabilities
   * are validated against the same allowlist.
   */
  registerPlugin(plugin: ProfilePlugin): void {
    if (!plugin.id || typeof plugin.id !== "string") {
      throw new Error("Plugin.id is required");
    }
    if (!Number.isInteger(plugin.version) || plugin.version <= 0) {
      throw new Error(`Plugin ${plugin.id}: version must be a positive integer`);
    }
    if (this.plugins.has(plugin.id)) {
      throw new Error(`Plugin ${plugin.id} is already registered`);
    }
    for (const cap of plugin.capabilities) {
      if (!ALLOWED_CAPABILITIES.has(cap)) {
        throw new Error(`Plugin ${plugin.id}: unknown capability ${cap}`);
      }
    }
    this.plugins.set(plugin.id, plugin);
  }

  /** Resolve a plugin by id, or undefined. */
  plugin(id: string): ProfilePlugin | undefined {
    return this.plugins.get(id);
  }

  /**
   * Return a JSON string describing the generic Profile contract surface.
   *
   * Deliberately excludes application-specific values (package names, UI
   * text, API paths, directories) so core modules can introspect the schema
   * without leaking application identity.
   */
  coreSchema(): string {
    return JSON.stringify({
      contractVersion: 1,
      fields: ["id", "version", "packageName", "activity", "tunnel", "graph", "capabilities"],
      capabilities: [...ALLOWED_CAPABILITIES],
      nodeActions: [...ALLOWED_NODE_ACTIONS],
      device: "emulator-5554",
      tunnelPorts: [3100],
      states: [...WORKFLOW_STATES],
    });
  }
}
