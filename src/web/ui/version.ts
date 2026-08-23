// What the version label beside the title says, and what you can do about it.
//
// Two states: the version this instance is, and — once the server's registry
// check has an answer — the version it could be. The second looks different on
// purpose: a number that is merely true should not draw the eye, and one you
// can act on should.
//
// Clicking opens the panel rather than the releases page, because everything
// about "the version" now lives in one place: the source link AGPL-3.0 §13
// asks for, whether a newer one exists, the button that takes it, and the
// switch that lets Pier take it unattended. The element stays an <a href>, so
// middle-click and "open in new tab" still go straight to the source.

import { failure, sendJson } from "./api.js";
import { $, h } from "./dom.js";
import { button, toggle } from "./form.js";
import { openPanel } from "./menu.js";

const SOURCE = "https://github.com/timqi/pier";
const QUIET = ["text-neutral-400", "hover:text-neutral-700"];
const BADGE = [
  "rounded-full",
  "bg-emerald-50",
  "px-1.5",
  "text-emerald-700",
  "ring-1",
  "ring-inset",
  "ring-emerald-600/20",
  "hover:bg-emerald-100",
];

/** GET /api/update. `canApply` is false when nothing supervises the process —
 *  there is then no way to restart it into the new version from here. */
interface UpdateStatus {
  current: string;
  latest: string | null;
  available: boolean;
  canApply: boolean;
  autoUpdate: boolean;
  /** Why applying would fail today — a version manager removed the Node the
   *  unit records, say. Shown whether or not an update is pending: the repair
   *  is the same, and the next restart is too late to find out. */
  problem: string | null;
}

/** A tab left open for days must not keep advertising last week's answer.
 *  Matches the server's TTL, so this only ever reads a cache. */
const POLL_MS = 30 * 60_000;

let status: UpdateStatus | null = null;
const link = $<HTMLAnchorElement>("#version");

function renderLabel(current: string): void {
  const news = status?.available === true && status.latest !== null;
  link.textContent = news ? `v${current} → ${status?.latest}` : `v${current}`;
  link.classList.remove(...(news ? QUIET : BADGE));
  link.classList.add(...(news ? BADGE : QUIET));
}

const line = (text: string): HTMLElement =>
  h("p", "px-3 py-1 text-[12px] leading-snug text-neutral-500", text);

function panel(): HTMLElement {
  const box = h("div", "flex w-72 flex-col gap-1 py-1");
  if (!status) {
    box.append(line("Checking the registry…"));
    return box;
  }
  const { current, latest, available, canApply, problem } = status;

  box.append(h(
    "p",
    "px-3 py-1 text-[12.5px] font-medium text-neutral-700",
    available ? `Pier ${latest} is out` : `Pier ${current}`,
  ));
  box.append(line(
    available
      ? `You are running ${current}.`
      : latest === null
        // Not silence (§5b): "no news" and "we could not ask" are different
        // facts, and only one of them means you might be out of date.
        ? "The registry could not be reached, so this may not be the latest."
        : "This is the latest release.",
  ));

  const status$ = h("span", "px-3 text-[11.5px] text-neutral-400", "");
  const actions = h("div", "flex items-center gap-2 px-3 py-1.5");

  if (problem) {
    box.append(h(
      "p",
      "mx-3 my-1 rounded-md bg-red-50 px-2 py-1.5 text-[11.5px] leading-snug text-red-700",
      problem,
    ));
  }

  if (available && canApply && !problem) {
    const now = button("Update now", true);
    now.onclick = () => {
      now.disabled = true;
      status$.className = "px-3 text-[11.5px] text-neutral-400";
      status$.textContent = "starting the updater…";
      void (async () => {
        const res = await sendJson("/api/update", {});
        if (!res.ok) {
          now.disabled = false;
          status$.className = "px-3 text-[11.5px] text-red-600";
          status$.textContent = await failure(res, "Could not update");
          return;
        }
        // 202: something is still running, and the update waits for it.
        const { draining } = await res.json() as { draining?: boolean };
        status$.textContent = draining
          ? "Waiting for running work to finish — Pier then stops, installs and starts again."
          : "Pier is stopping, installing and starting again — this page reconnects on its own.";
      })();
    };
    actions.append(now);
  }
  const source = h("a", "btn text-[12.5px] no-underline", "Source") as HTMLAnchorElement;
  source.href = available ? `${SOURCE}/releases` : SOURCE;
  source.target = "_blank";
  source.rel = "noreferrer";
  source.title = "Pier is free software (AGPL-3.0)";
  actions.append(source);
  box.append(actions, status$);

  if (available && !canApply && !problem) {
    box.append(line("No service manager owns this Pier, so it cannot restart itself — update it with: pier update"));
  }

  const auto = toggle(
    "Update automatically",
    canApply
      ? "Installs a new release once nothing is running — no turn in flight, no task run."
      : "Needs the systemd service (pier service install); nothing here can restart Pier.",
    status.autoUpdate,
    (on) => {
      if (status) status.autoUpdate = on;
      void (async () => {
        const res = await sendJson("/api/settings", { autoUpdate: on }, "PUT");
        if (res.ok) return;
        // Reconcile: the server is the truth, and a switch that silently did
        // not take is worse than one that visibly failed.
        if (status) status.autoUpdate = !on;
        const box$ = auto.querySelector("input");
        if (box$) box$.checked = !on;
        status$.className = "px-3 text-[11.5px] text-red-600";
        status$.textContent = await failure(res, "Could not save");
      })();
    },
  );
  // Without a service manager the switch would only store a wish: disabled,
  // and the hint above says what to install instead.
  if (!canApply) {
    const box$ = auto.querySelector("input");
    if (box$) box$.disabled = true;
  }
  box.append(h("div", "mt-1 border-t border-neutral-200 px-3 pb-1 pt-2", auto));
  return box;
}

async function load(current: string): Promise<void> {
  const res = await fetch("/api/update");
  if (!res.ok) return; // an unreachable check is not news: the label stays put
  status = (await res.json()) as UpdateStatus;
  renderLabel(status.current || current);
}

/** Renders the label, then upgrades it to news if there is any. */
export function initVersion(current: string): void {
  renderLabel(current);
  link.onclick = (ev) => {
    ev.preventDefault(); // the panel is the destination; the anchor is the fallback
    openPanel(link, panel());
  };
  const refresh = (): void => void load(current).catch(() => {});
  refresh();
  setInterval(refresh, POLL_MS);
}
