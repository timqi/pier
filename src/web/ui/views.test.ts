// Hash routes and first-level entries on index.html's body, without loading chat or a browser runtime.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fake, installPage, type FakeElement } from "./dom.testkit.js";

const mocks = vi.hoisted(() => {
  const view = () => ({ show: vi.fn(), hide: vi.fn(), create: vi.fn(), refresh: vi.fn(), visible: true });
  return { settings: view(), files: view() };
});
vi.mock("./chat.js", () => ({ turnsPane: document.querySelector("#turns") }));
vi.mock("./composer.js", () => ({ syncQueuePanel: vi.fn() }));
vi.mock("./session-header.js", () => ({ renderHeader: vi.fn() }));
vi.mock("./sidebar.js", () => ({ orderSessions: () => ({ top: [], rest: [] }), renderSessions: vi.fn() }));
vi.mock("./settings.js", () => ({ createSettingsView: () => mocks.settings }));
vi.mock("./explorer.js", () => ({ createExplorerView: () => mocks.files }));
const el = (selector: string): FakeElement => fake(document.querySelector(selector));
// The sidebar's Console row does not expose its active state (no
// aria-current), and panes hide by the `hidden` utility: the two class names
// are the only marks, named once here.
const lit = (row: FakeElement): boolean => row.classList.contains("bg-indigo-50");
const shown = (pane: FakeElement): boolean => !pane.classList.contains("hidden");
/** The mobile top bar: its title, and whether the session ⋯ menu beside it shows. */
const bar = (): [string, boolean] => [el("#mobile-title").textContent, shown(el("#mobile-menu"))];
const settled = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
let views: typeof import("./views.js");
const conversation = { on: false, select: vi.fn(), open: vi.fn() };
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks();
  conversation.on = false;
  installPage();
  vi.stubGlobal("location", { hash: "#/" });
  vi.stubGlobal("history", { replaceState: (_a: unknown, _b: string, hash: string) => { location.hash = hash; } });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
  vi.stubGlobal("window", { matchMedia: () => ({ matches: false, addEventListener: vi.fn() }) });
  views = await import("./views.js");
  views.initViews({
    sessions: () => [], currentId: () => null, currentSession: () => undefined, select: conversation.select,
    continuousOn: () => conversation.on, inConversation: (id) => conversation.on && id.startsWith("chain-"), openContinuous: conversation.open,
    maybeAckRead: vi.fn(),
  });
});
afterEach(() => vi.unstubAllGlobals());
it("lights the Console's one row, Settings, and names it on the mobile bar", async () => {
  el("#open-settings").onclick!(); await settled();
  expect(location.hash).toBe("#/settings");
  expect(lit(el("#open-settings"))).toBe(true);
  expect(bar()).toEqual(["Settings", false]);
  views.showChat();
  expect(lit(el("#open-settings"))).toBe(false);
});
// The rail lights the open session only while the chat shows, so both switches repaint it.
it("repaints the rail when a Console view covers the chat and when the chat returns", async () => {
  const { renderSessions } = await import("./sidebar.js");
  views.showConsole("settings", "models"); await settled();
  expect(renderSessions).toHaveBeenCalledOnce();
  views.showChat();
  expect(renderSessions).toHaveBeenCalledTimes(2);
});
it("routes Browse files as a folder plus the file to select, and hands both to the view", async () => {
  views.showFiles("/pi/skills/a b", "SKILL.md"); await settled();
  expect(location.hash).toBe("#/files/%2Fpi%2Fskills%2Fa%20b?select=SKILL.md");
  expect(mocks.files.show).toHaveBeenLastCalledWith("/pi/skills/a b", "select=SKILL.md");
  views.showFiles("/pi"); await settled();
  expect(location.hash).toBe("#/files/%2Fpi");
});
it("ignores malformed encoded routes without crashing", () => {
  location.hash = "#/files/%E0%A4%A"; expect(() => views.applyRoute()).not.toThrow();
});
// The conversation's head rotates; its address is #/conversation, whichever session is the head.
it("names the continuous conversation by its own route, not its head session", () => {
  conversation.on = true;
  for (const hash of ["", "#/", "#/conversation", "#/nowhere"]) {
    location.hash = hash; views.applyRoute();
    expect(location.hash).toBe("#/conversation");
  }
  expect(conversation.open).toHaveBeenCalledTimes(4);
  views.setSessionHash("chain-head"); expect(location.hash).toBe("#/conversation");
  views.setSessionHash("other"); expect(location.hash).toBe("#/session/other");
  // An old member's link still lands, canonicalised to the conversation.
  location.hash = "#/session/chain-old"; views.applyRoute();
  expect(conversation.select).toHaveBeenLastCalledWith("chain-old");
  expect(location.hash).toBe("#/conversation");
});
it("falls back to a session route for #/conversation while the switch is off", () => {
  location.hash = "#/conversation"; views.applyRoute();
  expect(conversation.open).not.toHaveBeenCalled();
});
