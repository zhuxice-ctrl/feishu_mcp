/**
 * Windows artifact signing with certificate references.
 *
 * Signing resolves a certificate through a credential id whose stored
 * fingerprint is the certificate thumbprint (SHA-1). The certificate is
 * pre-installed in CurrentUser\My; runtime signing never decrypts or imports
 * private certificate material. The fixed helper produces only a verified
 * sibling staging file and the worker owns atomic publication and cleanup.
 * SignTool is invoked with a fixed digest (sha256) and an allowlisted RFC 3161
 * timestamp origin. The signed output is staged, verified with
 * `signtool verify /pa /all`, then atomically moved to the authorized output.
 * Only public certificate metadata (thumbprint, alias) is returned — never the
 * private key, password, PFX path, or store name.
 */

import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { WindowsToolchain } from "./toolchain.js";
import type { LocalCredentialStore } from "../credentials/dpapiStore.js";
import { TIMESTAMP_ORIGIN_REGEX, CERT_THUMBPRINT_REGEX } from "./types.js";

/**
 * Public certificate metadata used for approval display. Only non-secret
 * fields; never includes the private key, password, or store path.
 */
export interface CertificatePublicMetadata {
  thumbprint: string;
  alias: string;
  subject: string;
  validFrom: string;
  validTo: string;
  codeSigningEku: boolean;
}

/**
 * Inspects a certificate by thumbprint and returns public metadata. The real
 * implementation queries the CurrentUser store via PowerShell; tests inject a
 * fake. Must never return a secret.
 */
export type CertificateInspector = (thumbprint: string) => CertificatePublicMetadata;

export interface WindowsSignRequest {
  inFile: string;
  outFile: string;
  /** Credential id whose stored fingerprint is the certificate thumbprint. */
  credentialId: string;
  timestampOrigin: string;
}

export interface WindowsVerifyRequest {
  inFile: string;
}

export interface SigningPlanOptions {
  authorizeHostPath: (hostPath: string) => boolean;
  credentialStore: LocalCredentialStore;
  /** Certificate inspector for EKU/validity checks. Optional in pure tests. */
  certInspector?: CertificateInspector;
}

/** A planned process step: executable + fixed args, `shell: false`. */
export interface PlannedStep {
  executable: string;
  args: string[];
}

export interface WindowsSignPlan {
  /** Fixed helper owns copy, sign, verify, atomic publish, and cleanup. */
  signCommand: PlannedStep;
  stagingOut: string;
  outFile: string;
  /** Public certificate metadata for approval display. */
  certificate: { thumbprint: string; alias: string };
}

export const WINDOWS_SIGNING_HELPER_PATH = fileURLToPath(
  new URL("./signingStage.js", import.meta.url),
);

export interface WindowsVerifyPlan {
  verifyCommand: PlannedStep;
}

function authorize(p: string, authorizeHostPath: (p: string) => boolean): void {
  if (!authorizeHostPath(p)) {
    throw new Error(`host path outside authorized directory: ${p}`);
  }
}

function validateTimestampOrigin(origin: string): void {
  if (!TIMESTAMP_ORIGIN_REGEX.test(origin)) {
    throw new Error(`untrusted timestamp origin: ${origin}`);
  }
}

function validateThumbprint(thumbprint: string): void {
  if (!CERT_THUMBPRINT_REGEX.test(thumbprint)) {
    throw new Error(`invalid certificate thumbprint: ${thumbprint}`);
  }
}

function deriveStagingPath(outFile: string): string {
  const dir = path.dirname(outFile);
  const ext = path.extname(outFile);
  const base = path.basename(outFile, ext);
  return path.join(dir, `.${base}.${randomBytes(6).toString("hex")}${ext}`);
}

/**
 * Resolve a signing credential and return public certificate metadata.
 * Throws if the credential id is unknown or the stored fingerprint is not a
 * valid SHA-1 thumbprint.
 */
export function resolveSigningCredential(
  credentialStore: LocalCredentialStore,
  credentialId: string,
  certInspector?: CertificateInspector,
): { thumbprint: string; alias: string; metadata?: CertificatePublicMetadata } {
  if (!credentialStore.has(credentialId)) {
    throw new Error(`unknown signing credential id: ${credentialId}`);
  }
  const entry = credentialStore.get(credentialId)!;
  if (entry.kind !== "certificate") {
    throw new Error("invalid Windows certificate credential");
  }
  validateThumbprint(entry.fingerprint);
  if (certInspector) {
    const meta = certInspector(entry.fingerprint);
    if (!meta.codeSigningEku) {
      throw new Error(`certificate lacks code-signing EKU: ${entry.fingerprint}`);
    }
    // ISO date compare; expired if validTo is in the past.
    const now = new Date();
    if (new Date(meta.validTo) < now) {
      throw new Error(`certificate expired: ${meta.validTo}`);
    }
    return { thumbprint: entry.fingerprint, alias: entry.alias, metadata: meta };
  }
  return { thumbprint: entry.fingerprint, alias: entry.alias };
}

/**
 * Plan a SignTool sign operation using a CurrentUser certificate-store
 * thumbprint. The input is copied to a staging path, signed in place, verified,
 * then moved to the authorized output.
 */
export function planSignToolSign(
  toolchain: WindowsToolchain,
  request: WindowsSignRequest,
  options: SigningPlanOptions,
): WindowsSignPlan {
  authorize(request.inFile, options.authorizeHostPath);
  authorize(request.outFile, options.authorizeHostPath);
  validateTimestampOrigin(request.timestampOrigin);

  const resolved = resolveSigningCredential(
    options.credentialStore,
    request.credentialId,
    options.certInspector,
  );

  const stagingOut = deriveStagingPath(request.outFile);
  const signCommand: PlannedStep = {
    executable: process.execPath,
    args: [
      WINDOWS_SIGNING_HELPER_PATH,
      "-SignToolPath", toolchain.signtool,
      "-InFile", request.inFile,
      "-StagingPath", stagingOut,
      "-Thumbprint", resolved.thumbprint,
      "-TimestampOrigin", request.timestampOrigin,
    ],
  };

  return {
    signCommand,
    stagingOut,
    outFile: request.outFile,
    certificate: { thumbprint: resolved.thumbprint, alias: resolved.alias },
  };
}

/**
 * Plan a standalone SignTool verify operation.
 */
export function planSignToolVerify(
  toolchain: WindowsToolchain,
  request: WindowsVerifyRequest,
  options: Pick<SigningPlanOptions, "authorizeHostPath">,
): WindowsVerifyPlan {
  authorize(request.inFile, options.authorizeHostPath);
  return {
    verifyCommand: {
      executable: toolchain.signtool,
      args: ["verify", "/pa", "/all", request.inFile],
    },
  };
}

/**
 * Hash the canonical (real) path of an artifact for launch-spec persistence.
 * Used by the run module to bind an approval to a specific on-disk artifact.
 */
export function canonicalPathHash(realPath: string): string {
  return createHash("sha256").update(realPath).digest("hex");
}
