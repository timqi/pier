// What the browser knows and nobody else does.
//
// The workbench is an SSE consumer, so almost every bug is already visible in
// the server's log — except the ones that happen after the bytes arrive: a
// script that threw, a `void fetch(...)` that rejected, a stream that stopped.
// Those show up as "I clicked and nothing happened", with an empty journal.
//
// So errors go two places, and neither is a new pipeline: the chat pane, so the
// person sees that something broke rather than nothing happening (AGENTS.md
// principle 5b), and one POST back to the server, which logs it through the
// same logger every other area uses. No client-side log store, no third-party
// collector — `journalctl -t pier | grep client:` is the whole collection story.

import { appendTurn } from "./chat.js";

/** Captured at import, before auth.ts wraps `window.fetch`: a beacon must not
 *  be able to navigate the page away, and it needs no 401 handling of its own.
 *  The route is behind the same boundary as every other `/api` call — a
 *  write into the operator's journal is not something to hand a stranger — so
 *  an expired session drops its report and the chat line below is what is
 *  left. Nothing is lost that a signed-in reload does not report again. */
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

/**
 * Report a client-side failure. Callable directly from a `catch` that has
 * nothing better to do than swallow the error.
 *
 * Returns the chat line it wrote, for the few failures that come with
 * something to do about them — null when the line was suppressed as a repeat,
 * which is also the answer to "is there already one on screen?".
 */
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
    report(`script error: ${e.message}`, e.error);
  });
  // Every `void fetch(...)` and un-awaited async call in the workbench lands
  // here when it rejects, which is why those call sites need no try/catch.
  window.addEventListener("unhandledrejection", (e) => {
    report("unhandled rejection", e.reason);
  });
}
