// What the client does when the server says "not signed in" — and nothing else.
//
// Two paths reach that answer and neither can be left to the caller: a fetch
// that comes back 401, and an SSE stream that simply stops. Both end at the
// login page, so the decision lives here once instead of at forty call sites.

import { report } from "./report.js";

const nativeFetch = window.fetch.bind(window);

/** The hash goes along: it addresses the view, so dropping it would land the
 *  re-login somewhere the person was not. */
const toLogin = (): void => {
  location.assign(`/login?next=${encodeURIComponent(location.pathname + location.hash)}`);
};

/**
 * Turn every 401 into the login page, once, for every caller.
 *
 * A wrapper on `window.fetch` rather than a helper each module remembers to
 * use: an expired cookie is not a per-caller error, and "session create
 * failed: 401" is a worse sentence than the login form.
 */
export function guardFetch(): void {
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const res = await nativeFetch(...args);
    if (res.status === 401) toLogin();
    return res;
  };
}

/**
 * A dead SSE stream, explained. EventSource exposes no status and does not
 * retry a non-2xx, so an expired cookie would otherwise stop every stream in
 * silence. One probe answers which it was: 401 goes to the login page,
 * anything else is a real outage and gets said out loud.
 */
export function streamDied(source: EventSource, what: string): void {
  // Still CONNECTING means the browser is retrying by itself — that is not a
  // failure yet, and reporting it would cry wolf on every blip.
  if (source.readyState !== EventSource.CLOSED) return;
  // Through report(), so a stream that died out in someone's browser is also a
  // line in the server's log — the disconnect is usually the server's story.
  const died = () => report(`${what} stream disconnected — reload to reconnect`);
  // Deliberately the unwrapped fetch: this *is* the 401 handler, and going
  // through the wrapper would hide which of the two answers came back.
  void nativeFetch("/api/sessions").then(
    (res) => (res.status === 401 ? toLogin() : died()),
    died,
  );
}
