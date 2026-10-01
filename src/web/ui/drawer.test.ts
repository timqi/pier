// The status panel's projection, counts and retained row controls; layout and navigation run in the browser fixture.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NOT_IN_LEDGER, type ChainMember } from "../../core/types.js";
import { fake, installPage, type FakeDocument } from "./dom.testkit.js";

const menu = vi.hoisted(() => ({
  panel: null as HTMLElement | null,
  closeMenu: vi.fn(() => { menu.panel?.remove(); document.querySelector("#status-chip")?.setAttribute("aria-expanded", "false"); }),
  openPanel: vi.fn((anchor: HTMLElement, content: HTMLElement) => {
    anchor.setAttribute("aria-expanded", "true");
    const panel = document.createElement("div");
    panel.append(content);
    document.body.append(panel);
    menu.panel = panel;
    return panel;
  }),
  walkRows: vi.fn(() => true),
}));
vi.mock("./menu.js", async (actual) => ({ ...(await actual<typeof import("./menu.js")>()), ...menu }));
const wide = { matches: false, change: () => {}, addEventListener(_: "change", fn: () => void) { this.change = fn; } };
const badge = vi.hoisted(() => vi.fn());
vi.mock("./notifications.js", () => ({ setUnreadBadge: badge }));
const chords = vi.hoisted(() => new Map<string, [() => void, (() => boolean) | undefined]>());
vi.mock("./shortcut.js", () => ({
  chord: (key: string, run: () => void, unless?: () => boolean) => chords.set(key, [run, unless]), modalOpen: () => false,
}));

type Row = import("./drawer.js").SessionInfo;
const row = (id: string, over: Partial<Row> = {}): Row =>
  ({ id, cwd: `/${id}`, title: id, createdAt: 0, state: "idle", unread: false, channel: "web", activeRuns: 0, ...over });
const member = (sessionId: string): ChainMember => ({ sessionId, startedAt: 1, reason: "idle" });
const run = (runId: string, over: Partial<import("../../tasks/types.js").OpenRun> = {}) =>
  ({ runId, name: runId, state: "running", targetSessionId: `s-${runId}`, cwd: null, queuedAt: 0, finishedAt: null, ...over });
let doc: FakeDocument;
let drawer: typeof import("./drawer.js");
let sessions: Row[] = [];
let chain: ChainMember[] = [];
let current: string | null = null;
let open: import("../../tasks/types.js").OpenItems | null = null;
const select = vi.fn();
const openItem = vi.fn();
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); chords.clear();
  doc = installPage(); wide.matches = false;
  vi.stubGlobal("window", { matchMedia: () => wide });
  drawer = await import("./drawer.js");
  sessions = []; chain = []; current = null; open = null;
  drawer.initDrawer({ sessions: () => sessions, currentId: () => current, select, chain: () => chain,
    openContinuous: vi.fn(), open: () => open, openItem });
});
afterEach(() => vi.restoreAllMocks());
const chip = () => doc.querySelector("#status-chip")!;
const panelRows = () => doc.querySelectorAll(".session-open");
const labels = () => panelRows().map((b) => b.querySelector(".open-item-title")!.textContent);
const item = (key: string) => doc.querySelector(`[data-row-key='${key}']`)!;

it("keeps independent session marks and phase tags", () => {
  const dot = (over: Partial<Row>) => fake(drawer.stateDot(row("x", over))[0] ?? null as never);
  expect(drawer.stateDot(row("x"))).toEqual([]);
  expect(dot({ state: "streaming" }).className).toContain("bg-green-500");
  expect(dot({ unread: true }).className).toContain("bg-amber-500");
  expect(dot({ activeRuns: 2 }).title).toBe("2 subagents running");
  expect(drawer.stateDot(row("x", { phase: "design" }))).toEqual([]);
  expect(dot({ phase: "design", runLive: true }).title).toBe("lead — run queued");
  expect(dot({ phase: "design", designOpen: true }).title).toBe("design — waiting for you to finalize");
  expect(drawer.phaseTag(row("x"))).toEqual([]);
  expect(fake(drawer.phaseTag(row("x", { phase: "build" }))[0]).title).toBe("lead — building per the design");
});

it("counts running and needs-you, omits zero halves, and keeps a chip for other open states", () => {
  drawer.renderDrawer(); drawer.openDrawer();
  expect(chip().classList.contains("hidden")).toBe(true);
  expect(menu.openPanel).not.toHaveBeenCalled();
  expect(badge).toHaveBeenLastCalledWith(0);
  sessions = [row("run", { state: "streaming" }), row("q", { runLive: true }), row("idle")];
  drawer.renderDrawer(); expect(chip().textContent).toBe("1 running");
  sessions = [row("done", { unread: true }), row("design", { designOpen: true })];
  drawer.renderDrawer(); expect(chip().textContent).toBe("2 needs you");
  expect(badge).toHaveBeenLastCalledWith(2);
  sessions.push(row("run", { state: "streaming" }));
  drawer.renderDrawer(); expect(chip().textContent).toBe("1 running · 2 needs you");
  sessions = [];
  for (const status of ["pending release", "stopped"] as const) {
    open = { items: [{ problem: "a", stage: "", runs: [], status }], unlisted: [] };
    drawer.renderDrawer(); expect(chip().textContent).toBe("1 open");
  }
  open = { items: [], unlisted: [run("q", { state: "queued" })] };
  drawer.renderDrawer(); expect(chip().textContent).toBe("1 open");
  drawer.openDrawer(); expect(panelRows()).toHaveLength(1);
  open = { items: [], unlisted: [] }; drawer.renderDrawer();
  expect(chip().classList.contains("hidden")).toBe(true);
  expect(menu.closeMenu).toHaveBeenCalledOnce();
});

it("leaves the chain off the list and counts the head's unread on the app badge", () => {
  chain = [member("h1"), member("h0")];
  sessions = [row("h1", { unread: true }), row("h0", { state: "streaming" }), row("c", { unread: true })];
  drawer.renderDrawer(); expect(chip().textContent).toBe("1 needs you");
  expect(badge).toHaveBeenLastCalledWith(2);
  expect(drawer.inProgress(sessions, chain).map((s) => s.id)).toEqual(["c"]);
});

it("uses one flat list, short titles, visible questions and metadata, with complete details", async () => {
  const { topicColour } = await import("./topics.js");
  vi.spyOn(Date, "now").mockReturnValue(10 * 60_000);
  sessions = [row("s-lead", { state: "streaming" }), row("free", { unread: true }), row("queued", { phase: "build", runLive: true })];
  open = { items: [
    { problem: "原始完整问题", title: "稳定标题", stage: "waiting on you: 是否合并？授权只限本分支。", status: "waiting on you", runs: [run("lead", { state: "succeeded", finishedAt: 0 })] },
    { problem: "merged", stage: "restart pending", status: "pending release", runs: [] },
    { problem: "gone", stage: "", status: "stopped", runs: [run("missing", { state: NOT_IN_LEDGER, targetSessionId: null })] },
    { problem: "auth", stage: "实现中", status: "running", runs: [run("work", { name: "auth review", queuedAt: 5 * 60_000 })] },
  ], unlisted: [run("q", { name: "Queued one", state: "queued", targetSessionId: null })] };
  drawer.renderDrawer(); drawer.openDrawer();
  expect(labels()).toEqual(["稳定标题", "free", "merged", "gone", "auth review", "Queued one", "queued"]);
  expect(chip().textContent).toBe("1 running · 2 needs you");
  expect(item("item:原始完整问题").querySelector(".open-item-stage")!.textContent).toBe("Needs you · 是否合并？授权只限本分支。");
  expect(item("item:auth").querySelector(".open-item-meta")!.textContent).toBe("elapsed 5m");
  expect(item("item:gone").textContent).toContain(NOT_IN_LEDGER);
  expect(doc.querySelectorAll(".row-status")).toHaveLength(0);
  const dot = (key: string) => item(key).querySelector(".open-item-dot")!;
  expect(dot("item:auth").style.background).toBe(topicColour("auth"));
  expect(dot("item:auth").classList.contains("animate-pulse")).toBe(true);
  expect(dot("item:原始完整问题").classList.contains("animate-pulse")).toBe(false);
  expect(dot("run:q").style.background).toBe("var(--color-neutral-400)");
  expect(dot("run:q").classList.contains("animate-pulse")).toBe(false);
  expect(item("session:free").querySelector(".open-item-stage")!.textContent).toBe("Needs you · turn finished — not viewed yet");
  const detail = item("item:原始完整问题").querySelector(".open-item-toggle")!;
  detail.onclick?.();
  expect(detail.getAttribute("aria-expanded")).toBe("true");
  expect(item("item:原始完整问题").textContent).toContain("原始完整问题");
  expect(openItem).not.toHaveBeenCalled();
  item("item:原始完整问题").querySelectorAll(".open-item-link").find((b) => !b.classList.contains("hidden"))!.onclick?.();
  expect(select).toHaveBeenCalledWith("s-lead");
  expect(menu.closeMenu).toHaveBeenCalled();
});

it("keeps controls, focus and expansion on problem identity across title and state refreshes", () => {
  wide.matches = true;
  open = { items: [
    { problem: "first", title: "short", stage: "", status: "running", runs: [run("r")] },
    { problem: "second", title: "short", stage: "", status: "running", runs: [run("r")] },
  ], unlisted: [] };
  drawer.renderDrawer();
  const second = item("item:second");
  const control = second.querySelector(".open-item-toggle")!;
  control.onclick?.(); control.focus();
  open.items[1] = { ...open.items[1]!, stage: "new phase", runs: [run("r2", { name: "a long steering prompt", targetSessionId: "s-r" })] };
  drawer.renderDrawer();
  expect(item("item:second")).toBe(second);
  expect(doc.activeElement).toBe(control);
  expect(control.getAttribute("aria-expanded")).toBe("true");
  expect(second.querySelector(".open-item-title")!.textContent).toBe("short");
  second.querySelector(".session-open")!.onclick?.();
  expect(openItem).toHaveBeenLastCalledWith(expect.objectContaining({ problem: "second", runs: [{ runId: "r2", targetSessionId: "s-r" }] }));
  expect(second.querySelector(".session-open")!.getAttribute("aria-current")).toBeNull();
});

it.each([false, true])("retains same-named designs and a matching marker on refresh, expansion and navigation (docked: %s)", (docked) => {
  wide.matches = docked;
  const name = "Same design name";
  open = { items: ["held", "first", "second"].map((id) => ({
    ...(id === "held" ? {} : { key: `design:${id}` }),
    problem: name, title: name, stage: "", status: "waiting on you", designSessionId: id,
    runs: [run(`root-${id}`, { name, state: "succeeded", targetSessionId: id })],
  })), unlisted: [] };
  drawer.renderDrawer(); drawer.openDrawer();
  expect(chip().textContent).toBe("3 needs you");
  expect(labels()).toEqual([name, name, name]);
  const first = item("design:first");
  const control = first.querySelector(".open-item-toggle")!;
  control.onclick?.(); control.focus();
  expect(openItem).not.toHaveBeenCalled();
  open.items[1] = { ...open.items[1]!, runs: [run("followup", { name: "New steering title", state: "succeeded", targetSessionId: "first" })] };
  open.items.reverse();
  drawer.renderDrawer();
  expect(labels()).toEqual([name, name, name]);
  expect(item("design:first")).toBe(first);
  expect(doc.activeElement).toBe(control);
  expect(control.getAttribute("aria-expanded")).toBe("true");
  expect(first.textContent).toContain("New steering title");
  expect(first.textContent).not.toContain("root-first");
  for (const id of ["first", "second", "held"]) {
    if (id !== "first") drawer.openDrawer();
    const node = item(id === "held" ? `item:${name}` : `design:${id}`);
    const toggle = node.querySelector(".open-item-toggle")!;
    if (id !== "first") {
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      toggle.onclick?.();
    }
    node.querySelectorAll(".open-item-link").find((b) => !b.classList.contains("hidden"))!.onclick?.();
    expect(select).toHaveBeenLastCalledWith(id);
    drawer.openDrawer();
    node.querySelector(".session-open")!.onclick?.();
    expect(openItem).toHaveBeenLastCalledWith(expect.objectContaining({ problem: name, designSessionId: id,
      runs: [{ runId: id === "first" ? "followup" : `root-${id}`, targetSessionId: id }] }));
  }
});

it("forwards design and waiting entrances without inferring a current session from a shared run", () => {
  current = "design";
  open = { items: [{ problem: "d", stage: "", status: "running", designSessionId: "design", waitsIn: "answer", runs: [run("first")] }], unlisted: [] };
  drawer.renderDrawer(); drawer.openDrawer();
  const button = panelRows()[0]!;
  button.onclick?.();
  expect(openItem).toHaveBeenCalledWith(expect.objectContaining({ designSessionId: "design", waitsIn: "answer" }));
  expect(button.getAttribute("aria-current")).toBe("page");
  expect(chip().textContent).toBe("1 running");
});

it("moves the same rows between popover and dock, returning focus to the chip on narrowing", () => {
  current = "b";
  sessions = [row("a", { state: "streaming" }), row("b", { unread: true })];
  drawer.renderDrawer(); chip().onclick?.();
  expect(labels()).toEqual(["b", "a"]);
  expect(panelRows().map((b) => b.getAttribute("aria-current"))).toEqual(["page", null]);
  chords.get("shift+p")![0](); expect(menu.closeMenu).toHaveBeenCalledOnce();
  expect(chords.get("shift+p")![1]).toBeTypeOf("function");
  wide.matches = true; wide.change();
  const side = doc.querySelector("#status-side")!;
  expect(side.querySelectorAll(".session-open")).toHaveLength(2);
  expect(doc.querySelector("#status-side-head")!.textContent).toBe("1 running · 1 needs you");
  drawer.openDrawer(); expect(doc.activeElement).toBe(panelRows()[0]);
  const preventDefault = vi.fn();
  doc.querySelector("#status-side-list")!.onkeydown?.({ key: "ArrowDown", preventDefault } as never);
  expect(preventDefault).toHaveBeenCalled();
  expect(menu.walkRows).toHaveBeenLastCalledWith(doc.querySelector("#status-side-list"), 1);
  wide.matches = false; wide.change(); expect(doc.activeElement).toBe(chip());
  drawer.openDrawer();
  expect(side.querySelectorAll(".session-open")).toHaveLength(0);
  expect(menu.openPanel).toHaveBeenCalledTimes(2);
  panelRows()[1]!.onclick?.();
  expect(openItem).toHaveBeenCalledWith(expect.objectContaining({ direct: true, runs: [{ runId: "a", targetSessionId: "a" }] }));
});
