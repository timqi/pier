// Which palette the workbench paints in. The palette itself is CSS — style.css
// redefines Tailwind's colour variables under [data-theme="dark"] — so this
// module owns only the choice: remembered per browser, following the system
// until told otherwise, and re-applied when either changes.

import { $ } from "./dom.js";

type Theme = "system" | "light" | "dark";
const KEY = "pier.theme";
const CYCLE: Theme[] = ["system", "light", "dark"];
const system = window.matchMedia("(prefers-color-scheme: dark)");

// Static markup, the same 16px / 1.5-stroke line icons the rail is drawn with.
const ICON: Record<Theme, string> = {
  system: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" class="h-3.5 w-3.5"><circle cx="8" cy="8" r="5.25"/><path d="M8 2.75a5.25 5.25 0 0 0 0 10.5z" fill="currentColor" stroke="none"/></svg>`,
  light: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" class="h-3.5 w-3.5"><circle cx="8" cy="8" r="3.1"/><path d="M8 1.5v1.4M8 13.1v1.4M1.5 8h1.4M13.1 8h1.4M3.4 3.4l1 1M11.6 11.6l1 1M12.6 3.4l-1 1M4.4 11.6l-1 1"/></svg>`,
  dark: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" class="h-3.5 w-3.5"><path d="M13 9.4A5.6 5.6 0 0 1 6.6 3a5.6 5.6 0 1 0 6.4 6.4z"/></svg>`,
};

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
    btn.innerHTML = ICON[choice];
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
