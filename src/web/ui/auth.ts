// What the client does when the server stops answering it: a 401 ends at the
// login page, a dead SSE stream is retried until the server is back, both
// decided here once.

import { button } from "./form.js";
import { report } from "./report.js";

declare const __PIER_VERSION__: string; // injected by vite.config.ts
/** The version this page's bundle was built as. */
export const bundleVersion: string = __PIER_VERSION__;

const nativeFetch = window.fetch.bind(window);
const RETRY_MS = 10_000;

/** The hash goes along: it addresses the view, so dropping it would land the
 *  re-login somewhere the person was not. */
const toLogin = (): void => {
  location.assign(`/login?next=${encodeURIComponent(location.pathname + location.hash)}`);
};

/** A wrapper on `window.fetch`, not a helper each module remembers to use: an
 *  expired cookie is not a per-caller error. */
export function guardFetch(): void {
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const res = await nativeFetch(...args);
    if (res.status === 401) toLogin();
    return res;
  };
}

/** Every dead stream's reconnect, run together by the one probe loop. */
const revivals: (() => void)[] = [];
const lines: HTMLElement[] = [];
let probing = false;
/** When the last probe reopened its streams: one that dies again at once waits out RETRY_MS. */
let revivedAt = -Infinity;

/** The version the server runs; null while it does not answer, "signed out" on a 401. */
async function serverVersion(): Promise<string | null> {
  // Deliberately the unwrapped fetch: this *is* the 401 handler, and going
  // through the wrapper would hide which answer came back.
  try {
    const res = await nativeFetch("/api/version", { cache: "no-store" });
    if (res.status === 401) return "signed out";
    if (!res.ok) return null;
    const { current } = (await res.json()) as { current?: unknown };
    return typeof current === "string" ? current : null;
  } catch {
    return null; // down, or a proxy's error page: the next probe asks again
  }
}

async function probe(what: string): Promise<void> {
  const version = await serverVersion();
  if (version === null) {
    // One line per outage, not one per minute of it.
    if (!lines.length) {
      const line = report(`${what} stream disconnected — reconnecting every ${RETRY_MS / 1000}s`);
      if (line) {
        // A button: an installed iOS PWA has no address bar, and pull-to-refresh is off (style.css).
        const again = button("Reload");
        again.classList.add("ml-2", "align-middle");
        again.onclick = () => location.reload();
        line.append(" ", again);
        lines.push(line);
      }
    }
    setTimeout(() => void probe(what), RETRY_MS);
    return;
  }
  if (version === "signed out") return toLogin();
  // A release replaced the bundles this page's lazy chunks name, and its API may differ.
  if (version !== bundleVersion) return location.reload();
  probing = false;
  revivedAt = Date.now();
  for (const line of lines.splice(0)) line.remove();
  for (const revive of revivals.splice(0)) revive();
}

/** EventSource retries a dropped connection by itself but gives up for good on
 *  a non-2xx — the 502 a proxy answers while Pier restarts, or the 401 of an
 *  expired cookie — so a CLOSED stream is probed every RETRY_MS until the
 *  server answers, then `revive` opens it again. */
export function streamDied(source: EventSource, what: string, revive: () => void): void {
  // Still CONNECTING means the browser is retrying by itself — that is not a
  // failure yet, and reporting it would cry wolf on every blip.
  if (source.readyState !== EventSource.CLOSED) return;
  revivals.push(revive);
  if (probing) return;
  probing = true;
  // A server whose version answers but whose stream fails would otherwise reopen it in a tight loop.
  setTimeout(() => void probe(what), Math.max(0, revivedAt + RETRY_MS - Date.now()));
}

/** A stream the browser reopened by itself skipped the probe: a release in
 *  between still has to reload the page. */
export async function matchVersion(): Promise<void> {
  const version = await serverVersion();
  if (version !== null && version !== "signed out" && version !== bundleVersion) location.reload();
}
