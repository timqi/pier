// Hash routes and first-level entries on index.html's body, without loading chat or a browser runtime.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fake, installPage, type FakeElement } from "./dom.testkit.js";

const mocks = vi.hoisted(() => {
  const view = () => ({ show: vi.fn(), hide: vi.fn(), create: vi.fn(), refresh: vi.fn(), visible: true });
  return { settings: view(), openFiles: vi.fn(), toggleFiles: vi.fn(), settingsArgs: [] as unknown[] };
});
vi.mock("./chat.js", () => ({ turnsPane: document.querySelector("#turns") }));
vi.mock("./composer.js", () => ({ endVoice: vi.fn(), syncQueuePanel: vi.fn() }));
vi.mock("./settings.js", () => ({ createSettingsView: (...args: unknown[]) => { mocks.settingsArgs = args; return mocks.settings; } }));
vi.mock("./explorer.js", () => ({ openFiles: mocks.openFiles, toggleFiles: mocks.toggleFiles }));
const el = (selector: string): FakeElement => fake(document.querySelector(selector));
// Panes hide by the `hidden` utility, the one mark, named once here.
const shown = (pane: FakeElement): boolean => !pane.classList.contains("hidden");
const settled = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
let views: typeof import("./views.js");
const conversation = { current: null as string | null, chain: "c1" as string | null, select: vi.fn(), open: vi.fn() };
const session = { id: "s1", cwd: "/work" } as unknown as import("./drawer.js").SessionInfo;
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks();
  conversation.current = null;
  conversation.chain = "c1";
  installPage();
  vi.stubGlobal("location", { hash: "#/" });
  const setHash = (_a: unknown, _b: string, hash: string) => { location.hash = hash; };
  vi.stubGlobal("history", { replaceState: setHash, pushState: setHash });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
  vi.stubGlobal("window", { matchMedia: () => ({ matches: false, addEventListener: vi.fn() }) });
  views = await import("./views.js");
  views.initViews({
    currentId: () => conversation.current, currentSession: () => session, select: conversation.select,
    inConversation: (id) => id.startsWith("chain-"), chainId: () => conversation.chain, openChain: conversation.open,
    maybeAckRead: vi.fn(), cancelNavigation: vi.fn(),
  });
});
afterEach(() => vi.unstubAllGlobals());
// Settings drops over the chat: the bar hides under it, and its ✕
// (which Esc shares, settings.ts) goes back to the route it was opened from.
it("opens Settings as an overlay over the chat and closes back to where it was opened", async () => {
  location.hash = "#/session/s1";
  views.showConsole("settings"); await settled();
  expect(location.hash).toBe("#/settings");
  expect(shown(el("#bar"))).toBe(false);
  // The composer is hidden with it: a voice take does not go on behind the overlay.
  expect(shown(el("#composer"))).toBe(false);
  expect((await import("./composer.js")).endVoice).toHaveBeenCalledOnce();
  const close = mocks.settingsArgs.at(-1) as () => void;
  close();
  expect(location.hash).toBe("#/session/s1");
});
// A reloaded #/settings has no "from": the current chat, else the conversation.
it("closes an overlay with no origin to the conversation", async () => {
  location.hash = "#/settings"; views.applyRoute(); await settled();
  expect(conversation.open).toHaveBeenCalledOnce();
  expect(conversation.open).toHaveBeenLastCalledWith(null, null);
  (mocks.settingsArgs.at(-1) as () => void)();
  expect(location.hash).toBe("#/chain/c1");
});
// Files is a dialog over the route, not a route: the hash stays where it was.
it("opens Browse files as the Files dialog on the current session, leaving the hash alone", async () => {
  location.hash = "#/session/s1";
  views.showFiles("/pi/skills/a b", "SKILL.md"); await settled();
  expect(mocks.openFiles).toHaveBeenLastCalledWith(session, "/pi/skills/a b", "SKILL.md");
  views.toggleFiles(); await settled();
  expect(mocks.toggleFiles).toHaveBeenLastCalledWith(session);
  expect(location.hash).toBe("#/session/s1");
  expect(shown(el("#bar"))).toBe(true);
});
// The hash is the item view's state: a reload reopens it in its chain, the problem round-tripped whole.
it("opens an item's view from its hash, and names it there with its chain", () => {
  views.setItemHash("CI 修复 / flaky");
  expect(location.hash).toBe("#/chain/c1/item/CI%20%E4%BF%AE%E5%A4%8D%20%2F%20flaky");
  views.applyRoute();
  expect(conversation.open).toHaveBeenLastCalledWith("c1", "CI 修复 / flaky");
  expect(location.hash).toBe("#/chain/c1/item/CI%20%E4%BF%AE%E5%A4%8D%20%2F%20flaky");
  location.hash = "#/chain/c1/item/%E0%A4%A"; views.applyRoute();
  expect(conversation.open).toHaveBeenLastCalledWith(null, null);
  // A bookmark from before chains names the item alone: main.ts finds its chain.
  location.hash = "#/conversation/item/auth"; views.applyRoute();
  expect(conversation.open).toHaveBeenLastCalledWith(null, "auth");
});
it("ignores malformed encoded routes without crashing", () => {
  location.hash = "#/session/%E0%A4%A"; expect(() => views.applyRoute()).not.toThrow();
});
// A chain's head rotates; its address is #/chain/<id>, whichever session is the head.
// A bare, unknown or pre-chain #/conversation hash lands on the chain main.ts resolves.
it("opens a chain on its own hash, the resolved one on a bare or unknown hash, a session on its own route", () => {
  for (const hash of ["", "#/", "#/conversation", "#/nowhere"]) {
    location.hash = hash; views.applyRoute();
    expect(conversation.open).toHaveBeenLastCalledWith(null, null);
    expect(location.hash).toBe("#/chain/c1");
  }
  location.hash = "#/chain/c%202"; views.applyRoute();
  expect(conversation.open).toHaveBeenLastCalledWith("c 2", null);
  // Before any chain is known the address stays the old one.
  conversation.chain = null;
  location.hash = "#/conversation"; views.applyRoute();
  expect(location.hash).toBe("#/conversation");
  conversation.chain = "c1";
  views.setSessionHash("chain-head"); expect(location.hash).toBe("#/chain/c1");
  views.setSessionHash("other"); expect(location.hash).toBe("#/session/other");
  location.hash = "#/session/child"; views.applyRoute();
  expect(conversation.select).toHaveBeenLastCalledWith("child");
  expect(location.hash).toBe("#/session/child");
  // An old member's link still lands, canonicalised to its chain.
  location.hash = "#/session/chain-old"; views.applyRoute();
  expect(conversation.select).toHaveBeenLastCalledWith("chain-old");
  expect(location.hash).toBe("#/chain/c1");
});
