// Hash routes and first-level entries on index.html's body, without loading chat or a browser runtime.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fake, installPage, type FakeElement } from "./dom.testkit.js";

const mocks = vi.hoisted(() => {
  const view = () => ({ show: vi.fn(), hide: vi.fn(), create: vi.fn(), refresh: vi.fn(), visible: true });
  return { settings: view(), files: view(), settingsArgs: [] as unknown[] };
});
vi.mock("./chat.js", () => ({ turnsPane: document.querySelector("#turns") }));
vi.mock("./composer.js", () => ({ syncQueuePanel: vi.fn() }));
vi.mock("./settings.js", () => ({ createSettingsView: (...args: unknown[]) => { mocks.settingsArgs = args; return mocks.settings; } }));
vi.mock("./explorer.js", () => ({ createExplorerView: () => mocks.files }));
const el = (selector: string): FakeElement => fake(document.querySelector(selector));
// Panes hide by the `hidden` utility, the one mark, named once here.
const shown = (pane: FakeElement): boolean => !pane.classList.contains("hidden");
const settled = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
let views: typeof import("./views.js");
const conversation = { current: null as string | null, select: vi.fn(), open: vi.fn() };
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks();
  conversation.current = null;
  installPage();
  vi.stubGlobal("location", { hash: "#/" });
  vi.stubGlobal("history", { replaceState: (_a: unknown, _b: string, hash: string) => { location.hash = hash; } });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
  vi.stubGlobal("window", { matchMedia: () => ({ matches: false, addEventListener: vi.fn() }) });
  views = await import("./views.js");
  views.initViews({
    sessions: () => [], currentId: () => conversation.current, currentSession: () => undefined, select: conversation.select,
    inConversation: (id) => id.startsWith("chain-"), openContinuous: conversation.open,
    maybeAckRead: vi.fn(),
  });
});
afterEach(() => vi.unstubAllGlobals());
// Settings drops over the chat like Files: the bar hides under it, and its ✕
// (which Esc shares, settings.ts) goes back to the route it was opened from.
it("opens Settings as an overlay over the chat and closes back to where it was opened", async () => {
  location.hash = "#/session/s1";
  views.showConsole("settings"); await settled();
  expect(location.hash).toBe("#/settings");
  expect(shown(el("#bar"))).toBe(false);
  const close = mocks.settingsArgs.at(-1) as () => void;
  close();
  expect(location.hash).toBe("#/session/s1");

  // Opened from Files: back to Files, and Files still knows its own origin.
  location.hash = "#/conversation";
  views.showFiles("/pi"); await settled();
  views.showConsole("settings"); await settled();
  close();
  expect(location.hash).toBe("#/files/%2Fpi");
});
// A reloaded #/settings has no "from": the current chat, else the conversation.
it("closes an overlay with no origin to the conversation", async () => {
  location.hash = "#/settings"; views.applyRoute(); await settled();
  expect(conversation.open).toHaveBeenCalledOnce();
  (mocks.settingsArgs.at(-1) as () => void)();
  expect(location.hash).toBe("#/conversation");
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
// The conversation's head rotates; its address is #/conversation, whichever
// session is the head. Nothing else is a landing page.
it("opens the conversation on a bare or unknown hash, a session on its own route", () => {
  for (const hash of ["", "#/", "#/conversation", "#/nowhere"]) {
    location.hash = hash; views.applyRoute();
    expect(location.hash).toBe("#/conversation");
  }
  expect(conversation.open).toHaveBeenCalledTimes(4);
  views.setSessionHash("chain-head"); expect(location.hash).toBe("#/conversation");
  views.setSessionHash("other"); expect(location.hash).toBe("#/session/other");
  location.hash = "#/session/child"; views.applyRoute();
  expect(conversation.select).toHaveBeenLastCalledWith("child");
  expect(location.hash).toBe("#/session/child");
  // An old member's link still lands, canonicalised to the conversation.
  location.hash = "#/session/chain-old"; views.applyRoute();
  expect(conversation.select).toHaveBeenLastCalledWith("chain-old");
  expect(location.hash).toBe("#/conversation");
});
