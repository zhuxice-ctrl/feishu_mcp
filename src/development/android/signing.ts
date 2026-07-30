/**
 * Android artifact signing with local credential references.
 *
 * Signing resolves a keystore through host-path authorization and credential
 * ids through the local credential store, persists only `secretEnvRefs`
 * (`FEISHU_MCP_KS_PASS`, `FEISHU_MCP_KEY_PASS`) — never a literal secret — and
 * invokes `apksigner` via the fixed argument builder. The signed output is
 * staged to a temporary path, verified with `apksigner verify --verbose
 * --print-certs`, then atomically moved to the authorized output; on failure
 * the staging file is removed.
 */

import path from "node:path";
import { randomBytes } from "node:crypto";
import type { AndroidToolchain } from "./toolchain.js";
import { buildApksignerCommand } from "./commands.js";
import type { LocalCredentialStore } from "../credentials/dpapiStore.js";

export interface ApksignerSignRequest {
  inApk: string;
  outApk: string;
  keystore: string;
  ksAlias: string;
  ksCredentialId: string;
  keyCredentialId: string;
}

export interface ApksignerVerifyRequest {
  inApk: string;
}

export interface SigningPlanOptions {
  authorizeHostPath: (hostPath: string) => boolean;
  credentialStore: LocalCredentialStore;
}

export interface SignPlan {
  signPlan: { executable: string; args: string[] };
  verifyPlan: { executable: string; args: string[] };
  secretEnvRefs: Record<string, string>;
  stagingOut: string;
  outApk: string;
}

function authorize(p: string, authorizeHostPath: (p: string) => boolean): void {
  if (!authorizeHostPath(p)) {
    throw new Error(`host path outside authorized directory: ${p}`);
  }
}

export function planApksignerSign(
  toolchain: AndroidToolchain,
  request: ApksignerSignRequest,
  options: SigningPlanOptions,
): SignPlan {
  authorize(request.inApk, options.authorizeHostPath);
  authorize(request.outApk, options.authorizeHostPath);
  authorize(request.keystore, options.authorizeHostPath);

  if (!options.credentialStore.has(request.ksCredentialId)) {
    throw new Error(`unknown keystore credential id: ${request.ksCredentialId}`);
  }
  if (!options.credentialStore.has(request.keyCredentialId)) {
    throw new Error(`unknown key credential id: ${request.keyCredentialId}`);
  }

  const stagingOut = deriveStagingPath(request.outApk);
  const signPlan = buildApksignerCommand(toolchain, {
    action: "sign",
    inApk: request.inApk,
    outApk: stagingOut,
    keystore: request.keystore,
    ksAlias: request.ksAlias,
    ksPassEnv: "FEISHU_MCP_KS_PASS",
    keyPassEnv: "FEISHU_MCP_KEY_PASS",
  });
  const verifyPlan = buildApksignerCommand(toolchain, {
    action: "verify",
    inApk: stagingOut,
  });

  return {
    signPlan,
    verifyPlan,
    secretEnvRefs: {
      FEISHU_MCP_KS_PASS: request.ksCredentialId,
      FEISHU_MCP_KEY_PASS: request.keyCredentialId,
    },
    stagingOut,
    outApk: request.outApk,
  };
}

export function planApksignerVerify(
  toolchain: AndroidToolchain,
  request: ApksignerVerifyRequest,
  options: Pick<SigningPlanOptions, "authorizeHostPath">,
): { executable: string; args: string[] } {
  authorize(request.inApk, options.authorizeHostPath);
  return buildApksignerCommand(toolchain, { action: "verify", inApk: request.inApk });
}

function deriveStagingPath(outApk: string): string {
  const dir = path.dirname(outApk);
  const ext = path.extname(outApk);
  const base = path.basename(outApk, ext);
  return path.join(dir, `.${base}.${randomBytes(6).toString("hex")}${ext}`);
}
