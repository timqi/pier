// The status panel on index.html: its order and marks, the status chip's
// counts, and the panel the chip opens — what waits on you over what runs.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChainMember } from "../../core/types.js";
import { fake, installPage, type FakeDocument } from "./dom.testkit.js";

const menu = vi.hoisted(() => ({
  closeMenu: vi.fn(),
  openPanel: vi.fn((anchor: HTMLElement, content: HTMLElement) => {
    anchor.setAttribute("aria-expanded", "true");
    const panel = document.createElement("div");
    panel.append(content);
    document.body.append(panel);
    return panel;
  }),
}));
vi.mock("./menu.js", () => menu);
const badge = vi.hoisted(() => vi.fn());
vi.mock("./notifications.js", () => ({ setUnreadBadge: badge }));
vi.mock("./palette.js", () => ({ refreshPalette: vi.fn() }));
const chords = vi.hoisted(() => new Map<string, [() => void, (() => boolean) | undefined]>());
vi.mock("./shortcut.js", () => ({
  chord: (key: string, run: () => void, unless?: () => boolean) => chords.set(key, [run, unless]),
  modalOpen: () => false,
}));

type Row = import("./drawer.js").SessionInfo;
const row = (id: string, over: Partial<Row> = {}): Row =>
  ({ id, cwd: `/${id}`, title: id, createdAt: 0, state: "idle", unread: false, channel: "web", activeRuns: 0, ...over });
const member = (sessionId: string): ChainMember => ({ sessionId, startedAt: 1, reason: "idle" });

let doc: FakeDocument;
let drawer: typeof import("./drawer.js");
let sessions: Row[] = [];
let chain: ChainMember[] = [];
let current: string | null = null;
let open: import("../../tasks/types.js").OpenItems | null = null;
let topics: { problem: string; done: boolean }[] = [];
let filter: string | null = null;
const select = vi.fn();
// As main.ts wires it: the filter moves, and the panel redraws from it.
const setFilter = vi.fn((p: string | null) => { filter = p; drawer.renderDrawer(); });

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  chords.clear();
  doc = installPage();
  drawer = await import("./drawer.js");
  sessions = [];
  chain = [];
  current = null;
  open = null;
  topics = [];
  filter = null;
  drawer.initDrawer({
    sessions: () => sessions, currentId: () => current, select, chain: () => chain, openContinuous: vi.fn(), open: () => open,
    topics: () => topics, filter: () => filter, setFilter,
  });
});
afterEach(() => vi.restoreAllMocks());

const chip = () => doc.querySelector("#status-chip")!;
const panelRows = () => doc.querySelectorAll(".session-open");
/** A row as it reads: label, who, second line, status. */
const cells = (b: import("./dom.testkit.js").FakeElement): string[] => {
  const name = b.children.at(-1);
  const status = b.parentElement!.querySelector(".row-status");
  const [line, detail] = name!.children;
  const [label, who] = line!.children;
  return [label!.textContent, who?.textContent ?? "", detail!.textContent, status!.textContent];
};
const labels = () => panelRows().map((b) => cells(b)[0]);

it("draws no dot on an idle row and paints one only for something to look at", () => {
  const dot = (over: Partial<Row>) => fake(drawer.stateDot(row("x", over))[0] ?? null as never);
  expect(drawer.stateDot(row("x"))).toEqual([]);
  expect(dot({ state: "streaming" }).className).toContain("bg-green-500");
  // The server marks only the sessions this workbench reads (web/server.ts).
  expect(dot({ unread: true }).className).toContain("bg-amber-500");
  expect(dot({ activeRuns: 2 }).title).toBe("2 subagents running");
  expect(drawer.stateDot(row("x", { phase: "design" }))).toEqual([]);
  expect(dot({ phase: "design", runLive: true }).title).toBe("lead — run queued");
  expect(dot({ phase: "design", designOpen: true }).title).toBe("design — waiting for you to finalize");
});

it("tags a lead's row with its phase, and nothing else", () => {
  expect(drawer.phaseTag(row("x"))).toEqual([]);
  expect(fake(drawer.phaseTag(row("x", { phase: "build" }))[0]).title).toBe("lead — building per the design");
});

it("counts running and needs-you on the chip, omitting a zero half, and is absent at zero", () => {
  drawer.renderDrawer();
  expect(chip().classList.contains("hidden")).toBe(true);
  expect(badge).toHaveBeenLastCalledWith(0);

  sessions = [row("run", { state: "streaming" }), row("q", { phase: "design", runLive: true }), row("idle")];
  drawer.renderDrawer();
  expect(chip().textContent).toBe("1 running");
  expect(chip().classList.contains("hidden")).toBe(false);

  sessions = [row("done", { unread: true }), row("design", { phase: "design", designOpen: true })];
  drawer.renderDrawer();
  expect(chip().textContent).toBe("2 needs you");
  expect(chip().classList.contains("text-amber-700")).toBe(true);
  expect(badge).toHaveBeenLastCalledWith(2);

  sessions = [...sessions, row("run", { state: "streaming" })];
  drawer.renderDrawer();
  expect(chip().textContent).toBe("1 running · 2 needs you");

  // Open items count as the groups their rows are in; the icon badge stays a turn to look at.
  sessions = [];
  open = { items: [{ problem: "a", stage: "", runs: [], status: "waiting on you" }, { problem: "b", stage: "", runs: [], status: "running" }], unlisted: [] };
  drawer.renderDrawer();
  expect(chip().textContent).toBe("1 running · 1 needs you");
  expect(badge).toHaveBeenLastCalledWith(0);
  open = { items: [{ problem: "b", stage: "", runs: [], status: "running" }], unlisted: [] };
  drawer.renderDrawer();
  expect(chip().textContent).toBe("1 running");
  expect(chip().classList.contains("text-neutral-600")).toBe(true);

  // The counts are copy, not the gate: a row neither counts leaves them as they are.
  open = { items: [{ problem: "b", stage: "", runs: [], status: "running" }, { problem: "c", stage: "merged", runs: [], status: "pending release" }], unlisted: [] };
  drawer.renderDrawer();
  expect(chip().textContent).toBe("1 running");
});

// A row neither group counts still opens the panel: the chip is its entrance.
it.each([
  ["pending release", { items: [{ problem: "a", stage: "merged", runs: [], status: "pending release" as const }], unlisted: [] }],
  ["stopped", { items: [{ problem: "a", stage: "", runs: [], status: "stopped" as const }], unlisted: [] }],
  ["an unlisted queued run", { items: [], unlisted: [{ runId: "q1", name: "q", state: "queued" as const, targetSessionId: null, cwd: null, queuedAt: 0, finishedAt: null }] }],
])("reads `1 open` and opens with only %s", (_, items) => {
  open = items;
  drawer.renderDrawer();
  expect(chip().textContent).toBe("1 open");
  expect(chip().classList.contains("hidden")).toBe(false);
  expect(chip().classList.contains("text-neutral-600")).toBe(true);
  drawer.openDrawer();
  expect(menu.openPanel).toHaveBeenCalledOnce();
  expect(panelRows()).toHaveLength(1);
});

// The head is the bar, not a row: it never counts on the chip, but its unread
// reply is on the app icon.
it("leaves the conversation's sessions off the chip and badges the head's unread reply", () => {
  chain = [member("h1"), member("h0")];
  sessions = [row("h1", { unread: true }), row("h0", { state: "streaming" }), row("c", { unread: true })];
  drawer.renderDrawer();
  expect(chip().textContent).toBe("1 needs you");
  expect(badge).toHaveBeenLastCalledWith(2);
  expect(drawer.inProgress(sessions, chain).map((s) => s.id)).toEqual(["c"]);
});

it("opens from the chip or ⌘⇧P, lists the rows, and selects and closes on a click", () => {
  current = "b";
  sessions = [row("b", { unread: true, createdAt: 2 }), row("a", { state: "streaming", createdAt: 1 })];
  drawer.renderDrawer();
  chip().onclick?.();
  expect(menu.openPanel).toHaveBeenCalledOnce();
  const list = doc.querySelector("[data-list='running']")!;
  expect(labels()).toEqual(["b", "a"]);
  expect(panelRows()[0]!.getAttribute("aria-current")).toBe("page");

  // Open again is a close; the chord is the same toggle and stands down under a modal.
  chords.get("shift+p")![0]();
  expect(menu.closeMenu).toHaveBeenCalledOnce();
  expect(chords.get("shift+p")![1]).toBeTypeOf("function");

  panelRows()[1]!.onclick?.();
  expect(menu.closeMenu).toHaveBeenCalledTimes(2);
  expect(select).toHaveBeenCalledWith("a");

  // A render under the open panel refills it in place.
  sessions = [row("c", { activeRuns: 1, createdAt: 3 }), ...sessions];
  drawer.renderDrawer();
  expect(labels()).toEqual(["b", "c", "a"]);
  expect(list.querySelectorAll(".session-open").map((b) => cells(b)[0])).toEqual(["c", "a"]);
});

it("does not open with nothing to show, and closes when it runs out", () => {
  drawer.renderDrawer();
  drawer.openDrawer();
  expect(menu.openPanel).not.toHaveBeenCalled();
  // An answer with no rows is still nothing to show.
  open = { items: [], unlisted: [] };
  sessions = [row("idle")];
  drawer.renderDrawer();
  drawer.openDrawer();
  expect(chip().classList.contains("hidden")).toBe(true);
  expect(chip().textContent).toBe("");
  expect(menu.openPanel).not.toHaveBeenCalled();

  sessions = [row("a", { state: "streaming" })];
  drawer.renderDrawer();
  drawer.openDrawer();
  sessions = [row("a")];
  drawer.renderDrawer();
  expect(menu.closeMenu).toHaveBeenCalledOnce();
});

// One row per session, grouped by who acts next: an item names its status in
// words, its stage and runs as the second line, and opens its run's session.
it("groups the rows waiting on you over in progress, each session once, an item as problem · who · detail · status", () => {
  vi.spyOn(Date, "now").mockReturnValue(10 * 60_000);
  const run = (runId: string, over: Partial<import("../../tasks/types.js").OpenRun> = {}) =>
    ({ runId, name: runId, state: "running", targetSessionId: `s-${runId}`, cwd: null, queuedAt: 0, finishedAt: null, ...over });
  sessions = [
    row("s-lead1abcdef", { title: "多入口统一对话", phase: "design", designOpen: true, state: "streaming", createdAt: 3 }),
    row("s-free", { title: "free", unread: true, createdAt: 2 }),
    row("s-q", { title: "queued lead", phase: "build", runLive: true, createdAt: 1 }),
  ];
  open = {
    items: [
      { problem: "子任务 thread", stage: "design lead narrowing scope (running)", status: "waiting on you",
        runs: [run("lead1abcdef", { state: "succeeded", finishedAt: 0 })] },
      { problem: "0.2.1 清理上线", stage: "merged", status: "pending release", runs: [] },
      { problem: "gone", stage: "", status: "stopped", runs: [] },
      { problem: "auth review", stage: "worker running", status: "running", runs: [run("w1", { queuedAt: 5 * 60_000 })] },
    ],
    unlisted: [run("q1", { name: "Queued one", state: "queued", targetSessionId: null, queuedAt: 9 * 60_000 })],
  };
  drawer.renderDrawer();
  drawer.openDrawer();
  const group = (name: string) => doc.querySelector(`[data-list='${name}']`)!.querySelectorAll(".session-open").map(cells);
  expect(group("waiting")).toEqual([
    ["子任务 thread", "lead · design", "run lead1abc… succeeded 10m ago · design lead narrowing scope (running)", "waiting on you"],
    ["free", "", "turn finished — not viewed yet · active 10m ago", "waiting on you"],
  ]);
  // Done or stopped asks nothing of the user: it waits on nobody, so it is in progress.
  expect(group("running")).toEqual([
    ["0.2.1 清理上线", "", "merged", "pending release"],
    ["gone", "", "", "stopped"],
    ["auth review", "worker", "run w1 running 5m · worker running", "running"],
    ["Queued one", "", "run q1 queued 1m", "queued"],
    ["queued lead", "lead · build", "run queued · active 10m ago", "queued"],
  ]);
  expect(chip().textContent).toBe("1 running · 2 needs you");
  // The lead's session is the item's row, not a row of its own.
  expect(labels()).not.toContain("多入口统一对话");
  panelRows()[0]!.onclick?.();
  expect(select).toHaveBeenLastCalledWith("s-lead1abcdef");
});

it("hides a group's head while it has no rows", () => {
  sessions = [row("a", { state: "streaming" })];
  drawer.renderDrawer();
  drawer.openDrawer();
  const head = (name: string) => doc.querySelector(`[data-list='${name}']`)!.previousElementSibling!;
  expect(head("waiting").classList.contains("hidden")).toBe(true);
  expect(head("running").classList.contains("hidden")).toBe(false);
  expect(head("running").classList.contains("mt-2")).toBe(false);
  sessions = [...sessions, row("b", { unread: true })];
  drawer.renderDrawer();
  expect(head("waiting").classList.contains("hidden")).toBe(false);
  expect(head("running").classList.contains("mt-2")).toBe(true);
});

it("gives each item row its topic's dot and an only-this-topic switch, one on at a time", async () => {
  const { topicColour } = await import("./topics.js");
  open = { items: [{ problem: "a", stage: "", runs: [], status: "running" }, { problem: "b", stage: "", runs: [], status: "waiting on you" }], unlisted: [] };
  sessions = [row("s", { state: "streaming" })];
  drawer.renderDrawer();
  drawer.openDrawer();
  const li = (id: string) => doc.querySelector(`[data-session-id='${id}']`)!;
  const box = (id: string) => li(id).querySelector("input")!;
  expect(li("item:a").querySelector(".session-open")!.children[0]!.style.background).toBe(topicColour("a"));
  const sw = li("item:a").querySelector(".topic-switch")!;
  expect(sw.getAttribute("aria-label")).toBe("Only this topic in the chat");
  // Beside the open button, never inside it, and before the status.
  expect(sw.closest("button")).toBeNull();
  expect(sw.nextElementSibling!.classList.contains("row-status")).toBe(true);
  // A session row has no topic to filter by.
  expect(li("s").querySelector("input")).toBeNull();

  box("item:a").checked = true;
  box("item:a").onchange?.();
  expect(setFilter).toHaveBeenLastCalledWith("a");
  box("item:b").checked = true;
  box("item:b").onchange?.();
  expect(setFilter).toHaveBeenLastCalledWith("b");
  expect([box("item:a").checked, box("item:b").checked]).toEqual([false, true]);
  box("item:b").checked = false;
  box("item:b").onchange?.();
  expect(setFilter).toHaveBeenLastCalledWith(null);
});

it("lists the last done topics not open under Recently done, and keeps the chip for them", () => {
  topics = ["a", "b", "c", "d", "e", "f", "g"].map((problem) => ({ problem, done: problem !== "a" }));
  open = { items: [{ problem: "g", stage: "", runs: [], status: "running" }], unlisted: [] };
  drawer.renderDrawer();
  drawer.openDrawer();
  const done = doc.querySelector("[data-list='done']")!;
  // Most recently done first, of the last five; one still open stays in its own group.
  expect(done.children.map((r) => r.textContent)).toEqual(["f", "e", "d", "c"]);
  expect(done.previousElementSibling!.classList.contains("hidden")).toBe(false);
  expect(done.querySelector(".session-open")).toBeNull();
  expect(done.querySelectorAll("input")).toHaveLength(4);

  open = { items: [], unlisted: [] };
  topics = [{ problem: "x", done: true }];
  drawer.renderDrawer();
  expect(chip().textContent).toBe("topics");
  expect(chip().classList.contains("hidden")).toBe(false);
  topics = [];
  drawer.renderDrawer();
  expect(chip().classList.contains("hidden")).toBe(true);
});
