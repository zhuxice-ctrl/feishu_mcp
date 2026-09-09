/**
 * ZeroXCore Profile — the first application Profile.
 *
 * This is the ONLY module that contains ZeroXCore-specific values (package
 * name, UI text, API paths).  No core module imports this file; the
 * coordinator receives the Profile through the ProfileRegistry by id.
 *
 * Design ref: docs/superpowers/specs/2026-08-15-staging-android-verify-design.md
 * "ZeroXCore 只是第一个 Profile，不得进入核心模块的业务分支。"
 */

import type { AndroidAppProfile } from "../contracts.js";
import type { ProfileNode } from "../topology.js";

/**
 * ZeroXCore staging verification graph.
 *
 * Happy path:
 *   tunnel_connected →[install] app_ready →[launch] scenario_started
 *   →[verify_binding] scenario_passed
 *
 * Offline branch (tunnel drops during verification):
 *   scenario_started →[verify_binding fails] tunnel_interrupted
 *   →[reconnect] tunnel_reconnected →[recover_binding] recovery_passed
 *
 * The coordinator transitions to evidence_written → completed after the
 * graph's terminal node, regardless of which branch was taken.
 */
const nodes: ProfileNode[] = [
  {
    id: "install_apk",
    type: "install_apk",
    label: "Install ZeroXCore APK",
    fromState: "tunnel_connected",
    onSuccess: "app_ready",
  },
  {
    id: "launch_app",
    type: "launch_app",
    label: "Launch ZeroXCore",
    fromState: "app_ready",
    onSuccess: "scenario_started",
  },
  {
    id: "verify_binding",
    type: "assert_text",
    label: "Verify binding screen is visible",
    assertion: { kind: "text_present", value: "内容", timeoutMs: 15_000 },
    fromState: "scenario_started",
    onSuccess: "scenario_passed",
    onFailure: "tunnel_interrupted",
  },
  {
    id: "reconnect_tunnel",
    type: "reconnect_tunnel",
    label: "Reconnect staging SSH tunnel",
    fromState: "tunnel_interrupted",
    onSuccess: "tunnel_reconnected",
  },
  {
    id: "recover_binding",
    type: "assert_text",
    label: "Re-verify binding after recovery",
    assertion: { kind: "text_present", value: "内容", timeoutMs: 15_000 },
    fromState: "tunnel_reconnected",
    onSuccess: "recovery_passed",
  },
];

export const zeroxcoreProfile: AndroidAppProfile = {
  id: "zeroxcore",
  version: 1,
  packageName: "tech.zeroxcore.nativeapp",
  activity: "tech.zeroxcore.nativeapp.MainActivity",
  tunnel: { remotePort: 3100, localPort: 3100 },
  graph: {
    entryState: "tunnel_connected",
    nodes,
  },
  capabilities: new Set<"ui" | "http" | "offline" | "recovery">(["ui", "http", "offline", "recovery"]),
  validate(input) {
    if (!input.workdir || !input.apkPath || !input.sshHost) {
      throw new Error("ZeroXCore Profile requires workdir, apkPath, and sshHost");
    }
  },
};
