/**
 * Windows artifact signing with certificate references.
 *
 * Signing resolves a certificate through a credential id whose stored
 * fingerprint is the certificate thumbprint (SHA-1). For an encrypted PFX
 * reference the fixed local helper
 * (`scripts/import-development-signing-credential.ps1`) decrypts the blob with
 * DPAPI CurrentUser and imports it into a temporary CurrentUser store location
 * — the password never appears on a command line — then removes it in a
 * cleanup step. SignTool is invoked with a fixed digest (sha256) and an
 * allowlisted RFC 3161 timestamp origin. The signed output is staged to a
 * temporary path (SignTool signs in place), verified with
 * `signtool verify /pa /all`, then atomically moved to the authorized output.
 * Only public certificate metadata (thumbprint, alias) is returned — never the
 * private key, password, PFX path, or store name.
 */

import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
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

export interface WindowsPfxSignRequest extends WindowsSignRequest {
  /** Path to the reviewed DPAPI import helper. */
  helperPath: string;
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
  /** PFX only: DPAPI decrypt + import into temp store (no password arg). */
  importStep?: PlannedStep;
  /** Copy the input to a staging path so SignTool signs in place safely. */
  stageCopy: { src: string; dest: string };
  signCommand: PlannedStep;
  verifyCommand: PlannedStep;
  /** PFX only: remove the temporary store in a `finally`-style step. */
  cleanupStep?: PlannedStep;
  stagingOut: string;
  outFile: string;
  /** Public certificate metadata for approval display. */
  certificate: { thumbprint: string; alias: string };
}

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
    executable: toolchain.signtool,
    args: [
      "sign",
      "/fd", "sha256",
      "/td", "sha256",
      "/tr", request.timestampOrigin,
      "/sha1", resolved.thumbprint,
      stagingOut,
    ],
  };
  const verifyCommand: PlannedStep = {
    executable: toolchain.signtool,
    args: ["verify", "/pa", "/all", stagingOut],
  };

  return {
    stageCopy: { src: request.inFile, dest: stagingOut },
    signCommand,
    verifyCommand,
    stagingOut,
    outFile: request.outFile,
    certificate: { thumbprint: resolved.thumbprint, alias: resolved.alias },
  };
}

/**
 * Plan a SignTool sign operation using an encrypted PFX reference. The fixed
 * local helper decrypts the PFX with DPAPI and imports it into a temporary
 * CurrentUser store — the password is never placed on the command line — then
 * a cleanup step removes the temp store afterward. The certificate thumbprint
 * (stored as the credential fingerprint) selects the cert within the temp
 * store.
 */
export function planPfxSign(
  toolchain: WindowsToolchain,
  request: WindowsPfxSignRequest,
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

  const tempStoreName = `FeishuMcpTemp${randomBytes(8).toString("hex")}`;
  const stagingOut = deriveStagingPath(request.outFile);

  // No password argument: the helper reads the DPAPI-encrypted blob itself.
  const importStep: PlannedStep = {
    executable: "powershell.exe",
    args: [
      "-NoProfile", "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-File", request.helperPath,
      "-CredentialId", request.credentialId,
      "-TempStoreName", tempStoreName,
    ],
  };
  const cleanupStep: PlannedStep = {
    executable: "powershell.exe",
    args: [
      "-NoProfile", "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-File", request.helperPath,
      "-Cleanup",
      "-TempStoreName", tempStoreName,
    ],
  };
  const signCommand: PlannedStep = {
    executable: toolchain.signtool,
    args: [
      "sign",
      "/fd", "sha256",
      "/td", "sha256",
      "/tr", request.timestampOrigin,
      "/s", tempStoreName,
      "/sha1", resolved.thumbprint,
      stagingOut,
    ],
  };
  const verifyCommand: PlannedStep = {
    executable: toolchain.signtool,
    args: ["verify", "/pa", "/all", stagingOut],
  };

  return {
    importStep,
    stageCopy: { src: request.inFile, dest: stagingOut },
    signCommand,
    verifyCommand,
    cleanupStep,
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
