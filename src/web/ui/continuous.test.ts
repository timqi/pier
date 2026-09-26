// The drawer beside the continuous conversation, drawn on index.html: the
// conversation's own sessions are the bar, not rows; what is in progress is,
// and so are the open items' live runs no session row stands for.
import { beforeEach, expect, it, vi } from "vitest";
import { NOT_IN_LEDGER, type ChainMember, type OpenItems, type OpenRun } from "../../core/types.js";
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
vi.mock("./palette.js", () => ({ refreshPalette: vi.fn() }));
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
let sessions: Row[] = [];

beforeEach(async () => {
  vi.resetModules();
  doc = installPage();
  drawer = await import("./drawer.js");
  Object.assign(state, { chain: [], current: null, items: null });
  drawer.initDrawer({
    sessions: () => sessions, currentId: () => state.current, select, chain: () => state.chain, openContinuous, open: () => state.items,
  });
});

/** Rendered, then opened: the panel is the rows. */
const open = () => {
  drawer.renderDrawer();
  drawer.openDrawer();
};
const list = () => doc.querySelector("[data-list]")!;

it("leaves the conversation's own sessions out of In progress", () => {
  expect(drawer.inProgress([row("h0", { state: "streaming" }), row("c", { unread: true }), row("i")], [member("h0")]).map((s) => s.id))
    .toEqual(["c"]);
});

// Needs you = unread: a finished lead stays while unread and leaves once viewed;
// In progress is the palette's Running set, less the chain, and nothing else.
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
    designs: [],
  };
  open();
  const rows = list().querySelectorAll("[data-session-id]").map((el) => [el.dataset.sessionId, el.textContent.trim()]);
  expect(rows).toEqual([
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

it("adds no row when nothing is open, and does not open with nothing to list", () => {
  state.chain = [member("h1")];
  sessions = [row("h1", { state: "streaming" })];
  state.items = { items: [], unlisted: [], designs: [] };
  open();
  expect(doc.querySelector("[data-list]")).toBeNull();
  expect(doc.querySelector("#status-chip")!.classList.contains("hidden")).toBe(true);
});
