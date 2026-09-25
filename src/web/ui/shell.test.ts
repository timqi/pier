// Drawer focus and inert state must agree across dismissal and breakpoint changes.
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { fake, installDom, type FakeDocument, type FakeElement } from "./dom.testkit.js";

vi.mock("./shortcut.js", () => ({ shortcut: vi.fn() }));

/** The shell's landmarks, the sidebar reduced to its first and last control. */
const SHELL = `<aside id="sidebar"><button id="new-session"></button><button></button></aside>
<div id="drawer-scrim"></div><button id="rail-toggle"></button>
<main><header id="mobile-bar"><button id="drawer-toggle"></button><span id="mobile-title"></span><button id="mobile-menu"></button></header>
<div><div id="session-meta"></div><button id="chat-menu"></button></div></main>`;

let shell: typeof import("./shell.js");
let doc: FakeDocument;
let media: { matches: boolean; addEventListener: ReturnType<typeof vi.fn> };
const el = (selector: string): FakeElement => fake(doc.querySelector(selector));
const key = (value: string, shiftKey = false, defaultPrevented = false) => {
  const event = Object.assign(new Event("keydown", { cancelable: true }), { key: value, shiftKey });
  if (defaultPrevented) event.preventDefault();
  vi.spyOn(event, "stopPropagation");
  el("#sidebar").dispatchEvent(event);
  return event;
};
beforeEach(async () => {
  vi.resetModules();
  doc = installDom();
  doc.body.innerHTML = SHELL;
  // The fake has no layout; both sidebar controls are on screen.
  for (const control of el("#sidebar").children) control.getClientRects = () => [{}];
  media = { matches: true, addEventListener: vi.fn() };
  vi.stubGlobal("window", { matchMedia: () => media, addEventListener: vi.fn() });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
  shell = await import("./shell.js");
  shell.initShell({ sessionMenu: vi.fn(), sessionInfo: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());

it("opens into the drawer and restores the toggle after Escape", () => {
  expect(el("#sidebar").inert).toBe(true);
  el("#drawer-toggle").onclick!();
  expect(el("#sidebar").inert).toBe(false);
  expect(el("main").inert).toBe(true);
  expect(doc.activeElement).toBe(el("#new-session"));
  expect(el("#drawer-toggle").getAttribute("aria-expanded")).toBe("true");
  const event = key("Escape");
  expect(event.stopPropagation).toHaveBeenCalled();
  expect(el("#sidebar").inert).toBe(true);
  expect(el("main").inert).toBe(false);
  expect(doc.activeElement).toBe(el("#drawer-toggle"));
});

it("wraps Tab at both ends and respects Escape consumed by an overlay", () => {
  el("#drawer-toggle").onclick!();
  key("Tab", true);
  expect(doc.activeElement).toBe(el("#sidebar").children.at(-1));
  key("Tab");
  expect(doc.activeElement).toBe(el("#new-session"));
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
  expect(el("#drawer-toggle").getAttribute("aria-expanded")).toBe("false");
});

it("returns focus to the rail handle when a drawer becomes a collapsed desktop rail", () => {
  document.body.dataset.rail = "closed";
  el("#drawer-toggle").onclick!();
  media.matches = false;
  media.addEventListener.mock.calls[0]![1]();
  expect(el("#sidebar").inert).toBe(true);
  expect(el("main").inert).toBe(false);
  expect(doc.activeElement).toBe(el("#rail-toggle"));
  el("#rail-toggle").onclick!();
  expect(el("#sidebar").inert).toBe(false);
  el("#new-session").focus();
  el("#rail-toggle").onclick!();
  expect(el("#sidebar").inert).toBe(true);
  expect(doc.activeElement).toBe(el("#rail-toggle"));
});

it("moves the one meta row into whichever heading the width shows", () => {
  // Opened as a drawer (media.matches), so the chips hang off the mobile bar.
  expect(el("#session-meta").parentElement).toBe(el("#mobile-bar"));
  expect(el("#chat-menu").previousElementSibling).toBeNull();
  media.matches = false;
  media.addEventListener.mock.calls[0]![1]();
  expect(el("#chat-menu").previousElementSibling).toBe(el("#session-meta"));
});
