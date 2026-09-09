// Drawer focus and inert state must agree across dismissal and breakpoint changes.
import { beforeEach, afterEach, expect, it, vi } from "vitest";

const dom = vi.hoisted(() => ({ elements: new Map<string, ElementStub>(), active: null as ElementStub | null }));
vi.mock("./dom.js", () => ({ $: (selector: string) => dom.elements.get(selector), h: vi.fn() }));
vi.mock("./shortcut.js", () => ({ shortcut: vi.fn() }));

class ElementStub {
  dataset: Record<string, string> = {};
  inert = false;
  attrs = new Map<string, string>();
  classList = { add: vi.fn(), remove: vi.fn(), contains: vi.fn() };
  listeners = new Map<string, (event: KeyboardEvent) => void>();
  children: ElementStub[] = [];
  appended: ElementStub[] = [];
  precededBy: ElementStub | null = null;
  onclick?: () => void;
  append(el: ElementStub): void { this.appended.push(el); }
  before(el: ElementStub): void { this.precededBy = el; }
  setAttribute(key: string, value: string): void { this.attrs.set(key, value); }
  addEventListener(key: string, listener: (event: KeyboardEvent) => void): void { this.listeners.set(key, listener); }
  contains(el: ElementStub): boolean { return el === this || this.children.includes(el); }
  focus(): void { dom.active = this; }
  querySelectorAll(): ElementStub[] { return this.children; }
  getClientRects(): number[] { return [1]; }
  matches(): boolean { return false; }
}

let shell: typeof import("./shell.js");
let media: { matches: boolean; addEventListener: ReturnType<typeof vi.fn> };
const el = (selector: string): ElementStub => dom.elements.get(selector)!;
const key = (value: string, shiftKey = false, defaultPrevented = false) => {
  const event = { key: value, shiftKey, defaultPrevented, preventDefault: vi.fn(), stopPropagation: vi.fn() };
  el("#sidebar").listeners.get("keydown")!(event as unknown as KeyboardEvent);
  return event;
};
beforeEach(async () => {
  vi.resetModules();
  dom.elements.clear();
  dom.active = null;
  for (const selector of ["#sidebar", "#drawer-scrim", "#mobile-title", "#mobile-menu", "#session-meta", "#mobile-bar", "#chat-menu", "#rail-toggle", "#drawer-toggle", "#new-session", "main"])
    dom.elements.set(selector, new ElementStub());
  el("#sidebar").children = [el("#new-session"), new ElementStub()];
  media = { matches: true, addEventListener: vi.fn() };
  vi.stubGlobal("window", { matchMedia: () => media, addEventListener: vi.fn() });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
  vi.stubGlobal("document", { body: new ElementStub(), get activeElement() { return dom.active; } });
  shell = await import("./shell.js");
  shell.initShell({ sessionMenu: vi.fn(), sessionInfo: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());

it("opens into the drawer and restores the toggle after Escape", () => {
  expect(el("#sidebar").inert).toBe(true);
  el("#drawer-toggle").onclick!();
  expect(el("#sidebar").inert).toBe(false);
  expect(el("main").inert).toBe(true);
  expect(dom.active).toBe(el("#new-session"));
  expect(el("#drawer-toggle").attrs.get("aria-expanded")).toBe("true");
  const event = key("Escape");
  expect(event.stopPropagation).toHaveBeenCalled();
  expect(el("#sidebar").inert).toBe(true);
  expect(el("main").inert).toBe(false);
  expect(dom.active).toBe(el("#drawer-toggle"));
});

it("wraps Tab at both ends and respects Escape consumed by an overlay", () => {
  el("#drawer-toggle").onclick!();
  key("Tab", true);
  expect(dom.active).toBe(el("#sidebar").children.at(-1));
  key("Tab");
  expect(dom.active).toBe(el("#new-session"));
  key("Escape", false, true);
  expect(el("#sidebar").dataset.open).toBe("");
});

it("clears drawer state and releases both panes when resizing to desktop", () => {
  el("#drawer-toggle").onclick!();
  media.matches = false;
  media.addEventListener.mock.calls[0]![1]();
  expect(el("#sidebar").dataset.open).toBeUndefined();
  expect(el("#sidebar").inert).toBe(false);
  expect(el("main").inert).toBe(false);
  expect(el("#drawer-toggle").attrs.get("aria-expanded")).toBe("false");
});

it("returns focus to the rail handle when a drawer becomes a collapsed desktop rail", () => {
  document.body.dataset.rail = "closed";
  el("#drawer-toggle").onclick!();
  media.matches = false;
  media.addEventListener.mock.calls[0]![1]();
  expect(el("#sidebar").inert).toBe(true);
  expect(el("main").inert).toBe(false);
  expect(dom.active).toBe(el("#rail-toggle"));
  el("#rail-toggle").onclick!();
  expect(el("#sidebar").inert).toBe(false);
  el("#new-session").focus();
  el("#rail-toggle").onclick!();
  expect(el("#sidebar").inert).toBe(true);
  expect(dom.active).toBe(el("#rail-toggle"));
});

it("moves the one meta row into whichever heading the width shows", () => {
  // Opened as a drawer (media.matches), so the chips hang off the mobile bar.
  expect(el("#mobile-bar").appended).toContain(el("#session-meta"));
  expect(el("#chat-menu").precededBy).toBeNull();
  media.matches = false;
  media.addEventListener.mock.calls[0]![1]();
  expect(el("#chat-menu").precededBy).toBe(el("#session-meta"));
});
