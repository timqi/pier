// Which palette the workbench paints in. The palette itself is CSS — style.css
// redefines Tailwind's colour variables under [data-theme="dark"] — so this
// module owns only the choice: remembered per browser, following the system
// until told otherwise, and re-applied when either changes.

import { Monitor, Moon, Sun, type IconNode } from "lucide";
import { icon } from "./icons.js";
import { $ } from "./dom.js";

type Theme = "system" | "light" | "dark";
const KEY = "pier.theme";
const CYCLE: Theme[] = ["system", "light", "dark"];
const system = window.matchMedia("(prefers-color-scheme: dark)");

const ICON: Record<Theme, IconNode> = { system: Monitor, light: Sun, dark: Moon };

// Storage can be denied outright (private mode, blocked cookies). That is a
// state, not a failure: the choice simply cannot outlive the tab, and the
// workbench must not fail to boot over a colour preference.
const stored = (): Theme => {
  let v: string | null = null;
  try {
    v = localStorage.getItem(KEY);
  } catch {
    return "system";
  }
  return v === "light" || v === "dark" ? v : "system";
};

/** What the choice paints as right now. */
const resolved = (): "light" | "dark" => {
  const choice = stored();
  return choice === "system" ? (system.matches ? "dark" : "light") : choice;
};

function apply(): void {
  const mode = resolved();
  document.documentElement.dataset.theme = mode;
  // Not reachable from CSS: this is the tab strip, the installed window's
  // chrome and the iOS status-bar strip the page paints under.
  $('meta[name="theme-color"]').setAttribute("content", mode === "dark" ? "#1c1c1c" : "#fafafa");
  // The Activity graph paints with SVG attributes, which cannot carry var().
  window.dispatchEvent(new Event("pier:theme"));
}

export function initTheme(): void {
  const btn = $<HTMLButtonElement>("#theme-toggle");
  const paint = (): void => {
    const choice = stored();
    btn.title = `Theme: ${choice}${choice === "system" ? ` (${resolved()})` : ""}`;
    // One control, three states: the icon names the state, and for the one
    // state that is not a colour — "system" — the title says what it resolved to.
    btn.replaceChildren(icon(ICON[choice]));
    btn.setAttribute("aria-label", btn.title);
    apply();
  };
  btn.onclick = () => {
    const next = CYCLE[(CYCLE.indexOf(stored()) + 1) % CYCLE.length]!;
    try {
      if (next === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch {
      // Unwritable: paint() reads storage back, so the click reverts visibly
      // rather than leaving a control that lies about what is stored.
    }
    paint();
  };
  // A system flip only moves the page while the choice is still "system".
  system.addEventListener("change", paint);
  paint();
}
