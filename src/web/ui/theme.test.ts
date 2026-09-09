// Installed chrome must match the canvas before boot and after theme changes.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import html from "./index.html?raw";
import manifestText from "./public/manifest.webmanifest?raw";

const canvases = ["#f1f4f3", "#14171a"];
const boot = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
const ui = vi.hoisted(() => ({
  root: { dataset: {} as Record<string, string> },
  meta: { content: "", setAttribute(_key: string, value: string) { this.content = value; } },
  button: { onclick: null as (() => void) | null, title: "", replaceChildren: vi.fn(), setAttribute: vi.fn() },
}));
vi.mock("./icons.js", () => ({ icon: vi.fn() }));
vi.mock("./dom.js", () => ({ $: (selector: string) => selector === "#theme-toggle" ? ui.button : ui.meta }));

let stored: string | null;
let system: { matches: boolean; addEventListener: ReturnType<typeof vi.fn> };
beforeEach(() => {
  vi.resetModules();
  stored = null;
  ui.root.dataset = {};
  ui.meta.content = "";
  system = { matches: false, addEventListener: vi.fn() };
  vi.stubGlobal("document", { documentElement: ui.root, querySelector: () => ui.meta });
  vi.stubGlobal("window", { matchMedia: () => system, dispatchEvent: vi.fn() });
  vi.stubGlobal("localStorage", {
    getItem: () => stored,
    setItem: (_key: string, value: string) => { stored = value; },
    removeItem: () => { stored = null; },
  });
  vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => ui.root.dataset.theme === "dark" ? canvases[1] : canvases[0] }));
});
afterEach(() => vi.unstubAllGlobals());

it.each(["light", "dark", "system", "denied"])("sets early chrome color with %s storage", (choice) => {
  new Function("document", "localStorage", "matchMedia", boot)(
    document,
    { getItem() { if (choice === "denied") throw new Error("denied"); return choice; } },
    () => ({ matches: true }),
  );
  const mode = choice === "light" ? "light" : "dark";
  expect(ui.root.dataset.theme).toBe(mode);
  expect(ui.meta.content).toBe(canvases[mode === "dark" ? 1 : 0]);
});

it("keeps manifest and initial HTML fallbacks on the light canvas", () => {
  const manifest = JSON.parse(manifestText);
  expect(manifest.theme_color).toBe(canvases[0]);
  expect(manifest.background_color).toBe(canvases[0]);
  expect(html).toContain(`name="theme-color" content="${canvases[0]}"`);
});

it("updates chrome on theme cycling and respects explicit choice across system changes", async () => {
  const { initTheme } = await import("./theme.js");
  initTheme();
  expect(ui.meta.content).toBe(canvases[0]);
  ui.button.onclick!(); // system → light
  system.matches = true;
  system.addEventListener.mock.calls[0]![1]();
  expect(ui.root.dataset.theme).toBe("light");
  expect(ui.meta.content).toBe(canvases[0]);
  ui.button.onclick!(); // light → dark
  expect(ui.meta.content).toBe(canvases[1]);
  ui.button.onclick!(); // dark → system
  expect(stored).toBeNull();
  expect(ui.meta.content).toBe(canvases[1]);
  system.matches = false;
  system.addEventListener.mock.calls[0]![1]();
  expect(ui.root.dataset.theme).toBe("light");
  expect(ui.meta.content).toBe(canvases[0]);
});
