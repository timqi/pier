// The version label beside the title and its panel: the source link AGPL-3.0
// §13 asks for, whether a newer version exists, and the update controls. Stays
// an <a href>, so middle-click still goes straight to the source.

import { failure, getJson, sendJson } from "./api.js";
import { $, h } from "./dom.js";
import { button, setStatus, toggle } from "./form.js";
import { openPanel } from "./menu.js";

const SOURCE = "https://github.com/timqi/pier";
const QUIET = ["text-neutral-400", "hover:text-neutral-700"];
const BADGE = ["rounded-full", "bg-emerald-50", "px-1.5", "text-emerald-700", "ring-1", "ring-inset", "ring-emerald-600/20", "hover:bg-emerald-100"];

/** GET /api/update. `canApply` is false when nothing supervises the process —
 *  there is then no way to restart it into the new version from here.
 *  `problem` is why applying would fail today — a version manager removed the
 *  Node the unit records, say. Shown whether or not an update is pending: the
 *  repair is the same, and the next restart is too late to find out. */
interface UpdateStatus {
  current: string; latest: string | null; available: boolean; canApply: boolean; autoUpdate: boolean; problem: string | null;
}

/** A tab left open for days must not keep advertising last week's answer.
 *  Matches the server's TTL, so this only ever reads a cache. */
const POLL_MS = 30 * 60_000;

let status: UpdateStatus | null = null;
const link = $<HTMLAnchorElement>("#version");

function renderLabel(current: string): void {
  const news = status?.available === true && status.latest !== null;
  link.textContent = `v${current}`;
  link.title = news ? `Pier ${status?.latest} is out` : "";
  link.classList.remove(...(news ? QUIET : BADGE));
  link.classList.add(...(news ? BADGE : QUIET));
}

const line = (text: string, cls = "px-3 py-1 text-[12px] leading-snug text-neutral-500"): HTMLElement => h("p", cls, text);

function panel(): HTMLElement {
  const box = h("div", "flex w-72 flex-col gap-1 py-1");
  if (!status) { box.append(line("Checking the registry…")); return box; }
  const { current, latest, available, canApply, problem } = status;
  const status$ = h("span", "", "");
  const say = (failed: boolean, text: string): void => setStatus(status$, failed ? "failed" : "idle", text);
  const actions = h("div", "flex items-center gap-2 px-3 py-1.5");
  box.append(
    line(available ? `Pier ${latest} is out` : `Pier ${current}`, "px-3 py-1 text-[12.5px] font-medium text-neutral-700"),
    // Not silence (§5): "no news" and "we could not ask" are different
    // facts, and only one of them means you might be out of date.
    line(available ? `You are running ${current}.`
      : latest === null ? "The registry could not be reached, so this may not be the latest." : "This is the latest release."),
  );
  if (problem) box.append(line(problem, "mx-3 my-1 rounded-md bg-red-50 px-2 py-1.5 text-[11.5px] leading-snug text-red-700"));
  if (available && canApply && !problem) {
    const now = button("Update now", true);
    now.onclick = () => void (async () => {
      now.disabled = true;
      say(false, "starting the updater…");
      const res = await sendJson("/api/update", {});
      if (!res.ok) { now.disabled = false; return say(true, await failure(res, "Could not update")); }
      // 202: something is still running, and the update waits for it.
      const { draining } = await res.json() as { draining?: boolean };
      say(false, draining
        ? "Waiting for running work to finish — Pier then installs and restarts."
        : "Installing — Pier restarts once it is on disk, and this page reconnects on its own.");
    })();
    actions.append(now);
  }
  actions.append(Object.assign(h("a", "btn text-[12.5px] no-underline", "Source"), {
    href: available ? `${SOURCE}/releases` : SOURCE, target: "_blank", rel: "noreferrer", title: "Pier is free software (AGPL-3.0)",
  }));
  box.append(actions, h("div", "px-3", status$));
  if (available && !canApply && !problem) box.append(line("No service manager owns this Pier, so it cannot restart itself — update it with: pier update"));
  const auto = toggle("Update automatically", canApply
    ? "Installs a new release once nothing is running — no turn in flight, no task run."
    : "Needs the systemd service (pier service install); nothing here can restart Pier.",
  status.autoUpdate, (on) => void (async () => {
    if (status) status.autoUpdate = on;
    const res = await sendJson("/api/settings", { autoUpdate: on }, "PUT");
    if (res.ok) return;
    // Reconcile: the server is the truth, and a switch that silently did
    // not take is worse than one that visibly failed.
    if (status) status.autoUpdate = !on;
    if (input) input.checked = !on;
    say(true, await failure(res, "Could not save"));
  })());
  // Without a service manager the switch would only store a wish: disabled,
  // and the hint above says what to install instead.
  const input = auto.querySelector("input");
  if (input) input.disabled = !canApply;
  box.append(h("div", "mt-1 border-t border-neutral-200 px-3 pb-1 pt-2", auto));
  return box;
}

/** An unreachable check is not news: the label stays put. */
async function load(current: string): Promise<void> {
  const got = await getJson<UpdateStatus>("/api/update", "Update check failed");
  if (got.ok) renderLabel((status = got.value).current || current);
}

/** Renders the label, then upgrades it to news if there is any. */
export function initVersion(current: string): void {
  renderLabel(current);
  // The panel is the destination; the anchor is the fallback.
  link.onclick = (ev) => { ev.preventDefault(); openPanel(link, panel()); };
  const refresh = (): void => void load(current).catch(() => {});
  refresh(); setInterval(refresh, POLL_MS);
}
