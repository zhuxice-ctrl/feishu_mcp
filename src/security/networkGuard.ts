import dns from "node:dns/promises";
import net from "node:net";

export interface ValidatedNetworkTarget {
  url: URL;
  origin: string;
  addresses: Array<{ address: string; family: 4 | 6 }>;
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

export async function validateNetworkTarget(input: string | URL): Promise<ValidatedNetworkTarget> {
  let url: URL;
  try { url = input instanceof URL ? new URL(input.href) : new URL(input); }
  catch { throw new Error("The target is not a valid URL."); }
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
  return { url, origin: url.origin, addresses };
}
