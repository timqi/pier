// The status panel's projection, the bar's lead item and retained row controls; layout and navigation run in the browser fixture.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NOT_IN_LEDGER, type ChainMember } from "../../core/types.js";
import { fake, installPage, type FakeDocument } from "./dom.testkit.js";

const menu = vi.hoisted(() => ({
  panel: null as HTMLElement | null,
  closeMenu: vi.fn(() => { menu.panel?.remove(); document.querySelector("#status-item")?.removeAttribute("aria-expanded"); }),
  openPanel: vi.fn((anchor: HTMLElement, content: HTMLElement) => {
    anchor.setAttribute("aria-expanded", "true");
    const panel = document.createElement("div");
    panel.append(content);
    document.body.append(panel);
    menu.panel = panel;
    return panel;
  }),
}));
vi.mock("./menu.js", async (actual) => ({ ...(await actual<typeof import("./menu.js")>()), ...menu }));
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
const openItem = vi.fn();
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); chords.clear();
  doc = installPage();
  drawer = await import("./drawer.js");
  sessions = []; chain = []; current = null; open = null;
  drawer.initDrawer({ sessions: () => sessions, currentId: () => current, chain: () => chain,
    openContinuous: vi.fn(), open: () => open, openItem });
});
afterEach(() => vi.restoreAllMocks());
const lead = () => doc.querySelector("#status-item")!;
const next = () => doc.querySelector("#status-next")!;
const shown = (sel: string) => doc.querySelector(sel)!.textContent;
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
  expect(drawer.phaseTag(row("x"))).toEqual([]);
  expect(fake(drawer.phaseTag(row("x", { phase: "build" }))[0]).title).toBe("lead — building per the design");
});

it("leads with the most urgent row, cycles with the counter, and is absent with no rows", () => {
  drawer.renderDrawer(); drawer.openDrawer();
  expect(lead().classList.contains("hidden")).toBe(true);
  expect(next().classList.contains("hidden")).toBe(true);
  expect(menu.openPanel).not.toHaveBeenCalled();
  expect(badge).toHaveBeenLastCalledWith(0);
  sessions = [row("run", { state: "streaming" }), row("q", { runLive: true }), row("idle")];
  drawer.renderDrawer();
  expect(lead().classList.contains("hidden")).toBe(false);
  expect(shown("#status-item-title")).toBe("run");
  expect(shown("#status-item-count")).toBe("2");
  expect(next().textContent).toBe("1/2");
  sessions = [row("run", { state: "streaming" }), row("done", { unread: true }), row("design", { phase: "design", unread: true })];
  drawer.renderDrawer();
  expect(badge).toHaveBeenLastCalledWith(2);
  expect(shown("#status-item-title")).toBe("done");
  expect(shown("#status-item-state")).toBe("waiting on you");
  expect(doc.querySelector("#status-item-state")!.className).toContain("text-amber-700");
  expect(shown("#status-item-stage")).toBe("turn finished — not viewed yet");
  expect(lead().title).toBe("done — waiting on you · turn finished — not viewed yet");
  expect(next().textContent).toBe("1/3");
  next().onclick?.(); next().onclick?.();
  expect([shown("#status-item-title"), next().textContent]).toEqual(["run", "3/3"]);
  // A refresh keeps the cycled row; the counter wraps.
  drawer.renderDrawer(); expect(next().textContent).toBe("3/3");
  next().onclick?.(); expect([shown("#status-item-title"), next().textContent]).toEqual(["done", "1/3"]);
  next().onclick?.();
  // A new most urgent row takes the lead back.
  sessions.unshift(row("new", { unread: true }));
  drawer.renderDrawer(); expect([shown("#status-item-title"), next().textContent]).toEqual(["new", "1/4"]);
  sessions = [];
  doc.querySelector("#status-item-state")!.classList.add("text-[12px]"); // index.html's size
  open = { items: [{ problem: "a", stage: "", runs: [], status: "stopped" }], unlisted: [] };
  drawer.renderDrawer();
  expect([shown("#status-item-state"), shown("#status-item-stage")]).toEqual(["failed", ""]);
  expect(doc.querySelector("#status-item-state")!.className).toContain("text-red-600");
  expect(doc.querySelector("#status-item-state")!.className).toContain("text-[12px]");
  expect(doc.querySelector("#status-item-state")!.className).not.toContain("text-amber-700");
  expect(next().classList.contains("hidden")).toBe(true);
  lead().onclick?.(); expect(panelRows()).toHaveLength(1);
  expect(menu.openPanel).toHaveBeenLastCalledWith(lead(), expect.anything());
  lead().onclick?.(); expect(menu.closeMenu).toHaveBeenCalledOnce();
  drawer.openDrawer();
  open = { items: [], unlisted: [] }; drawer.renderDrawer();
  expect(lead().classList.contains("hidden")).toBe(true);
  expect(menu.closeMenu).toHaveBeenCalledTimes(2);
});

it("leaves the chain off the list and counts the head's unread on the app badge", () => {
  chain = [member("h1"), member("h0")];
  sessions = [row("h1", { unread: true }), row("h0", { state: "streaming" }), row("c", { unread: true })];
  drawer.renderDrawer(); expect(shown("#status-item-title")).toBe("c");
  expect(shown("#status-item-count")).toBe("1");
  expect(badge).toHaveBeenLastCalledWith(2);
  expect(drawer.inProgress(sessions, chain).map((s) => s.id)).toEqual(["c"]);
});

it("uses one flat list, short titles, visible questions and metadata, one control a row with the full wording as its tooltip", async () => {
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
  expect([shown("#status-item-title"), next().textContent]).toEqual(["稳定标题", "1/7"]);
  // The question's first clause beside the status; the wait and the rest are the tooltip's.
  const status = (key: string) => item(key).querySelector(".open-item-status")!;
  const phrase = (key: string) => item(key).querySelector(".open-item-phrase")!.textContent;
  expect([status("item:原始完整问题").textContent, phrase("item:原始完整问题")]).toEqual(["waiting on you", "是否合并？"]);
  expect(status("item:原始完整问题").className).toContain("text-amber-700");
  expect([status("item:auth").textContent, phrase("item:auth")]).toEqual(["in progress", "实现中"]);
  expect(status("item:auth").className).toContain("text-sky-700");
  expect(status("item:auth").querySelector(".running-dot")).not.toBeNull();
  expect([status("item:gone").textContent, status("item:merged").textContent, status("run:q").textContent]).toEqual(["failed", "pending release", "queued"]);
  expect(status("item:gone").className).toContain("text-red-600");
  expect(item("item:原始完整问题").querySelector(".open-item-meta")!.classList.contains("hidden")).toBe(true);
  expect(item("item:auth").querySelector(".open-item-meta")!.textContent).toBe("elapsed 5m");
  expect(item("item:gone").textContent).toContain(NOT_IN_LEDGER);
  expect(doc.querySelectorAll(".row-status")).toHaveLength(0);
  const dot = (key: string) => item(key).querySelector(".open-item-dot")!;
  expect(dot("item:auth").style.background).toBe(topicColour("auth"));
  expect(dot("run:q").style.background).toBe("var(--color-neutral-400)");
  expect([status("session:free").textContent, phrase("session:free")]).toEqual(["waiting on you", "turn finished — not viewed yet"]);
  expect(doc.querySelectorAll(".open-item").every((li) => li.querySelectorAll("button").length === 1)).toBe(true);
  expect(item("item:原始完整问题").querySelector(".session-open")!.title).toBe("原始完整问题\nwaiting on you · 10m · 是否合并？授权只限本分支。");
  expect(item("item:auth").querySelector(".session-open")!.title).toBe("auth");
  expect(item("item:merged").querySelector(".session-open")!.hasAttribute("title")).toBe(false);
  item("item:原始完整问题").querySelector(".session-open")!.onclick?.();
  expect(openItem).toHaveBeenCalledWith(expect.objectContaining({ problem: "原始完整问题" }));
  expect(menu.closeMenu).toHaveBeenCalled();
});

it("keeps controls and focus on problem identity across title and state refreshes", () => {
  open = { items: [
    { problem: "first", title: "short", stage: "", status: "running", runs: [run("r")] },
    { problem: "second", title: "short", stage: "", status: "running", runs: [run("r")] },
  ], unlisted: [] };
  drawer.renderDrawer(); drawer.openDrawer();
  const second = item("item:second");
  const control = second.querySelector(".session-open")!;
  control.focus();
  open.items[1] = { ...open.items[1]!, stage: "new phase", runs: [run("r2", { name: "a long steering prompt", targetSessionId: "s-r" })] };
  drawer.renderDrawer();
  expect(item("item:second")).toBe(second);
  expect(doc.activeElement).toBe(control);
  expect(second.querySelector(".open-item-title")!.textContent).toBe("short");
  second.querySelector(".session-open")!.onclick?.();
  expect(openItem).toHaveBeenLastCalledWith(expect.objectContaining({ problem: "second", runs: [{ runId: "r2", targetSessionId: "s-r" }] }));
  expect(second.querySelector(".session-open")!.getAttribute("aria-current")).toBeNull();
});

it("retains same-titled designs on refresh, focus and navigation", () => {
  const name = "Same design name";
  open = { items: ["held", "first", "second"].map((id) => ({
    problem: id, title: name, stage: "", status: "waiting on you", designSessionId: id,
    runs: [run(`root-${id}`, { name, state: "succeeded", targetSessionId: id })],
  })), unlisted: [] };
  drawer.renderDrawer(); drawer.openDrawer();
  expect(next().textContent).toBe("1/3");
  expect(labels()).toEqual([name, name, name]);
  const first = item("item:first");
  const control = first.querySelector(".session-open")!;
  control.focus();
  open.items[1] = { ...open.items[1]!, runs: [run("followup", { name: "New steering title", state: "succeeded", targetSessionId: "first" })] };
  open.items.reverse();
  drawer.renderDrawer();
  expect(labels()).toEqual([name, name, name]);
  expect(item("item:first")).toBe(first);
  expect(doc.activeElement).toBe(control);
  for (const id of ["first", "second", "held"]) {
    if (id !== "first") drawer.openDrawer();
    const node = item(`item:${id}`);
    node.querySelector(".session-open")!.onclick?.();
    expect(openItem).toHaveBeenLastCalledWith(expect.objectContaining({ problem: id, designSessionId: id,
      runs: [{ runId: id === "first" ? "followup" : `root-${id}`, targetSessionId: id }] }));
  }
});

it("says where a design's wait is answered: the phrase when nothing else is, the tooltip always", () => {
  vi.spyOn(Date, "now").mockReturnValue(2 * 3_600_000);
  open = { items: [
    { problem: "rail", stage: "two layouts", status: "waiting on you", designSessionId: "d", waitsIn: "d", runs: [run("r", { state: "succeeded", finishedAt: 0, targetSessionId: "d" })] },
    { problem: "bare", stage: "", status: "waiting on you", designSessionId: "e", waitsIn: "e", runs: [run("q", { state: "succeeded", finishedAt: 0, targetSessionId: "e" })] },
  ], unlisted: [] };
  drawer.renderDrawer(); drawer.openDrawer();
  const phrase = (key: string) => item(key).querySelector(".open-item-phrase")!.textContent;
  expect(phrase("item:rail")).toBe("two layouts");
  expect(phrase("item:bare")).toBe("in the design session");
  expect(item("item:rail").querySelector(".session-open")!.title).toBe("rail\nwaiting on you · in the design session · 2h · two layouts");
});

it("forwards design and waiting entrances without inferring a current session from a shared run", () => {
  current = "design";
  open = { items: [{ problem: "d", stage: "", status: "running", designSessionId: "design", waitsIn: "answer", runs: [run("first")] }], unlisted: [] };
  drawer.renderDrawer(); drawer.openDrawer();
  const button = panelRows()[0]!;
  button.onclick?.();
  expect(openItem).toHaveBeenCalledWith(expect.objectContaining({ designSessionId: "design", waitsIn: "answer" }));
  expect(button.getAttribute("aria-current")).toBe("page");
  expect(shown("#status-item-title")).toBe("first");
});

it("marks a row current where its click lands: the newest run's session, never a run of an item answered in the chat", () => {
  current = "s-new";
  open = { items: [
    { problem: "work", stage: "", status: "running", runs: [run("old", { queuedAt: 1, targetSessionId: "s-old" }), run("new", { queuedAt: 2 })] },
    { problem: "ask", stage: "waiting on you: which?", status: "waiting on you", runs: [run("new", { queuedAt: 2, state: "succeeded" })] },
  ], unlisted: [] };
  drawer.renderDrawer(); drawer.openDrawer();
  expect(item("item:work").querySelector(".session-open")!.getAttribute("aria-current")).toBe("page");
  expect(item("item:ask").querySelector(".session-open")!.getAttribute("aria-current")).toBeNull();
});

it("opens the panel from the lead and ⌘⇧P, closing on a second press", () => {
  current = "b";
  sessions = [row("a", { state: "streaming" }), row("b", { unread: true })];
  drawer.renderDrawer(); lead().onclick?.();
  expect(labels()).toEqual(["b", "a"]);
  expect(panelRows().map((b) => b.getAttribute("aria-current"))).toEqual(["page", null]);
  chords.get("shift+p")![0](); expect(menu.closeMenu).toHaveBeenCalledOnce();
  expect(chords.get("shift+p")![1]).toBeTypeOf("function");
  chords.get("shift+p")![0](); expect(menu.openPanel).toHaveBeenCalledTimes(2);
  panelRows()[1]!.onclick?.();
  expect(openItem).toHaveBeenCalledWith(expect.objectContaining({ direct: true, runs: [{ runId: "a", targetSessionId: "a" }] }));
});


it("trims a stage to its first clause, a question keeping its mark, never inside a version or a file name", async () => {
  const { stagePhrase } = await import("./open-items.js");
  const { openItemPresentation } = await import("../../core/open-items.js");
  const phrase = (stage: string, status: "running" | "waiting on you" = "running") =>
    stagePhrase(openItemPresentation({ problem: "p", stage, status, runs: [] }, 0));
  expect(phrase("waiting on you: merge chat-layout? review clean after round 2", "waiting on you")).toBe("merge chat-layout?");
  expect(phrase("Cobo 按策略拒签 input #0，需把 0x21 哈希发 Cobo 加白后重提")).toBe("Cobo 按策略拒签 input #0");
  expect(phrase("release v0.4.20 from main.ts. Then tag it")).toBe("release v0.4.20 from main.ts");
  expect(phrase("开发中：待办状态化、间距统一")).toBe("开发中：待办状态化、间距统一");
  expect(phrase("")).toBe("");
});
