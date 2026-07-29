/**
 * Windows Authenticode signature verification.
 *
 * A fixed `powershell.exe` path is invoked with a repository-owned script
 * body (never a caller-supplied string) that calls
 * `Get-AuthenticodeSignature -LiteralPath` and emits compact JSON. The target
 * path is passed through an environment variable, never interpolated into the
 * script, so a path can never become a command. A failed, unsigned, or
 * unexpected publisher is untrusted. Tests inject a verifier into the
 * resolver instead of calling this module with a real signature.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DEFAULT_POWERSHELL_PATH =
  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

/**
 * Repository-owned script body. Reads the target from FEISHU_SIG_TARGET so no
 * path is ever interpolated. Emits one compact JSON object on stdout.
 */
export const DEFAULT_SIGNATURE_SCRIPT = `$ErrorActionPreference='Stop';
$sig = Get-AuthenticodeSignature -LiteralPath $env:FEISHU_SIG_TARGET;
$status = if ($sig.Status) { $sig.Status.ToString() } else { 'NotFound' };
$subject = if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { '' };
$thumb = if ($sig.SignerCertificate) { $sig.SignerCertificate.Thumbprint } else { '' };
[PSCustomObject]@{ status=$status; signerSubject=$subject; thumbprint=$thumb } | ConvertTo-Json -Compress`;

export interface SignatureFact {
  status: string;
  signerSubject: string;
  thumbprint: string;
}

export interface SignatureVerification {
  publisher?: string;
  trusted: boolean;
  thumbprint?: string;
}

export type SignatureRunner = (args: string[], env: NodeJS.ProcessEnv) => Promise<string>;

async function defaultRunner(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync(args[0], args.slice(1), {
    env,
    maxBuffer: 64 * 1024,
    windowsHide: true,
    shell: false,
  });
  return stdout.trim();
}

export interface VerifyWindowsSignatureOptions {
  publishers: string[];
  powershellPath?: string;
  scriptBody?: string;
  runner?: SignatureRunner;
  /** Timeout for the PowerShell invocation. */
  timeoutMs?: number;
}

/**
 * Verify the Authenticode signature of `executablePath`. Returns
 * `{ trusted: false }` for any unsigned, failed, or unexpected-publisher
 * binary. The publisher is the first expected publisher whose name appears in
 * the signer subject (case-insensitive).
 */
export async function verifyWindowsSignature(
  executablePath: string,
  options: VerifyWindowsSignatureOptions,
): Promise<SignatureVerification> {
  const powershellPath = options.powershellPath ?? DEFAULT_POWERSHELL_PATH;
  const scriptBody = options.scriptBody ?? DEFAULT_SIGNATURE_SCRIPT;
  const runner = options.runner ?? defaultRunner;
  const env = { ...process.env, FEISHU_SIG_TARGET: executablePath };
  let raw: string;
  try {
    raw = await runner([powershellPath, "-NoProfile", "-NonInteractive", "-Command", scriptBody], env);
  } catch {
    return { trusted: false };
  }
  let fact: SignatureFact;
  try {
    fact = JSON.parse(raw) as SignatureFact;
  } catch {
    return { trusted: false };
  }
  if (!fact || fact.status !== "Valid") {
    return { trusted: false, thumbprint: fact?.thumbprint };
  }
  const subject = (fact.signerSubject || "").toLowerCase();
  const publisher = options.publishers.find((p) => subject.includes(p.toLowerCase()));
  if (!publisher) {
    return { trusted: false, thumbprint: fact.thumbprint };
  }
  return { publisher, trusted: true, thumbprint: fact.thumbprint };
}
