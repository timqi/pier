// Fetch one configuration document without turning an operator URL into an
// arbitrary network proxy. DNS is checked once and the TLS request is pinned
// to that address; redirects never inherit the token or bypass the check.

import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { checkServerIdentity } from "node:tls";

export const CONFIG_SYNC_BYTES = 1024 * 1024;
const blockedV4 = new BlockList();
const blockedV6 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blockedV4.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 96], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48],
  ["100::", 64], ["2001::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) blockedV6.addSubnet(address, prefix, "ipv6");

const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");

export function configSourceUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new Error("A valid HTTPS source URL is required"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || raw.length > 4096) {
    throw new Error("Source must be HTTPS, without credentials or a fragment");
  }
  return url;
}

export function publicConfigAddress(address: string): boolean {
  const family = isIP(address);
  return family !== 0 && (family !== 6 || globalV6.check(address, "ipv6")) &&
    !(family === 4 ? blockedV4 : blockedV6).check(address, family === 4 ? "ipv4" : "ipv6");
}

export interface ConfigDownload {
  status: 200 | 304;
  etag: string | null;
  body: string;
}

export async function downloadConfig(raw: string, etag: string | null, signal: AbortSignal): Promise<ConfigDownload> {
  const url = configSourceUrl(raw);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await Promise.race([
      lookup(hostname, { all: true }),
      new Promise<never>((_, reject) => {
        if (signal.aborted) reject(new Error("Configuration download aborted"));
        else signal.addEventListener("abort", () => reject(new Error("Configuration download aborted")), { once: true });
      }),
    ]);
  if (!addresses.length || addresses.some(({ address }) => !publicConfigAddress(address))) {
    throw new Error("Source must resolve to a public address");
  }
  signal.throwIfAborted();
  const address = addresses[0]!;
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: address.address, family: address.family, port: url.port || 443,
      servername: isIP(hostname) ? undefined : hostname,
      checkServerIdentity: (_host, cert) => checkServerIdentity(hostname, cert),
      path: `${url.pathname}${url.search}`, method: "GET", signal,
      headers: { host: url.host, accept: "application/json", ...(etag ? { "if-none-match": etag } : {}) },
    }, (res) => {
      const status = res.statusCode;
      if (status !== 200 && status !== 304) {
        res.destroy();
        reject(new Error(status === 404 || status === 410
          ? "Source link was revoked or does not exist"
          : `Source returned HTTP ${String(status)}`));
        return;
      }
      if (status === 200 && !/^application\/json(?:\s*;|$)/i.test(res.headers["content-type"] ?? "")) {
        res.destroy(); reject(new Error("Source did not return JSON")); return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > CONFIG_SYNC_BYTES) res.destroy(new Error("Configuration exceeds 1 MiB"));
        else chunks.push(chunk);
      });
      res.on("error", () => reject(new Error(size > CONFIG_SYNC_BYTES ? "Configuration exceeds 1 MiB" : "Configuration download failed")));
      res.on("end", () => resolve({ status, etag: res.headers.etag ?? null, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", () => reject(new Error(signal.aborted ? "Configuration download timed out or was cancelled" : "Could not connect to source")));
    req.end();
  });
}
