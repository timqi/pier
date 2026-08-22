// What the version label beside the title says.
//
// Two states and nothing else: the version this instance is, and — once the
// server's registry check has an answer — the version it could be. The second
// state looks different on purpose: a number that is merely true should not
// draw the eye, and one you can act on should.
//
// No button. Applying an update installs a package and restarts the process on
// a machine that holds provider keys, so it stays `pier update` in a terminal.

import { $ } from "./dom.js";

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

interface UpdateStatus {
  latest: string | null;
  available: boolean;
}

/** Renders the label, then upgrades it to news if there is any. */
export function initVersion(current: string): void {
  const link = $<HTMLAnchorElement>("#version");
  link.textContent = `v${current}`;

  void fetch("/api/update")
    .then((r) => r.json() as Promise<UpdateStatus>)
    .then(({ latest, available }) => {
      if (!available || !latest) return;
      link.textContent = `v${current} → ${latest}`;
      link.href = `${SOURCE}/releases`;
      link.title = `${latest} is out. Update with: pier update`;
      link.classList.remove(...QUIET);
      link.classList.add(...BADGE);
    })
    // An unreachable check is not news either: the label stays as it was.
    .catch(() => {});
}
