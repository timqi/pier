// The rail with the continuous-session switch on, drawn on index.html: the
// conversation's own row first, then only what is in progress; switch off,
// the rail is exactly the session list it always was.
import { beforeEach, expect, it, vi } from "vitest";
import type { ChainMember } from "../../core/types.js";
import { installPage, type FakeDocument } from "./dom.testkit.js";

vi.mock("./dir-picker.js", () => ({ openBrowser: vi.fn(), openPathMenu: vi.fn() }));
vi.mock("./menu.js", () => ({ closeMenu: vi.fn() }));
vi.mock("./notifications.js", () => ({ setUnreadBadge: vi.fn() }));
vi.mock("./palette.js", () => ({ refreshPalette: vi.fn() }));
vi.mock("./shell.js", () => ({ setAttention: vi.fn() }));
vi.mock("./shortcut.js", () => ({ shortcut: vi.fn(), chord: vi.fn(), modalOpen: vi.fn() }));

type Row = import("./sidebar.js").SessionInfo;
const row = (id: string, over: Partial<Row> = {}): Row =>
  ({ id, cwd: `/${id}`, title: id, createdAt: 0, state: "idle", unread: false, channel: "web", activeRuns: 0, ...over });
const member = (sessionId: string): ChainMember => ({ sessionId, startedAt: 1, reason: "idle" });

let doc: FakeDocument;
let sidebar: typeof import("./sidebar.js");
const state = { chain: null as ChainMember[] | null, open: false, current: null as string | null, chat: true };
const openContinuous = vi.fn();
const select = vi.fn();
let sessions: Row[] = [];

beforeEach(async () => {
  vi.resetModules();
  doc = installPage();
  sidebar = await import("./sidebar.js");
  Object.assign(state, { chain: null, open: false, current: null, chat: true });
  sidebar.initSidebar({
    sessions: () => sessions, currentId: () => state.current, select, sessionMenu: vi.fn(), createSession: vi.fn(),
    onTitleChanged: vi.fn(), chain: () => state.chain, continuousOpen: () => state.open, openContinuous,
    chatVisible: () => state.chat,
  });
});

const list = () => doc.querySelector("#session-list")!;
const texts = () => list().querySelectorAll(".session-open").map((b) => b.textContent.trim());

it("draws the session list unchanged while the switch is off", () => {
  sessions = [row("a", { createdAt: 2 }), row("b", { createdAt: 1 })];
  sidebar.renderSessions();
  expect(texts()).toEqual(["a", "b"]);
  expect(doc.querySelector("#sessions-label")!.classList.contains("hidden")).toBe(false);
});

it("puts the conversation first, then only what is in progress, and collapses the group when nothing is", () => {
  state.chain = [member("h1"), member("h0")];
  state.open = true;
  sessions = [
    row("h1", { state: "streaming" }), row("h0", { unread: true }),
    row("idle"), row("running", { state: "streaming" }), row("waiting", { activeRuns: 1 }),
  ];
  sidebar.renderSessions();
  expect(texts()).toEqual(["Conversation", "running", "waiting"]);
  expect(list().textContent).toContain("In progress");
  expect(doc.querySelector("#sessions-label")!.classList.contains("hidden")).toBe(true);
  const entry = list().querySelectorAll(".session-open")[0]!;
  expect(entry.getAttribute("aria-current")).toBe("page");
  entry.onclick?.();
  expect(openContinuous).toHaveBeenCalledOnce();

  sessions = [row("h1"), row("idle")];
  sidebar.renderSessions();
  expect(texts()).toEqual(["Conversation"]);
  expect(list().textContent).not.toContain("In progress");
});

// A Console view (Settings) covers the chat: its own row is the lit one, so no
// session row may stay lit beside it, switch on or off.
it("lights the open conversation or session only while the chat is on screen", () => {
  const lit = () => list().querySelectorAll(".session-open")
    .filter((b) => b.getAttribute("aria-current") === "page").map((b) => b.textContent.trim());
  sessions = [row("a"), row("b")];
  state.current = "a";
  sidebar.renderSessions();
  expect(lit()).toEqual(["a"]);
  state.chat = false;
  sidebar.renderSessions();
  expect(lit()).toEqual([]);

  state.chain = [member("a")];
  state.open = true;
  sidebar.renderSessions();
  expect(lit()).toEqual([]);
  expect(list().querySelector("li")!.classList.contains("bg-indigo-50")).toBe(false);
  state.chat = true;
  sidebar.renderSessions();
  expect(lit()).toEqual(["Conversation"]);
  expect(list().querySelector("li")!.classList.contains("bg-indigo-50")).toBe(true);
});

it("leaves the conversation's own sessions out of In progress", () => {
  expect(sidebar.inProgress([row("h0", { state: "streaming" }), row("c", { unread: true }), row("i")], [member("h0")]).map((s) => s.id))
    .toEqual(["c"]);
});

// A lead's ended turn waits on the user: seen or not, it stays until deleted.
it("keeps an idle, read lead in progress", () => {
  expect(sidebar.inProgress([row("lead", { role: "lead" }), row("i")], []).map((s) => s.id)).toEqual(["lead"]);
});
