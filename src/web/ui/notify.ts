// Turn-completion notifications. The workspace stream already reports every
// session's run state, so a streaming → idle transition is the whole trigger —
// no parallel bookkeeping. Delivery goes through the service worker
// registration on every platform: an installed iOS web app has no other way,
// and that registration is also where server-sent Web Push would land later.

import { $ } from "./dom.js";
import type { SessionState } from "../../core/types.js";

const KEY = "pier.notify";

const toggle = $("#notify-toggle");

let registration: ServiceWorkerRegistration | null = null;
let enabled = localStorage.getItem(KEY) === "1";
let titleOf: (id: string) => string = () => "Pier";
/** Sessions seen streaming — a transition needs a start we witnessed. */
const running = new Set<string>();

const granted = (): boolean => enabled && Notification.permission === "granted";

function render(): void {
  toggle.classList.toggle("bg-indigo-50", granted());
  toggle.classList.toggle("text-indigo-600", granted());
  toggle.title = granted()
    ? "Notifying when a turn finishes — click to mute"
    : "Notify me when a turn finishes";
}

/** The permission prompt only counts from a user gesture, hence this click. */
async function flip(): Promise<void> {
  enabled = enabled ? false : (await Notification.requestPermission()) === "granted";
  localStorage.setItem(KEY, enabled ? "1" : "0");
  render();
}

/**
 * Every session-state event, the selected session included. Only fires while
 * the tab is hidden — watching the turn finish is its own notification.
 */
export function noteState(sessionId: string, state: SessionState): void {
  if (state === "streaming") {
    running.add(sessionId);
    return;
  }
  if (!running.delete(sessionId)) return; // never saw it start
  if (!granted() || !registration || !document.hidden) return;
  void registration.showNotification("Turn complete", {
    body: titleOf(sessionId),
    tag: sessionId, // one live notification per session, newest wins
    data: { url: `/#/session/${encodeURIComponent(sessionId)}` },
  });
}

export function initNotify(title: (id: string) => string): void {
  titleOf = title;
  // No service worker (insecure origin, old browser) → no notifications at all;
  // hide the control rather than offer one that silently does nothing.
  if (!("Notification" in window) || !("serviceWorker" in navigator)) {
    toggle.classList.add("hidden");
    return;
  }
  navigator.serviceWorker.register("/sw.js").then(
    (reg) => (registration = reg),
    () => toggle.classList.add("hidden"),
  );
  toggle.onclick = () => void flip();
  render();
}
