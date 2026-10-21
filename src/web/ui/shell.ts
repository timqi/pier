// The bridge to the native shell (docs/design/14-native-client.md): the only
// module that knows `window.__TAURI__`. In a browser every call is a no-op.

interface TauriGlobal {
  core: { invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> };
  webview: {
    getCurrentWebview(): { listen(event: string, handler: (e: { payload: unknown }) => void): Promise<() => void> };
  };
}

const tauri = (window as Window & { __TAURI__?: TauriGlobal }).__TAURI__;

/** A shell that refuses still leaves the page working, so a warning, not a throw. */
function invoke(cmd: string, args: Record<string, unknown>): void {
  tauri?.core.invoke(cmd, args).catch((err: unknown) => console.warn(`shell: ${cmd} failed`, err));
}

/** False in a browser: the caller falls back to the Badging API. */
export function setBadge(count: number): boolean {
  if (!tauri) return false;
  invoke("set_badge", { count });
  return true;
}

/** Web Push cannot reach a webview; the workspace stream's copy comes here. */
export function notify({ title, body, url, tag }: { title: string; body: string; url: string; tag: string }): void {
  invoke("notify", { title, body, url, tag });
}

/** A native notification's click, carrying the `url` it was given. This
 *  webview's listener: a global `event.listen` also hears every other instance's. */
export function onOpenUrl(fn: (url: string) => void): void {
  tauri?.webview.getCurrentWebview().listen("open-url", (e) => fn(e.payload as string))
    .catch((err: unknown) => console.warn("shell: listening for open-url failed", err));
}

/** The accent as `#rrggbb`: the ramp is authored in oklch (style.css), and a
 *  canvas is the one converter to sRGB the page already has. */
function accentHex(): string | undefined {
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!ctx) return undefined;
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--color-indigo-600");
  ctx.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0] = ctx.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

// The server writes `$PIER_TITLE` into the page title and the accent onto
// `<html>`; the shell names and colours the instance's rail row from them.
if (tauri) invoke("page_title", { title: document.title, accent: accentHex() });
