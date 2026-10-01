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
const select = vi.fn();
const showTopic = vi.fn(async (_problem: string, _elsewhere: boolean) => true);

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
  drawer.initDrawer({
    sessions: () => sessions, currentId: () => current, select, chain: () => chain, openContinuous: vi.fn(), open: () => open, showTopic,
  });
});
afterEach(() => vi.restoreAllMocks());

const chip = () => doc.querySelector("#status-chip")!;
const panelRows = () => doc.querySelectorAll(".session-open");
/** A row as it reads: label, who, second line, status (none while running). */
const cells = (b: import("./dom.testkit.js").FakeElement): string[] => {
  const name = b.children.at(-1);
  const status = b.parentElement!.querySelector(".row-status");
  const [line, detail] = name!.children;
  const [label, who] = line!.children;
  return [label!.textContent, who?.textContent ?? "", detail!.textContent, status?.textContent ?? ""];
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
  const list = doc.querySelector("[data-list='status']")!;
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
  expect(list.querySelectorAll(".session-open").map((b) => cells(b)[0])).toEqual(["b", "c", "a"]);
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

// One row per session, grouped by who acts next: an item is its problem and its
// stage (its runs where it has none), with its status in words unless running.
it("lists what waits on you first, in one list, each session once, an item as problem · stage · status", () => {
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
  expect(doc.querySelectorAll("[data-list]").length).toBe(1);
  expect(doc.querySelector("[data-list='status']")!.querySelectorAll(".session-open").map(cells)).toEqual([
    ["子任务 thread", "", "design lead narrowing scope (running)", "waiting on you"],
    ["free", "", "turn finished — not viewed yet · active 10m ago", "waiting on you"],
    // Done or stopped asks nothing of the user: it sorts below.
    ["0.2.1 清理上线", "", "merged", "pending release"],
    ["gone", "", "", "stopped"],
    ["auth review", "", "worker running", ""],
    ["Queued one", "", "run q1 queued 1m", "queued"],
    ["queued lead", "lead · build", "run queued · active 10m ago", "queued"],
  ]);
  expect(chip().textContent).toBe("1 running · 2 needs you");
  // The status that asks something of the reader is the solid one.
  const tag = (label: string) => doc.querySelectorAll(".row-status").find((t) => t.textContent === label)!;
  expect(tag("waiting on you").classList.contains("bg-amber-700")).toBe(true);
  expect(tag("queued").classList.contains("bg-amber-700")).toBe(false);
  // The lead's session is the item's row, not a row of its own.
  expect(labels()).not.toContain("多入口统一对话");
  // The runs and who runs them are the tooltip's.
  expect(doc.querySelector("[data-session-id='s-w1']")!.title).toBe("auth review\nworker running\nrun w1 running 5m\nworker");
});

it("gives each item its topic's dot, pulsing while a run of it is live, and a session its mark", async () => {
  const { topicColour } = await import("./topics.js");
  const run = (state: "running" | "queued") =>
    ({ runId: `r-${state}`, name: state, state, targetSessionId: null, cwd: null, queuedAt: 0, finishedAt: null });
  open = {
    items: [{ problem: "a", stage: "", runs: [run("running")], status: "running" }, { problem: "b", stage: "", runs: [], status: "waiting on you" }],
    unlisted: [run("queued")],
  };
  sessions = [row("s", { state: "streaming" })];
  drawer.renderDrawer();
  drawer.openDrawer();
  const dot = (id: string) => doc.querySelector(`[data-session-id='${id}']`)!.querySelector(".session-open")!.children[0]!;
  expect(dot("item:a").style.background).toBe(topicColour("a"));
  expect(dot("item:a").classList.contains("animate-pulse")).toBe(true);
  expect(dot("item:b").classList.contains("animate-pulse")).toBe(false);
  expect(dot("item:queued").classList.contains("bg-neutral-400")).toBe(true);
  expect(dot("item:queued").classList.contains("animate-pulse")).toBe(false);
  expect(dot("s").classList.contains("bg-green-500")).toBe(true);
  // No green `running` word: only a row that is not running says its status, and it still describes the row.
  expect(doc.querySelectorAll(".row-status").map((t) => t.textContent)).toEqual(["waiting on you", "queued"]);
  const b = doc.querySelector("[data-session-id='item:b']")!;
  expect(b.querySelector(".row-status")!.getAttribute("id")).toBe(b.querySelector(".session-open")!.getAttribute("aria-describedby"));
  expect(doc.querySelector("[data-session-id='item:a']")!.querySelector(".session-open")!.getAttribute("aria-describedby")).toBeNull();
});

it("lands an item on its topic's latest reply, else on its run's session, else stays where showTopic left it", async () => {
  open = { items: [{ problem: "a", stage: "", runs: [{ runId: "w1", name: "w1", state: "running", targetSessionId: "s-w1", cwd: null, queuedAt: 0, finishedAt: null }], status: "running" }], unlisted: [] };
  drawer.renderDrawer();
  drawer.openDrawer();
  panelRows()[0]!.onclick?.();
  await Promise.resolve();
  await Promise.resolve();
  expect(menu.closeMenu).toHaveBeenCalled();
  // It has a session to fall back to, so no tail scroll first.
  expect(showTopic).toHaveBeenLastCalledWith("a", true);
  expect(select).not.toHaveBeenCalled();
  showTopic.mockResolvedValueOnce(false);
  panelRows()[0]!.onclick?.();
  await Promise.resolve();
  await Promise.resolve();
  expect(select).toHaveBeenLastCalledWith("s-w1");
  // No session to fall back to: the conversation's tail, which showTopic scrolled to, is the landing.
  select.mockClear();
  open = { items: [{ problem: "b", stage: "", runs: [], status: "waiting on you" }], unlisted: [] };
  drawer.renderDrawer();
  drawer.openDrawer();
  showTopic.mockResolvedValueOnce(false);
  panelRows()[0]!.onclick?.();
  await Promise.resolve();
  await Promise.resolve();
  expect(showTopic).toHaveBeenLastCalledWith("b", false);
  expect(select).not.toHaveBeenCalled();
});

it("opens an item that waits in a child session in that session, not on its topic", () => {
  open = { items: [{ problem: "d", stage: "", runs: [{ runId: "l1", name: "l1", state: "succeeded", targetSessionId: "s-l1", cwd: null, queuedAt: 0, finishedAt: 0 }], status: "waiting on you", waitsIn: "s-l1" }], unlisted: [] };
  drawer.renderDrawer();
  drawer.openDrawer();
  panelRows()[0]!.onclick?.();
  expect(select).toHaveBeenLastCalledWith("s-l1");
  expect(showTopic).not.toHaveBeenCalled();
});

it("has no Recently done group, and no chip without a row", () => {
  open = { items: [{ problem: "a", stage: "", runs: [], status: "running" }], unlisted: [] };
  drawer.renderDrawer();
  drawer.openDrawer();
  expect(doc.querySelector("[data-list='done']")).toBeNull();
  open = { items: [], unlisted: [] };
  drawer.renderDrawer();
  expect(chip().classList.contains("hidden")).toBe(true);
});
