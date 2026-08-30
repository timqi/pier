// What this browser does to behave like an installed app: the service worker,
// the Web Push subscription behind one toggle, the install prompt and the icon
// badge. One module because they are one thing to the person using them — and
// because each is invisible from the inside when it is missing.
//
// That is the whole design constraint here. A permission granted to a Safari
// tab instead of the installed app, a subscription the browser silently
// expired, an instance reachable only over http: all three look like "nothing
// happened". So this module never shows a control it cannot honour — it says
// which of them is true, and offers a test notification for the only question
// that matters ("did it actually arrive?").

import { failure, mustGetJson, sendJson } from "./api.js";
import { h } from "./dom.js";
import { button, card, setStatus, toggle } from "./form.js";

/** Whether this browser was asked to notify. Kept locally because permission
 *  is not intent: a granted permission that the person then switched off here
 *  must not be re-subscribed on the next load. */
const WANTED_KEY = "pier.push";
const SW_URL = "/sw.js";

const isIOS = (): boolean =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));

const isStandalone = (): boolean =>
  matchMedia("(display-mode: standalone)").matches ||
  (navigator as { standalone?: boolean }).standalone === true;

/** Why this browser cannot subscribe, or "" when it can. */
function blocker(): string {
  if (!window.isSecureContext) {
    return "Notifications need HTTPS. Reach this Pier through its public URL, not over plain http.";
  }
  // Ahead of the support check: iOS hides the Push API in a tab, so "this
  // browser has no Web Push support" would be the wrong half of the truth.
  if (isIOS() && !isStandalone()) {
    return "On iPhone and iPad, notifications work only from the installed app: Share → Add to Home Screen, then open Pier from that icon.";
  }
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return "This browser has no Web Push support.";
  }
  return "";
}

const OS_NAMES: [RegExp, string][] = [
  [/iPhone/, "iPhone"],
  [/iPad/, "iPad"],
  [/Android/, "Android"],
  [/Macintosh/, "Mac"],
  [/Windows/, "Windows"],
];
// Edge and Chrome both claim Chrome, Chrome claims Safari: first match wins.
const BROWSER_NAMES: [RegExp, string][] = [
  [/Edg\//, "Edge"],
  [/Chrome\//, "Chrome"],
  [/Firefox\//, "Firefox"],
  [/Safari\//, "Safari"],
];

/** Which device this is, in the Console and in the log. Coarse on purpose: the
 *  question is "which of my devices is this row", not which build. */
function deviceLabel(): string {
  const ua = navigator.userAgent;
  const name = (table: [RegExp, string][], fallback: string): string =>
    table.find(([pattern]) => pattern.test(ua))?.[1] ?? fallback;
  return `${name(OS_NAMES, "Linux")} · ${name(BROWSER_NAMES, "browser")}${
    isStandalone() ? " (installed)" : ""
  }`;
}

const urlBase64ToBytes = (value: string): Uint8Array<ArrayBuffer> => {
  const raw = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
};

let registration: ServiceWorkerRegistration | null = null;

/** Registered on every load, permission or not: it is also what makes Pier
 *  installable and what answers a navigation when the network is gone. */
async function register(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return null;
  registration ??= await navigator.serviceWorker.register(SW_URL, { scope: "/" })
    .catch((err: unknown) => {
      console.warn("service worker registration failed", err);
      return null;
    });
  return registration;
}

const sameKey = (a: ArrayBuffer | null, b: Uint8Array): boolean => {
  const bytes = a ? new Uint8Array(a) : null;
  return bytes?.length === b.length && bytes.every((byte, i) => byte === b[i]);
};

async function subscribe(reg: ServiceWorkerRegistration): Promise<PushSubscription> {
  const { publicKey } = await mustGetJson<{ publicKey: string }>(
    "/api/push",
    "Could not read this instance's push key",
  );
  const key = urlBase64ToBytes(publicKey);
  const existing = await reg.pushManager.getSubscription();
  if (existing) {
    if (sameKey(existing.options.applicationServerKey, key)) return existing;
    // This instance signs with a different key than the one this subscription
    // was made for (a restored database, a reinstall). Nothing can ever be
    // delivered to it again, and the browser refuses a second subscription
    // until it is gone — which is a toggle that silently never works.
    await existing.unsubscribe();
  }
  return reg.pushManager.subscribe({
    userVisibleOnly: true, // the only mode Chrome and Safari allow
    applicationServerKey: key,
  });
}

/** Hand the server what it needs to reach this browser. Repeated on every load
 *  on purpose: it is what repairs a row lost to a restored backup or to a
 *  subscription the browser quietly replaced. */
async function tellServer(sub: PushSubscription): Promise<Response> {
  return sendJson("/api/push/subscribe", { ...sub.toJSON(), label: deviceLabel() });
}

/**
 * Register the worker, and — if this browser already asked to be notified —
 * make sure the server still knows how to reach it.
 */
export async function initPush(): Promise<void> {
  watchInstallability();
  const reg = await register();
  if (!reg || localStorage.getItem(WANTED_KEY) !== "on") return;
  // Revoked in the browser's site settings, or a browser with no Notification
  // API at all: either way there is nothing to repair here.
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    await tellServer(await subscribe(reg));
  } catch (err) {
    console.warn("re-registering this browser for notifications failed", err);
  }
}

// --- installing ------------------------------------------------------------------
// Chrome and Edge hand the install prompt to the page instead of showing it:
// the event fires once, early, and is the only way to offer installing from
// inside the app. Safari fires nothing — on iOS the Add-to-Home-Screen sentence
// in the card below is the whole story, and it is the one platform where
// installing is not cosmetic (no installed app, no notifications).

/** The part of Chrome's `beforeinstallprompt` this uses. Not in lib.dom. */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let installPrompt: InstallPromptEvent | null = null;
/** Set by the card, so an event arriving after it was built still shows. */
let onInstallability: (() => void) | null = null;

function watchInstallability(): void {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault(); // ours to fire, from a click, or not at all
    installPrompt = event as InstallPromptEvent;
    onInstallability?.();
  });
  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    onInstallability?.();
  });
}

/** The home-screen icon's unread count. Silently unsupported on desktop
 *  Firefox and in a plain tab; that is the API's own contract, not a failure. */
export function setUnreadBadge(count: number): void {
  const nav = navigator as Navigator & {
    setAppBadge?: (n?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  void (count > 0 ? nav.setAppBadge?.(count) : nav.clearAppBadge?.())?.catch(() => {});
}

/**
 * Settings → Instance: one toggle, one test button, and a sentence saying
 * exactly which state this browser is in.
 */
export function createNotificationsCard(): HTMLElement {
  const status = h("span", "text-[11.5px]", "");
  const test = button("Send a test notification");
  const controls = h("div", "flex items-center gap-3", test, status);
  const body = h("div", "flex flex-col gap-4");

  const wanted = (): boolean => localStorage.getItem(WANTED_KEY) === "on";

  async function enable(): Promise<void> {
    setStatus(status, "saving", "asking this browser…");
    // The first await of the click, and it has to stay that way: Safari counts
    // the gesture as spent by anything awaited before the request and refuses
    // it outright — which is how this feature reads as "broken on iPhone".
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      localStorage.setItem(WANTED_KEY, "off");
      render();
      return setStatus(
        status,
        "failed",
        permission === "denied"
          ? "Notifications are blocked for this site — allow them in the browser's site settings, then try again."
          : "No answer to the permission prompt.",
      );
    }
    const reg = await register();
    if (!reg) return setStatus(status, "failed", "This browser refused to register a service worker.");
    try {
      const res = await tellServer(await subscribe(reg));
      if (!res.ok) return setStatus(status, "failed", await failure(res, "Could not register this browser"));
      localStorage.setItem(WANTED_KEY, "on");
      render();
      setStatus(status, "saved", "This browser will be notified when a turn finishes unseen.");
    } catch (err) {
      setStatus(status, "failed", `Could not subscribe: ${String(err)}`);
    }
  }

  async function disable(): Promise<void> {
    localStorage.setItem(WANTED_KEY, "off");
    render();
    const sub = await (await register())?.pushManager.getSubscription();
    if (sub) {
      await sendJson("/api/push/unsubscribe", { endpoint: sub.endpoint });
      await sub.unsubscribe();
    }
    setStatus(status, "idle", "This browser will not be notified.");
  }

  test.onclick = () => {
    setStatus(status, "saving", "sending…");
    void (async () => {
      const res = await sendJson("/api/push/test", {});
      if (!res.ok) return setStatus(status, "failed", await failure(res, "Could not send"));
      const { sent, failed } = (await res.json()) as { sent: number; failed: number };
      // Both numbers: "it reached the push service" and "it appeared on your
      // screen" are different claims, and only the first one is ours to make.
      setStatus(
        status,
        failed ? "failed" : "saved",
        `Handed ${String(sent)} device(s) to their push service${failed ? `, ${String(failed)} refused` : ""}.`,
      );
    })();
  };

  /** Only while this browser says it can, and only until it has. */
  function installRow(): HTMLElement[] {
    if (!installPrompt) return [];
    const install = button("Install Pier", true);
    install.onclick = () => {
      const prompt = installPrompt;
      if (!prompt) return;
      void prompt.prompt().then(() => prompt.userChoice).finally(() => {
        // Chrome allows one prompt per event; whatever was chosen, this one is
        // spent, and the button must not stay behind promising a second.
        installPrompt = null;
        render();
      });
    };
    return [h(
      "div",
      "flex items-center gap-3",
      install,
      h(
        "span",
        "text-[11.5px] leading-snug text-neutral-500",
        "Its own window and icon — and where notifications look like an app's.",
      ),
    )];
  }

  function render(): void {
    const why = blocker();
    if (why) {
      body.replaceChildren(
        ...installRow(),
        h("p", "text-[12.5px] leading-snug text-neutral-500", why),
      );
      return;
    }
    const on = wanted() && Notification.permission === "granted";
    test.disabled = !on;
    body.replaceChildren(
      ...installRow(),
      toggle(
        "Notify this device",
        "A turn that finishes while nobody is looking at it becomes a notification here. Per browser — each device is enabled on its own.",
        on,
        (checked) => void (checked ? enable() : disable()),
      ),
      controls,
    );
  }

  onInstallability = render;
  render();
  return card(
    "Notifications",
    "Web Push, so a finished turn reaches you with the workbench closed. Installed — Chrome's address-bar icon, or Share → Add to Home Screen on iOS — Pier notifies you the way an app does.",
    body,
  );
}
