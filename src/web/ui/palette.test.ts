// The ⌘K palette on index.html: the Pier row leads, then Recent (what the
// status panel does not list) and Actions; a query keeps Pier first while it matches.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FakeElement, installPage, type FakeDocument } from "./dom.testkit.js";

type Row = import("./drawer.js").SessionInfo;
const row = (id: string, over: Partial<Row> = {}): Row =>
  ({ id, cwd: "/w", title: id, createdAt: 0, state: "idle", unread: false, channel: "web", activeRuns: 0, ...over });

const state = vi.hoisted(() => ({ sessions: [] as Row[], head: undefined as Row | undefined }));
vi.mock("./api.js", () => ({ getJson: vi.fn(() => new Promise(() => {})) }));
vi.mock("./chat.js", () => ({ revealTurn: vi.fn() }));
vi.mock("./menu.js", () => ({ listStep: vi.fn(), menuOpen: () => false }));
vi.mock("./shortcut.js", () => ({ chord: vi.fn() }));
vi.mock("./drawer.js", () => ({
  headSession: () => state.head,
  isLive: (s: Row) => s.state === "streaming",
  phaseTag: () => [],
  stateDot: () => [],
}));

let doc: FakeDocument;
let palette: typeof import("./palette.js");
const openContinuous = vi.fn();

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
  vi.stubGlobal("HTMLElement", FakeElement); // render tells its notes from its rows by class
  doc = installPage();
  palette = await import("./palette.js");
  palette.initPalette({
    sessions: () => state.sessions, loadSessions: () => Promise.resolve(), select: vi.fn(() => Promise.resolve()),
    openContinuous, openConsole: vi.fn(),
  });
});
afterEach(() => vi.unstubAllGlobals());

const list = () => doc.querySelector("#palette-list")!;
/** Section heads and rows (label, then the cwd's basename), in order. */
const lines = () => list().children.map((el) => (el.classList.contains("palette-row") ? el.textContent.trim() : `# ${el.textContent.trim()}`));

it("leads with the Pier row, then the sessions not live newest first, and Settings", () => {
  const head = row("h1", { createdAt: 9 });
  state.head = head;
  state.sessions = [head, row("lead", { state: "streaming", createdAt: 5 }), row("member", { createdAt: 3 }), row("old", { createdAt: 1 })];
  palette.togglePalette();
  const got = lines();
  expect(got[0]).toMatch(/^Pier/);
  expect(got.map((l) => l.replace(/\d.*$/, ""))).toEqual([
    expect.stringMatching(/^Pier/), "# Recent", "memberw", "oldw", "# Actions", expect.stringMatching(/^Settings/),
  ]);
  list().children[0]!.onclick?.();
  expect(openContinuous).toHaveBeenCalledOnce();
});

it("keeps Pier first while the query matches it, and drops it when not", () => {
  state.sessions = [row("conversation notes")];
  palette.togglePalette();
  const input = doc.querySelector("#palette-input")!;
  input.value = "conv";
  input.oninput?.();
  expect(lines()[0]).toMatch(/^Pier/);
  input.value = "pier";
  input.oninput?.();
  expect(lines()[0]).toMatch(/^Pier/);
  input.value = "notes";
  input.oninput?.();
  expect(lines().some((l) => l.startsWith("Pier"))).toBe(false);
});
