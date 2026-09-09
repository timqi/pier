// Client-side failures, which the server's log cannot see: shown in the chat
// pane (§5b) and POSTed back so `journalctl -t pier | grep client:` has them.

import { appendTurn } from "./chat.js";

/** Captured before auth.ts wraps `window.fetch`: a beacon must not navigate
 *  the page away. An expired session drops its report; the chat line is what is left. */
const nativeFetch = window.fetch.bind(window);

/** A render loop that throws would otherwise write a line per frame. */
const RATE_PER_MINUTE = 20;
const REPEAT_MS = 60_000;
let sent: number[] = [];
/** Last time each distinct failure was reported — a repeat is worth saying
 *  again later (a stream that keeps dying), just not twice a second. */
const seen = new Map<string, number>();

const detail = (value: unknown): string | undefined =>
  value instanceof Error ? value.stack ?? `${value.name}: ${value.message}` : undefined;

/** Returns the chat line, or null when suppressed as a repeat. */
export function report(message: string, cause?: unknown): HTMLElement | null {
  const text = cause === undefined ? message : `${message}: ${String(cause)}`;
  const now = Date.now();
  if (now - (seen.get(text) ?? -REPEAT_MS) < REPEAT_MS) return null;
  // A tab stays open for days: forget the old keys rather than grow a map of
  // every message ever seen.
  if (seen.size > 100) seen.clear();
  seen.set(text, now);
  sent = sent.filter((at) => now - at < 60_000);
  if (sent.length >= RATE_PER_MINUTE) return null;
  sent.push(now);
  // The POST goes first: `appendTurn` touches the DOM, and if *that* is what
  // broke, the server's copy is the only one that will exist.
  void nativeFetch("/api/client-log", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: text, stack: detail(cause), view: location.hash || "/" }),
    // The page may be closing — an unload-time error is the one most worth
    // keeping, so the request has to outlive the document.
    keepalive: true,
  }).catch(() => {
    // Nowhere left to report to: the beacon itself is what failed. The chat
    // line below is still on screen, which is the half that matters here.
  });
  return appendTurn("error", text);
}

/** Install the two handlers that catch what no `catch` was written for. */
export function initReport(): void {
  // Retires the boot-time beacon in index.html, which exists only for errors
  // thrown before this line could run.
  (window as unknown as { __pierReporting?: boolean }).__pierReporting = true;
  window.addEventListener("error", (e) => {
    // Our own observers feed each other by design (composer.ts → chat.ts);
    // once per frame, nothing to act on, and noise is how a real line gets missed.
    if (!e.error && e.message.includes("ResizeObserver loop")) return;
    report(`script error: ${e.message}`, e.error);
  });
  // Every `void fetch(...)` and un-awaited async call in the workbench lands
  // here when it rejects, which is why those call sites need no try/catch.
  window.addEventListener("unhandledrejection", (e) => {
    report("unhandled rejection", e.reason);
  });
}
