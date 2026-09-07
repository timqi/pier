// Fetch one configuration document from the operator's source URL: HTTPS with
// no credentials, redirects followed while they stay HTTPS, JSON capped at
// 1 MiB so a hostile or broken source cannot exhaust memory.

export const CONFIG_SYNC_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 5;

export function configSourceUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new Error("A valid HTTPS source URL is required"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || raw.length > 4096) {
    throw new Error("Source must be HTTPS, without credentials or a fragment");
  }
  return url;
}

export interface ConfigDownload {
  status: 200 | 304;
  etag: string | null;
  body: string;
}

export async function downloadConfig(raw: string, etag: string | null, signal: AbortSignal): Promise<ConfigDownload> {
  let url = configSourceUrl(raw);
  for (let hop = 0; ; hop++) {
    signal.throwIfAborted();
    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET", redirect: "manual", signal,
        headers: { accept: "application/json", ...(etag ? { "if-none-match": etag } : {}) },
      });
    } catch {
      throw new Error(signal.aborted ? "Configuration download timed out or was cancelled" : "Could not connect to source");
    }
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (location) {
      await res.body?.cancel().catch(() => {});
      if (hop >= MAX_REDIRECTS) throw new Error("Source redirected too many times");
      try { url = configSourceUrl(new URL(location, url).href); }
      catch { throw new Error("Source redirected to a location that is not HTTPS"); }
      continue;
    }
    if (res.status !== 200 && res.status !== 304) {
      await res.body?.cancel().catch(() => {});
      throw new Error(res.status === 404 || res.status === 410
        ? "Source link was revoked or does not exist"
        : `Source returned HTTP ${String(res.status)}`);
    }
    const status = res.status === 304 ? 304 : 200;
    if (status === 200 && !/^application\/json(?:\s*;|$)/i.test(res.headers.get("content-type") ?? "")) {
      await res.body?.cancel().catch(() => {});
      throw new Error("Source did not return JSON");
    }
    return { status, etag: res.headers.get("etag"), body: await read(res, signal) };
  }
}

async function read(res: Response, signal: AbortSignal): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > CONFIG_SYNC_BYTES) throw new Error("Configuration exceeds 1 MiB");
      chunks.push(Buffer.from(value));
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    if (err instanceof Error && err.message === "Configuration exceeds 1 MiB") throw err;
    throw new Error(signal.aborted ? "Configuration download timed out or was cancelled" : "Configuration download failed");
  }
  return Buffer.concat(chunks).toString("utf8");
}
