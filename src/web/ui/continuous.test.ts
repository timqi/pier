// The status panel beside the continuous conversation, drawn on index.html: the
// conversation's own sessions are the bar, not rows; what is in progress is,
// and so is every open item, once.
import { beforeEach, expect, it, vi } from "vitest";
import { NOT_IN_LEDGER, type ChainMember } from "../../core/types.js";
import type { OpenItems, OpenRun } from "../../tasks/types.js";
import { installPage, type FakeDocument } from "./dom.testkit.js";

vi.mock("./menu.js", () => ({
  closeMenu: vi.fn(),
  openPanel: (anchor: HTMLElement, content: HTMLElement) => {
    anchor.setAttribute("aria-expanded", "true");
    document.body.append(content);
    return content;
  },
}));
vi.mock("./notifications.js", () => ({ setUnreadBadge: vi.fn() }));
vi.mock("./shortcut.js", () => ({ chord: vi.fn(), modalOpen: vi.fn() }));

type Row = import("./drawer.js").SessionInfo;
const row = (id: string, over: Partial<Row> = {}): Row =>
  ({ id, cwd: `/${id}`, title: id, createdAt: 0, state: "idle", unread: false, channel: "web", activeRuns: 0, ...over });
const member = (sessionId: string): ChainMember => ({ sessionId, startedAt: 1, reason: "idle" });

let doc: FakeDocument;
let drawer: typeof import("./drawer.js");
const state = { chain: [] as ChainMember[], current: null as string | null, items: null as OpenItems | null };
const openContinuous = vi.fn();
const select = vi.fn();
const showTopic = vi.fn(async (_problem: string, _elsewhere: boolean) => true);
let sessions: Row[] = [];

beforeEach(async () => {
  vi.resetModules();
  doc = installPage();
  drawer = await import("./drawer.js");
  Object.assign(state, { chain: [], current: null, items: null });
  drawer.initDrawer({
    sessions: () => sessions, currentId: () => state.current, select, chain: () => state.chain, openContinuous, open: () => state.items,
    showTopic,
  });
});

/** Rendered, then opened: the panel is the rows. */
const open = () => {
  drawer.renderDrawer();
  drawer.openDrawer();
};

it("leaves the conversation's own sessions out of In progress", () => {
  expect(drawer.inProgress([row("h0", { state: "streaming" }), row("c", { unread: true }), row("i")], [member("h0")]).map((s) => s.id))
    .toEqual(["c"]);
});

// Needs you = unread: a finished lead stays while unread and leaves once viewed;
// In progress is the live sessions less the chain, and nothing else.
it("keeps a finished lead in progress while unread and drops it once viewed", () => {
  const lead = (id: string, over: Partial<Row> = {}) => row(id, { phase: "design", ...over });
  const rows = [
    lead("viewed"), lead("unread", { unread: true }), lead("queued", { runLive: true }),
    lead("workers", { activeRuns: 1 }), lead("talking", { state: "streaming", unread: true }),
    lead("awaiting", { designOpen: true }), row("built", { phase: "build" }), row("built-unread", { phase: "build", unread: true }),
  ];
  const ids = drawer.inProgress(rows, []).map((s) => s.id);
  expect(ids.sort()).toEqual(["awaiting", "built-unread", "queued", "talking", "unread", "workers"]);
  expect(ids).toEqual(rows.filter(drawer.isLive).map((s) => s.id).sort());
});

const ledgerRun = (runId: string, over: Partial<OpenRun> = {}): OpenRun =>
  ({ runId, name: runId, state: "running", targetSessionId: `s-${runId}`, cwd: null, queuedAt: 0, finishedAt: null, ...over });

// The item is the row: a lead it names is not a session row beside it, and a
// failed unlisted run is not in progress.
it("lists each open item once, what waits on you first, with who runs it and where it stands", () => {
  state.chain = [member("h1")];
  sessions = [row("h1"), row("s-lead1abcdef", { phase: "design", runLive: true })];
  state.items = {
    items: [
      { problem: "open items 视图", stage: "lead designing", status: "running", runs: [
        ledgerRun("lead1abcdef", { workers: { queued: 0, running: 1, succeeded: 1, failed: 0, cancelled: 0, interrupted: 0, skipped: 0 } }),
      ] },
      { problem: "model menu", stage: "waiting on you: merge?", status: "waiting on you", runs: [ledgerRun("gone1", { state: NOT_IN_LEDGER, targetSessionId: null })] },
      { problem: "auth review", stage: "worker running", status: "running", runs: [ledgerRun("w1", { name: "Review src/auth" })] },
    ],
    unlisted: [ledgerRun("q1", { name: "Queued one", state: "queued", targetSessionId: null })],
  };
  open();
  const ids = doc.querySelector("[data-list='status']")!.querySelectorAll("[data-session-id]").map((el) => el.dataset.sessionId);
  expect(ids).toEqual(["item:model menu", "s-lead1abcdef", "s-w1", "item:Queued one"]);
  const byId = (id: string) => doc.querySelectorAll("[data-session-id]").find((el) => el.dataset.sessionId === id)!;
  // The row is its stage; who runs it and its runs are the tooltip's.
  expect(byId("s-lead1abcdef").textContent).toBe("open items 视图lead designing");
  expect(byId("s-lead1abcdef").title).toContain("lead · design");
  expect(byId("s-lead1abcdef").title).toContain("workers: 1 running, 1 succeeded");
  expect(byId("item:model menu").title).toContain("run gone1 — not in the ledger");
  byId("s-w1").querySelector("button")!.onclick?.();
  expect(showTopic).toHaveBeenLastCalledWith("auth review", true);
  openContinuous.mockClear();
  byId("item:Queued one").querySelector("button")!.onclick?.();
  expect(openContinuous).toHaveBeenCalledOnce();
});

it("adds no row when nothing is open, and does not open with nothing to list", () => {
  state.chain = [member("h1")];
  sessions = [row("h1", { state: "streaming" })];
  state.items = { items: [], unlisted: [] };
  open();
  expect(doc.querySelector("[data-list]")).toBeNull();
  expect(doc.querySelector("#status-chip")!.classList.contains("hidden")).toBe(true);
});
