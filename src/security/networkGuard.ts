import dns from "node:dns/promises";
import net from "node:net";

export interface ValidatedNetworkTarget {
  url: URL;
  origin: string;
  addresses: Array<{ address: string; family: 4 | 6 }>;
}

export interface NetworkValidationOptions {
  policy?: "web_fetch" | "artifact_import";
}

function hostnameWithoutBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

export function isBlockedMetadataAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (net.isIPv4(normalized)) {
    const octets = normalized.split(".").map(Number);
    return (octets[0] === 169 && octets[1] === 254) || normalized === "100.100.100.200";
  }
  if (net.isIPv6(normalized)) {
    if (/^fe[89ab]/.test(normalized)) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
    return mapped ? isBlockedMetadataAddress(mapped[1]) : false;
  }
  return false;
}

function isArtifactDeniedAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (net.isIPv4(normalized)) {
    const [a, b] = normalized.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224 || isBlockedMetadataAddress(normalized);
  }
  if (net.isIPv6(normalized)) {
    if (normalized === "::" || normalized === "::1" || /^f[cd]/.test(normalized) ||
      /^fe[89ab]/.test(normalized) || /^ff/.test(normalized)) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
    return mapped ? isArtifactDeniedAddress(mapped[1]) : isBlockedMetadataAddress(normalized);
  }
  return true;
}

export async function validateNetworkTarget(
  input: string | URL,
  options: NetworkValidationOptions = {},
): Promise<ValidatedNetworkTarget> {
  let url: URL;
  try { url = input instanceof URL ? new URL(input.href) : new URL(input); }
  catch { throw new Error("The target is not a valid URL."); }
  const policy = options.policy ?? "web_fetch";
  if (policy === "artifact_import" && url.protocol !== "https:") {
    throw new Error("Artifact imports require HTTPS URLs.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Only HTTP and HTTPS are supported, not ${url.protocol}`);
  }
  if (url.username || url.password) throw new Error("URLs containing credentials are not allowed.");
  const hostname = hostnameWithoutBrackets(url.hostname);
  const family = net.isIP(hostname);
  const addresses: Array<{ address: string; family: 4 | 6 }> = family
    ? [{ address: hostname, family: family as 4 | 6 }]
    : (await dns.lookup(hostname, { all: true, verbatim: true }))
      .filter((item) => item.family === 4 || item.family === 6)
      .map((item) => ({ address: item.address, family: item.family as 4 | 6 }));
  if (!addresses.length) throw new Error("The target hostname resolved to no addresses.");
  if (addresses.some((item) => isBlockedMetadataAddress(item.address))) {
    throw new Error("Link-local cloud metadata addresses are permanently blocked.");
  }
  if (policy === "artifact_import" && addresses.some((item) => isArtifactDeniedAddress(item.address))) {
    throw new Error("Artifact imports may only target public network addresses.");
  }
  return { url, origin: url.origin, addresses };
}
