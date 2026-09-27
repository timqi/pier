// The status panel on index.html: its order and marks, the status chip's
// counts, and the panel the chip opens — the rows over `/status`'s card.
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
const select = vi.fn();
/** `/status`'s answers, in order; an empty queue answers "Nothing open.". */
let answers: Response[] = [];
const fetch = vi.fn(async () => answers.shift() ?? Response.json({ text: "Nothing open.", sessions: {} }));

beforeEach(async () => {
  answers = [];
  vi.stubGlobal("fetch", fetch);
  vi.resetModules();
  vi.clearAllMocks();
  chords.clear();
  doc = installPage();
  drawer = await import("./drawer.js");
  sessions = [];
  chain = [];
  current = null;
  open = null;
  drawer.initDrawer({ sessions: () => sessions, currentId: () => current, select, chain: () => chain, openContinuous: vi.fn(), open: () => open });
});
afterEach(() => vi.unstubAllGlobals());

const chip = () => doc.querySelector("#status-chip")!;
const panelRows = () => doc.querySelectorAll(".session-open");

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
  expect(chip().textContent).toBe("2 running");
  expect(chip().classList.contains("hidden")).toBe(false);

  sessions = [row("done", { unread: true }), row("design", { phase: "design", designOpen: true })];
  drawer.renderDrawer();
  expect(chip().textContent).toBe("2 needs you");
  expect(chip().classList.contains("text-amber-700")).toBe(true);
  expect(badge).toHaveBeenLastCalledWith(2);

  sessions = [...sessions, row("run", { state: "streaming" })];
  drawer.renderDrawer();
  expect(chip().textContent).toBe("1 running · 2 needs you");

  // Open items with nothing live: the chip still leads to their stages.
  sessions = [];
  open = { items: [{ problem: "a", stage: "waiting on you", runs: [] }, { problem: "b", stage: "", runs: [] }], unlisted: [], designs: [] };
  drawer.renderDrawer();
  expect(chip().textContent).toBe("2 open");
  expect(chip().classList.contains("text-neutral-600")).toBe(true);
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
  const list = doc.querySelector("[data-list]")!;
  expect(panelRows().map((b) => b.textContent.trim())).toEqual(["b", "a"]);
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
  expect(list.querySelectorAll(".session-open").map((b) => b.textContent.trim())).toEqual(["c", "b", "a"]);
});

it("does not open with nothing to show, and closes when it runs out", () => {
  drawer.renderDrawer();
  drawer.openDrawer();
  expect(menu.openPanel).not.toHaveBeenCalled();

  sessions = [row("a", { state: "streaming" })];
  drawer.renderDrawer();
  drawer.openDrawer();
  sessions = [row("a")];
  drawer.renderDrawer();
  expect(menu.closeMenu).toHaveBeenCalledOnce();
});

// Under the rows, `/status`'s own text in the chat's card: a named run opens
// its session, refetched while open, a failed read said in the card.
it("draws /status's text as its card under the rows and refetches it while open", async () => {
  const text = "Open\n- Bar — building (running) · run r1abcdef… running 1m";
  answers.push(Response.json({ text, sessions: { r1abcdefgh: "s-r1" } }));
  open = { items: [{ problem: "Bar", stage: "building", runs: [] }], unlisted: [], designs: [] };
  drawer.renderDrawer();
  drawer.openDrawer();
  const panel = () => fake(menu.openPanel.mock.lastCall![1]);
  const card = () => panel().querySelectorAll(".system-card");
  // No rows: the In progress head is hidden and the Open items head sits at
  // the top without its gap — the open items are the panel.
  const list = () => panel().querySelector("[data-list]")!;
  expect(list().previousElementSibling!.classList.contains("hidden")).toBe(true);
  expect(list().nextElementSibling!.classList.contains("mt-2")).toBe(false);
  expect(card()).toHaveLength(1);
  expect(card()[0]!.textContent).toBe("Loading…");
  await vi.waitFor(() => expect(card()[0]!.textContent).toBe(text));
  expect(fetch).toHaveBeenLastCalledWith("/api/continuous/status", undefined);
  const link = card()[0]!.querySelectorAll("button").find((b) => b.textContent === "run r1abcdef…")!;
  link.onclick?.();
  expect(menu.closeMenu).toHaveBeenCalled();
  expect(select).toHaveBeenCalledWith("s-r1");

  answers.push(Response.json({ text: "Open\n- Bar — merged", sessions: {} }));
  open = { items: [{ problem: "Bar", stage: "merged", runs: [] }], unlisted: [], designs: [] };
  drawer.renderDrawer();
  await vi.waitFor(() => expect(card()[0]!.textContent).toBe("Open\n- Bar — merged"));

  answers.push(Response.json({ error: "database is locked" }, { status: 500 }));
  sessions = [row("a", { state: "streaming" })];
  drawer.renderDrawer();
  await vi.waitFor(() => expect(card()[0]!.textContent).toBe("database is locked"));
  expect(list().previousElementSibling!.classList.contains("hidden")).toBe(false);
  expect(list().nextElementSibling!.classList.contains("mt-2")).toBe(true);
  expect(panelRows().map((b) => b.textContent.trim())).toEqual(["a"]);
});
