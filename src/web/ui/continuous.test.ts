// The rail with the continuous-session switch on, drawn on index.html: the
// conversation's own row first, then only what is in progress; switch off,
// the rail is exactly the session list it always was.
import { beforeEach, expect, it, vi } from "vitest";
import { NOT_IN_LEDGER, type ChainMember, type OpenItems, type OpenRun } from "../../core/types.js";
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
const state = { chain: null as ChainMember[] | null, open: false, current: null as string | null, chat: true, items: null as OpenItems | null };
const openContinuous = vi.fn();
const select = vi.fn();
let sessions: Row[] = [];

beforeEach(async () => {
  vi.resetModules();
  doc = installPage();
  sidebar = await import("./sidebar.js");
  Object.assign(state, { chain: null, open: false, current: null, chat: true, items: null });
  sidebar.initSidebar({
    sessions: () => sessions, currentId: () => state.current, select, sessionMenu: vi.fn(), createSession: vi.fn(),
    onTitleChanged: vi.fn(), chain: () => state.chain, continuousOpen: () => state.open, openContinuous,
    chatVisible: () => state.chat, open: () => state.items,
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

// A lead is in progress while something of it runs; after that, seen or not, it is `/status`'s and search's.
it("keeps a lead in progress only while a run, a subagent or a turn of it is live", () => {
  const lead = (id: string, over: Partial<Row> = {}) => row(id, { phase: "design", ...over });
  const rows = [
    lead("done"), lead("unread", { unread: true }), lead("queued", { runLive: true }),
    lead("workers", { activeRuns: 1 }), lead("talking", { state: "streaming", unread: true }),
  ];
  expect(sidebar.inProgress(rows, []).map((s) => s.id).sort()).toEqual(["queued", "talking", "workers"]);
});

const ledgerRun = (runId: string, over: Partial<OpenRun> = {}): OpenRun =>
  ({ runId, name: runId, state: "running", targetSessionId: `s-${runId}`, cwd: null, queuedAt: 0, finishedAt: null, ...over });
const labels = () => list().querySelectorAll("div").map((d) => d.textContent.trim()).filter((t) => ["Open", "Not on the list", "In progress"].includes(t));

it("lists the open items in progress: a worker's live run as a row, nothing that waits on you, never a lead twice", () => {
  state.chain = [member("h1")];
  sessions = [row("h1"), row("s-lead1abcdef", { phase: "design", runLive: true })];
  state.items = {
    items: [
      { problem: "open items 视图", stage: "lead designing", runs: [
        ledgerRun("lead1abcdef", { workers: { queued: 0, running: 1, succeeded: 1, failed: 0, cancelled: 0, interrupted: 0, skipped: 0 } }),
      ] },
      { problem: "model menu", stage: "waiting on you: merge?", runs: [ledgerRun("gone1", { state: NOT_IN_LEDGER, targetSessionId: null })] },
      { problem: "auth review", stage: "worker running", runs: [ledgerRun("w1", { name: "Review src/auth" })] },
    ],
    unlisted: [ledgerRun("r-failed", { name: "Old review", state: "failed", finishedAt: 1 }), ledgerRun("q1", { name: "Queued one", state: "queued", targetSessionId: null })],
  };
  sidebar.renderSessions();
  expect(labels()).toEqual(["In progress"]);
  const rows = list().querySelectorAll("[data-session-id]").map((el) => [el.dataset.sessionId, el.textContent.trim()]);
  expect(rows).toEqual([
    ["continuous", "Conversation"],
    ["s-lead1abcdef", "s-lead1abcdefdesign"],
    ["run:w1", "Review src/authrun"],
    ["run:q1", "Queued onerun"],
  ]);
  expect(list().textContent).not.toContain("workers");
  expect(list().textContent).not.toContain("Old review");
  expect(list().textContent).not.toContain("model menu");
  const byId = (id: string) => list().querySelectorAll("[data-session-id]").find((el) => el.dataset.sessionId === id)!;
  expect(byId("run:w1").querySelectorAll("span").map((el) => el.title)).toEqual(["", "run w1 · running", "working…"]);
  byId("run:w1").querySelector("button")!.onclick?.();
  expect(select).toHaveBeenLastCalledWith("s-w1");
  openContinuous.mockClear();
  byId("run:q1").querySelector("button")!.onclick?.();
  expect(openContinuous).toHaveBeenCalledOnce();
});

it("adds no row when nothing is open, and none while the switch is off", () => {
  state.chain = [member("h1")];
  sessions = [row("h1")];
  state.items = { items: [], unlisted: [] };
  sidebar.renderSessions();
  expect(texts()).toEqual(["Conversation"]);
  expect(labels()).toEqual([]);

  state.chain = null;
  state.items = { items: [{ problem: "p", stage: "s", runs: [] }], unlisted: [] };
  sidebar.renderSessions();
  expect(list().textContent).not.toContain("Open");
});
