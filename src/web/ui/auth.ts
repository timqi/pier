// What the client does when the server says "not signed in": a 401 and a dead
// SSE stream both end at the login page, decided here once.

import { button } from "./form.js";
import { report } from "./report.js";

const nativeFetch = window.fetch.bind(window);

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

/** EventSource exposes no status and does not retry a non-2xx, so an expired
 *  cookie would stop every stream in silence; one probe tells which it was. */
export function streamDied(source: EventSource, what: string): void {
  // Still CONNECTING means the browser is retrying by itself — that is not a
  // failure yet, and reporting it would cry wolf on every blip.
  if (source.readyState !== EventSource.CLOSED) return;
  // A button: an installed iOS PWA has no address bar, and pull-to-refresh is
  // off (style.css).
  const died = (): void => {
    const line = report(`${what} stream disconnected`);
    if (!line) return; // already on screen; one button is enough
    const again = button("Reload");
    again.classList.add("ml-2", "align-middle");
    again.onclick = () => location.reload();
    line.append(" ", again);
  };
  // Deliberately the unwrapped fetch: this *is* the 401 handler, and going
  // through the wrapper would hide which of the two answers came back.
  void nativeFetch("/api/sessions").then(
    (res) => (res.status === 401 ? toLogin() : died()),
    died,
  );
}
