// The In progress drawer on index.html: its order and marks, the status chip's
// counts, and the panel the chip opens.
import { beforeEach, expect, it, vi } from "vitest";
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
const select = vi.fn();

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  chords.clear();
  doc = installPage();
  drawer = await import("./drawer.js");
  sessions = [];
  chain = [];
  current = null;
  drawer.initDrawer({ sessions: () => sessions, currentId: () => current, select, chain: () => chain, openContinuous: vi.fn(), open: () => null });
});

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

it("does not open with nothing to list, and closes when its rows run out", () => {
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
