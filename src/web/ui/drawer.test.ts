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
  openMenu: vi.fn(),
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
let chains: import("../types.js").ChainInfo[] = [];
let chainId: string | null = null;
const openItem = vi.fn();
const itemView = vi.fn();
const reopen = vi.fn();
const onWindow = new Map<string, () => void>();
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); chords.clear();
  doc = installPage();
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  onWindow.clear();
  vi.stubGlobal("window", { addEventListener: (name: string, fn: () => void) => onWindow.set(name, fn) });
  drawer = await import("./drawer.js");
  sessions = []; chain = []; current = null; open = null; chains = []; chainId = null;
  drawer.initDrawer({ sessions: () => sessions, currentId: () => current, chain: () => chain,
    chains: () => chains, chainId: () => chainId, openContinuous: vi.fn(), open: () => open, openItem, itemView, reopen });
});
afterEach(() => vi.restoreAllMocks());
const lead = () => doc.querySelector("#status-item")!;
const next = () => doc.querySelector("#status-next")!;
const shown = (sel: string) => doc.querySelector(sel)!.textContent;
/** The panel's own rows: the rail's Items section holds a second copy of each (`railRows` below). */
const panel = () => fake(menu.panel);
const panelRows = () => panel().querySelectorAll(".session-open");
const labels = () => panelRows().map((b) => b.querySelector(".open-item-title")!.textContent);
const item = (key: string) => panel().querySelector(`[data-row-key='${key}']`)!;
const rail = () => doc.querySelector("#rail-items")!;
const railRows = () => rail().querySelectorAll(".open-item-title").map((t) => t.textContent);
/** The sidebar's Sessions section: the rows no item holds, apart from the items. */
const railSessions = () => doc.querySelector("#rail-sessions")!;
const railLoose = () => railSessions().querySelectorAll(".open-item-title").map((t) => t.textContent);

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
  expect(menu.openPanel).toHaveBeenLastCalledWith(lead(), expect.anything(), "Status");
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

it("lists the items, then the rows no item holds under their own head, short titles, visible questions and metadata, one control a row with the full wording as its tooltip", async () => {
  const { topicColour } = await import("./topics.js");
  vi.spyOn(Date, "now").mockReturnValue(10 * 60_000);
  sessions = [row("s-lead", { state: "streaming" }), row("free", { unread: true }), row("queued", { phase: "build", runLive: true })];
  open = { items: [
    { problem: "原始完整问题", title: "稳定标题", stage: "waiting on you: 是否合并？授权只限本分支。", status: "waiting on you", runs: [run("lead", { state: "succeeded", finishedAt: 0 })] },
    { problem: "merged", stage: "restart pending", status: "wrapping up", runs: [] },
    { problem: "gone", stage: "", status: "stopped", runs: [run("missing", { state: NOT_IN_LEDGER, targetSessionId: null })] },
    { problem: "auth", stage: "实现中", status: "running", runs: [run("work", { name: "auth review", queuedAt: 5 * 60_000 })], openedAt: 0, tree: { runs: 7, running: 2, queued: 0 } },
  ], unlisted: [run("q", { name: "Queued one", state: "queued", targetSessionId: null })] };
  drawer.renderDrawer(); drawer.openDrawer();
  // The bar leads with what waits on you, a session's too; the panel and the rail keep the items apart from it.
  expect(labels()).toEqual(["原始完整问题", "merged", "gone", "auth", "free", "Queued one", "queued"]);
  expect([shown("#status-item-title"), next().textContent]).toEqual(["原始完整问题", "1/7"]);
  const panelList = panel().querySelector("[data-list]")!;
  expect(panelList.children.map((li) => li.dataset.rowKey ?? li.textContent)).toEqual(
    ["item:原始完整问题", "item:merged", "item:gone", "item:auth", "Sessions", "session:free", "run:q", "session:queued"]);
  expect([shown("#rail-items-head"), shown("#rail-sessions-head")]).toEqual(["Items \u00b7 4", "Sessions \u00b7 3"]);
  expect(railRows()).toEqual(["原始完整问题", "merged", "gone", "auth"]);
  expect(railLoose()).toEqual(["free", "Queued one", "queued"]);
  // An item is titled by its problem, its topic tags' name; the runs' name is the tooltip's.
  expect(lead().title).toBe("原始完整问题 (稳定标题) — waiting on you · 10m · 是否合并？授权只限本分支。");
  // The question's first clause beside the status; the wait and the rest are the tooltip's.
  const status = (key: string) => item(key).querySelector(".open-item-status")!;
  const phrase = (key: string) => item(key).querySelector(".open-item-phrase")!.textContent;
  expect([status("item:原始完整问题").textContent, phrase("item:原始完整问题")]).toEqual(["waiting on you", "是否合并？"]);
  expect(status("item:原始完整问题").className).toContain("text-amber-700");
  expect([status("item:auth").textContent, phrase("item:auth")]).toEqual(["in progress", "实现中"]);
  expect(status("item:auth").className).toContain("text-sky-700");
  expect(status("item:auth").querySelector(".running-dot")).not.toBeNull();
  expect([status("item:gone").textContent, status("item:merged").textContent, status("run:q").textContent]).toEqual(["failed", "wrapping up", "queued"]);
  expect(status("item:gone").className).toContain("text-red-600");
  expect(item("item:原始完整问题").querySelector(".open-item-meta")!.classList.contains("hidden")).toBe(true);
  expect(item("item:auth").querySelector(".open-item-meta")!.textContent).toBe("elapsed 5m");
  // The stage line keeps only its running count, outside the metadata the sidebar hides; the age and the
  // whole run tree are the tooltip's, and a row with no tree counted has neither.
  const tree = item("item:auth").querySelector(".open-item-stage")!.querySelector(".open-item-tree")!;
  expect(tree.textContent).toBe("2 running");
  expect(item("item:auth").querySelector(".open-item-age")).toBeNull();
  expect(item("item:auth").querySelector("button")!.getAttribute("aria-label")).toContain("2 running");
  expect(item("item:gone").querySelector(".open-item-tree")!.classList.contains("hidden")).toBe(true);
  expect(item("item:gone").textContent).toContain(NOT_IN_LEDGER);
  expect(panel().querySelectorAll(".row-status")).toHaveLength(0);
  const dot = (key: string) => item(key).querySelector(".open-item-dot")!;
  expect(dot("item:auth").style.background).toBe(topicColour("auth"));
  expect(dot("run:q").style.background).toBe("var(--color-neutral-400)");
  expect([status("session:free").textContent, phrase("session:free")]).toEqual(["waiting on you", "turn finished — not viewed yet"]);
  // An item's row has its menu's ⋯ beside the row's one control; a run's or a session's has nothing else.
  expect(panel().querySelectorAll(".open-item").map((li) => li.querySelectorAll("button").length)).toEqual([2, 2, 2, 2, 1, 1, 1]);
  expect(item("item:原始完整问题").querySelector(".session-open")!.title).toBe("稳定标题\nwaiting on you · 10m · 是否合并？授权只限本分支。");
  expect(item("item:auth").querySelector(".session-open")!.title).toBe("auth review\nopen 10m \u00b7 7 runs behind this item, 2 running \u2014 its own and the ones they launched\nOpens its session");
  expect(item("item:merged").querySelector(".session-open")!.hasAttribute("title")).toBe(false);
  item("item:原始完整问题").querySelector(".session-open")!.onclick?.();
  expect(openItem).toHaveBeenCalledWith(expect.objectContaining({ problem: "原始完整问题" }), undefined);
  expect(menu.closeMenu).toHaveBeenCalled();
  drawer.openDrawer();
  expect(item("item:auth").querySelector(".item-more")!.getAttribute("aria-label")).toBe("Actions for auth");
  choose(item("item:auth"), "Item view");
  expect(itemView).toHaveBeenCalledWith("auth", undefined);
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
  expect(second.querySelector(".open-item-title")!.textContent).toBe("second");
  second.querySelector(".session-open")!.onclick?.();
  expect(openItem).toHaveBeenLastCalledWith(expect.objectContaining({ problem: "second", runs: [{ runId: "r2", targetSessionId: "s-r" }] }), undefined);
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
  expect(labels()).toEqual(["held", "first", "second"]);
  const first = item("item:first");
  const control = first.querySelector(".session-open")!;
  control.focus();
  open.items[1] = { ...open.items[1]!, runs: [run("followup", { name: "New steering title", state: "succeeded", targetSessionId: "first" })] };
  open.items.reverse();
  drawer.renderDrawer();
  expect(labels()).toEqual(["second", "first", "held"]);
  expect(item("item:first")).toBe(first);
  expect(doc.activeElement).toBe(control);
  for (const id of ["first", "second", "held"]) {
    if (id !== "first") drawer.openDrawer();
    const node = item(`item:${id}`);
    node.querySelector(".session-open")!.onclick?.();
    expect(openItem).toHaveBeenLastCalledWith(expect.objectContaining({ problem: id, designSessionId: id,
      runs: [{ runId: id === "first" ? "followup" : `root-${id}`, targetSessionId: id }] }), undefined);
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
  expect(item("item:rail").querySelector(".session-open")!.title).toBe("r\nwaiting on you · in the design session · 2h · two layouts\nOpens its session");
});

it("forwards design and waiting entrances without inferring a current session from a shared run", () => {
  current = "design";
  open = { items: [{ problem: "d", stage: "", status: "running", designSessionId: "design", waitsIn: "answer", runs: [run("first")] }], unlisted: [] };
  drawer.renderDrawer(); drawer.openDrawer();
  const button = panelRows()[0]!;
  button.onclick?.();
  expect(openItem).toHaveBeenCalledWith(expect.objectContaining({ designSessionId: "design", waitsIn: "answer" }), undefined);
  expect(button.getAttribute("aria-current")).toBe("page");
  expect(shown("#status-item-title")).toBe("d");
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

// A row whose click leaves the conversation for a session says so in its label and tooltip; no glyph, so the row's width never changes.
it("marks a row whose click opens a session, never one answered in the chat, run-less or already shown", () => {
  current = "s-here";
  open = { items: [
    { problem: "work", stage: "", status: "running", runs: [run("w")] },
    { problem: "ask", stage: "waiting on you: which?", status: "waiting on you", runs: [run("a", { state: "succeeded" })] },
    { problem: "bare", stage: "", status: "wrapping up", runs: [] },
    { problem: "here", stage: "", status: "running", runs: [run("h", { targetSessionId: "s-here" })] },
  ], unlisted: [] };
  sessions = [row("solo", { state: "streaming" })];
  drawer.renderDrawer(); drawer.openDrawer();
  const away = (key: string) => item(key).querySelector(".session-open")!.getAttribute("aria-label")!.endsWith("opens its session");
  expect(["item:work", "item:ask", "item:bare", "item:here", "session:solo"].map(away)).toEqual([true, false, false, false, true]);
  const main = item("item:work").querySelector(".session-open")!;
  expect(main.getAttribute("aria-label")).toBe("work · in progress · opens its session");
  expect(main.title).toBe("w\nOpens its session");
  expect(item("item:ask").querySelector(".session-open")!.getAttribute("aria-label")).toBe("ask · waiting on you");
  main.onclick?.();
  expect(openItem).toHaveBeenCalledWith(expect.objectContaining({ problem: "work" }), undefined);
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
  expect(openItem).toHaveBeenCalledWith(expect.objectContaining({ direct: true, runs: [{ runId: "a", targetSessionId: "a" }] }), undefined);
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

// The panel's search: open matches are their panel rows, closed ones a group whose click opens the view.
it("searches every item as the user types, closed ones under Closed with their age", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(10 * 60 * 60_000);
  const asked: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    asked.push(url);
    return { ok: true, json: async () => ({ items: [
      { problem: "auth", aliases: [], updatedAt: 1 },
      { problem: "auth v1", aliases: ["old auth"], closedAt: 7 * 60 * 60_000, updatedAt: 1 },
    ] }) };
  }));
  open = { items: [{ problem: "auth", stage: "", status: "running", runs: [] }, { problem: "deploy", stage: "", status: "running", runs: [] }], unlisted: [] };
  drawer.renderDrawer(); drawer.openDrawer();
  const field = doc.querySelector("input[type='search']")!;
  expect(field.getAttribute("aria-label")).toBe("Search items");
  field.value = "au";
  field.oninput?.(new Event("input"));
  field.value = "auth";
  field.oninput?.(new Event("input"));
  await vi.advanceTimersByTimeAsync(300);
  expect(asked).toEqual(["/api/continuous/items?q=auth"]);
  const list = panel().querySelector("[data-list]")!;
  expect(list.children.map((li) => li.textContent)).toEqual([expect.stringContaining("auth"), "Closed", "auth v1closed 3h ago"]);
  expect(list.children[0]).toBe(item("item:auth"));
  item("closed:auth v1").querySelector(".session-open")!.onclick?.();
  expect(itemView).toHaveBeenCalledWith("auth v1", undefined);
  expect(menu.closeMenu).toHaveBeenCalled();
  // An emptied field gives the panel its own rows back.
  drawer.openDrawer();
  const again = doc.querySelector("input[type='search']")!;
  again.value = "zzz";
  again.oninput?.(new Event("input"));
  again.value = "";
  again.oninput?.(new Event("input"));
  await vi.advanceTimersByTimeAsync(300);
  expect(labels()).toEqual(["auth", "deploy"]);
  vi.useRealTimers();
});

// Every chain's items, tagged by chain where it is not the current one: waiting first across chains,
// then this chain's, then the others' (§状态面板); an archived chain's offers to reopen it.
it("tags other chains' rows, orders this chain's before them, and reopens an archived chain's item", () => {
  const c = (id: string, name: string, archived = false) => ({ id, name, archived });
  chainId = "a";
  open = { items: [
    { problem: "other", stage: "", status: "running", runs: [], chain: c("b", "Ops") },
    { problem: "here", stage: "", status: "running", runs: [], chain: c("a", "Main") },
    { problem: "asks", stage: "", status: "waiting on you", runs: [], chain: c("b", "Ops") },
    { problem: "old", stage: "", status: "running", runs: [], chain: c("z", "Past", true) },
  ], unlisted: [] };
  drawer.renderDrawer(); drawer.openDrawer();
  expect(labels()).toEqual(["asks", "here", "other", "old"]);
  const tag = (key: string) => item(key).querySelector(".open-item-chain")!;
  expect(tag("item:a/here").classList.contains("hidden")).toBe(true);
  expect([tag("item:b/asks").textContent, tag("item:z/old").textContent]).toEqual(["Ops", "Past · archived"]);
  item("item:b/other").querySelector(".session-open")!.onclick?.();
  expect(openItem).toHaveBeenLastCalledWith(expect.objectContaining({ problem: "other" }), "b");
  drawer.openDrawer();
  choose(item("item:b/other"), "Item view");
  expect(itemView).toHaveBeenLastCalledWith("other", "b");
  drawer.openDrawer();
  const reopenButton = (key: string) => item(key).querySelector(".open-item-reopen")!;
  expect(reopenButton("item:b/other")).toBeNull();
  expect(reopenButton("item:z/old").textContent).toBe("Open in its chain");
  reopenButton("item:z/old").onclick?.();
  expect(reopen).toHaveBeenCalledWith("z", "old");
});

// Every chain's head reply counts on the app icon, and no head is an In progress row.
it("counts each chain's unread head on the badge and leaves every head off the list", () => {
  const info = (id: string, head: string, unread: boolean) =>
    ({ id, name: id, createdAt: 1, unread, waiting: 0, head: { sessionId: head, state: "idle" as const } });
  chains = [info("a", "ha", true), info("b", "hb", true), info("c", "hc", false)];
  sessions = [row("ha", { unread: true }), row("hb", { unread: true }), row("x", { unread: true })];
  drawer.renderDrawer();
  expect(badge).toHaveBeenLastCalledWith(3);
  expect(drawer.inProgress(sessions, chain, chains).map((s) => s.id)).toEqual(["x"]);
});

// Shown from another chain, the first chain's earlier members are still that chain's, never In progress rows.
it("leaves every chain's earlier members off the list and the badge", () => {
  chain = [member("s1")];
  sessions = [row("old", { unread: true, member: "main" }), row("s1", { member: "sec" }), row("x", { unread: true })];
  drawer.renderDrawer();
  expect(shown("#status-item-count")).toBe("1");
  expect(badge).toHaveBeenLastCalledWith(1);
  expect(drawer.inProgress(sessions, chain).map((s) => s.id)).toEqual(["x"]);
});

// A closed item the search found in another chain carries that chain's tag, and opens there.
it("tags a found closed item with its chain", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  chainId = "a";
  chains = [{ id: "a", name: "Main", createdAt: 1, unread: false, waiting: 0 }, { id: "b", name: "Ops", createdAt: 2, archivedAt: 3, unread: false, waiting: 0 }];
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ items: [
    { chain: "b", problem: "deploy", aliases: [], closedAt: 1, updatedAt: 1 }, { chain: "a", problem: "auth", aliases: [], closedAt: 1, updatedAt: 1 },
  ] }) })));
  open = { items: [{ problem: "live", stage: "", status: "running", runs: [] }], unlisted: [] };
  drawer.renderDrawer(); drawer.openDrawer();
  const field = doc.querySelector("input[type='search']")!;
  field.value = "d";
  field.oninput?.(new Event("input"));
  await vi.advanceTimersByTimeAsync(300);
  const tag = (key: string) => item(key).querySelector(".open-item-chain")!;
  expect([tag("closed:deploy").textContent, tag("closed:auth").classList.contains("hidden")]).toEqual(["Ops · archived", true]);
  item("closed:deploy").querySelector(".session-open")!.onclick?.();
  expect(itemView).toHaveBeenLastCalledWith("deploy", "b");
  vi.useRealTimers();
});

/** A Close's Undo window running out (drawer.ts UNDO_MS). */
const lapse = () => vi.advanceTimersByTime(5000);
const undoOf = (li: { querySelector: (s: string) => unknown }) => fake(li.querySelector(".item-undo"));
type Entry = { label: string; hint?: string; disabled?: boolean; onSelect: () => void };
/** The sidebar row's menu as its ⋯ opens it, the ⋯ focused first: the menu hands the focus back to it. */
const menuOf = (li: ReturnType<typeof item>): Entry[] => {
  const more = li.querySelector(".item-more")!;
  more.focus();
  more.onclick?.();
  return menu.openMenu.mock.lastCall![1] as Entry[];
};
/** Its entry `label` chosen. The real closeMenu closes only the menu over the panel; the mock's closes the panel, so it is kept. */
const choose = (li: ReturnType<typeof item>, label: string): void => {
  const entry = menuOf(li).find((e) => e.label === label)!;
  const kept = menu.panel;
  menu.panel = null;
  entry.onSelect();
  menu.panel = kept;
};

// The panel's Close waits out its Undo, then the row leaves before the server answers; the stream's re-read agrees, a refusal brings it back.
it("defers an item row's Close behind Undo, keeps focus in the list, and restores it with the error on a refusal", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const c = { id: "a", name: "Main", archived: false };
  chainId = "a";
  const asked: string[] = [];
  let answer: { ok: boolean; status: number; json: () => Promise<unknown> } = { ok: true, status: 200, json: async () => ({ closed: "auth" }) };
  const fetcher = vi.fn(async (url: string, init: RequestInit) => { asked.push(`${String(init.method)} ${url}`); return answer; });
  vi.stubGlobal("fetch", fetcher);
  open = { items: [{ problem: "auth", stage: "", status: "running", runs: [], chain: c }, { problem: "sign in", stage: "", status: "running", runs: [], chain: c }], unlisted: [] };
  sessions = [row("solo", { state: "streaming" })];
  drawer.renderDrawer(); drawer.openDrawer();
  const close = (key: string) => choose(item(key), "Mark done");
  expect(item("session:solo").querySelector(".item-more")).toBeNull();
  Object.defineProperty(item("item:a/auth"), "offsetHeight", { value: 52 });
  close("item:a/auth");
  // In place and as tall, nothing sent: the row reads `Closed — Undo`, its Undo focused, the bar no longer counting it.
  expect(item("item:a/auth").textContent).toBe("Closed \u2014Undo");
  expect(item("item:a/auth").style.minHeight).toBe("52px");
  expect(undoOf(item("item:a/auth")).getAttribute("aria-label")).toBe("Undo closing auth");
  expect(doc.activeElement).toBe(undoOf(item("item:a/auth")));
  expect(doc.querySelector("p[role='status']")!.textContent).toBe("auth closed \u2014 Undo for 5 seconds.");
  expect(shown("#status-item-count")).toBe("2");
  vi.advanceTimersByTime(4999);
  expect(asked).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(labels()).toEqual(["sign in", "solo"]);
  expect(panel().querySelector(".item-undo")).toBeNull();
  expect(doc.activeElement).toBe(item("item:a/sign in").querySelector(".session-open"));
  await vi.waitFor(() => expect(asked).toEqual(["POST /api/continuous/items/a/auth/close"]));
  expect(fetcher).toHaveBeenCalledWith("/api/continuous/items/a/auth/close", { method: "POST", keepalive: true });
  open = { items: [open.items[1]!], unlisted: [] };
  drawer.renderDrawer();
  expect(labels()).toEqual(["sign in", "solo"]);

  // Undo sends nothing and gives the row, and the focus, back.
  close("item:a/sign in");
  undoOf(item("item:a/sign in")).onclick?.();
  expect(labels()).toEqual(["sign in", "solo"]);
  expect(doc.activeElement).toBe(item("item:a/sign in").querySelector(".session-open"));
  expect(doc.querySelector("p[role='status']")!.textContent).toBe("sign in kept open.");
  lapse();
  expect(asked).toHaveLength(1);

  answer = { ok: false, status: 404, json: async () => ({ error: "no open item \"sign in\"" }) };
  close("item:a/sign in");
  lapse();
  expect(labels()).toEqual(["solo"]);
  await vi.waitFor(() => expect(labels()).toEqual(["sign in", "solo"]));
  const list = panel().querySelector("[data-list]")!;
  expect(list.children[0]!.textContent).toBe("no open item \"sign in\"");
  expect(list.children[0]!.className).toContain("text-red-600");

  // The next Close takes that refusal off the top: focus lands on the row that took the closed one's place.
  answer = { ok: true, status: 200, json: async () => ({ closed: "sign in" }) };
  open = { items: [open.items[0]!, { problem: "deploy", stage: "", status: "running", runs: [], chain: c }], unlisted: [] };
  drawer.renderDrawer();
  close("item:a/sign in");
  expect(panel().querySelector("[data-list]")!.children[0]!.textContent).toBe("Closed \u2014Undo");
  lapse();
  expect(labels()).toEqual(["deploy", "solo"]);
  expect(doc.activeElement).toBe(item("item:a/deploy").querySelector(".session-open"));
  vi.useRealTimers();
});

// The last item row's place goes to the `Sessions` heading, which has no control: the row above keeps the focus, else the one below.
it("keeps the focus on a row when the last item row closes above the Sessions heading", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const c = { id: "a", name: "Main", archived: false };
  chainId = "a";
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })));
  open = { items: [{ problem: "auth", stage: "", status: "running", runs: [], chain: c }, { problem: "deploy", stage: "", status: "running", runs: [], chain: c }], unlisted: [] };
  sessions = [row("solo", { state: "streaming" })];
  drawer.renderDrawer(); drawer.openDrawer();
  const close = (key: string) => choose(item(key), "Mark done");
  close("item:a/deploy");
  lapse();
  expect(labels()).toEqual(["auth", "solo"]);
  expect(doc.activeElement).toBe(item("item:a/auth").querySelector(".session-open"));
  close("item:a/auth");
  lapse();
  expect(labels()).toEqual(["solo"]);
  expect(doc.activeElement).toBe(item("session:solo").querySelector(".session-open"));
  vi.useRealTimers();
});

// Each Close keeps its own Undo window; a page that hides or leaves sends every waiting one at once.
it("times each deferred Close on its own and sends the waiting ones when the page hides or leaves", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const c = { id: "a", name: "Main", archived: false };
  chainId = "a";
  const asked: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => { asked.push(url.split("/")[5]!); return { ok: true, status: 200, json: async () => ({}) }; }));
  const items = ["one", "two", "three", "four"].map((problem) => ({ problem, stage: "", status: "running" as const, runs: [], chain: c }));
  open = { items, unlisted: [] };
  drawer.renderDrawer(); drawer.openDrawer();
  const close = (problem: string) => choose(item(`item:a/${problem}`), "Mark done");
  close("one");
  vi.advanceTimersByTime(2000);
  close("two");
  expect(rail().querySelectorAll(".item-undo")).toHaveLength(2);
  vi.advanceTimersByTime(3000);
  expect(asked).toEqual(["one"]);
  vi.advanceTimersByTime(2000);
  expect(asked).toEqual(["one", "two"]);
  close("three");
  let hidden = false;
  Object.defineProperty(doc, "visibilityState", { configurable: true, get: () => hidden ? "hidden" : "visible" });
  doc.dispatchEvent(new Event("visibilitychange"));
  expect(asked).toEqual(["one", "two"]);
  hidden = true;
  doc.dispatchEvent(new Event("visibilitychange"));
  expect(asked).toEqual(["one", "two", "three"]);
  close("four");
  onWindow.get("pagehide")!();
  vi.advanceTimersByTime(5000);
  expect(asked).toEqual(["one", "two", "three", "four"]);
  vi.useRealTimers();
});

// The stream's re-read lands while a Close waits: the waiting row is neither a live row again nor gone with its Undo.
it("keeps a waiting Close's Undo through a re-read of the items, and sends it once though the item left another way", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const c = { id: "a", name: "Main", archived: false };
  chainId = "a";
  const asked: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => { asked.push(url.split("/")[5]!); return { ok: true, status: 200, json: async () => ({}) }; }));
  const of = (problem: string, status: "running" | "waiting on you" = "running") => ({ problem, stage: "", status, runs: [], chain: c });
  open = { items: [of("auth"), of("deploy")], unlisted: [] };
  drawer.renderDrawer(); drawer.openDrawer();
  choose(item("item:a/auth"), "Mark done");

  // Another item arrives and the waiting one changes state: its row is still the Undo, on both surfaces, uncounted.
  open = { items: [of("auth", "waiting on you"), of("deploy"), of("billing")], unlisted: [] };
  drawer.renderDrawer();
  expect(labels()).toEqual(["deploy", "billing"]);
  expect(item("item:a/auth").textContent).toBe("Closed \u2014Undo");
  expect(rail().querySelectorAll(".item-undo")).toHaveLength(1);
  expect(shown("#rail-items-head")).toBe("Items \u00b7 2");
  expect(asked).toEqual([]);

  // Closed elsewhere meanwhile: the Undo leaves with the item and its timer, and no Close is sent.
  open = { items: [of("deploy"), of("billing")], unlisted: [] };
  drawer.renderDrawer();
  expect(panel().querySelector(".item-undo")).toBeNull();
  expect(rail().querySelector(".item-undo")).toBeNull();
  lapse();
  await Promise.resolve();
  expect(asked).toEqual([]);
  expect(labels()).toEqual(["deploy", "billing"]);
  vi.useRealTimers();
});

// A run tree with nothing running leaves the stage line alone; its total stays the tooltip's.
it("hides the running count of a tree with none running and keeps its total in the tooltip", () => {
  open = { items: [{ problem: "idle", stage: "", status: "wrapping up", runs: [], tree: { runs: 3, running: 0, queued: 0 } }], unlisted: [] };
  drawer.renderDrawer(); drawer.openDrawer();
  expect(item("item:idle").querySelector(".open-item-tree")!.classList.contains("hidden")).toBe(true);
  expect(item("item:idle").querySelector(".session-open")!.title).toContain("3 runs behind this item, 0 running");
});

// The sidebar's Items section is the panel's list drawn again (§侧边栏): the same rows in the
// same order, each surface its own nodes, one Close for both, a refusal said where it was asked.
it("fills the rail's Items section with the panel's rows, closes on both surfaces from either, and refuses on the asking one", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const c = { id: "a", name: "Main", archived: false };
  chainId = "a";
  const asked: string[] = [];
  let answer: { ok: boolean; status: number; json: () => Promise<unknown> } = { ok: true, status: 200, json: async () => ({ closed: "auth" }) };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => { asked.push(`${String(init.method)} ${url}`); return answer; }));
  drawer.renderDrawer();
  expect(rail().getAttribute("aria-labelledby")).toBe("rail-items-head");
  expect(shown("#rail-items-head")).toBe("Items");
  expect(rail().textContent).toContain("Nothing open");
  open = { items: [
    { problem: "auth", stage: "", status: "running", runs: [], chain: c, openedAt: Date.now() - 2 * 3_600_000 },
    { problem: "asks", stage: "", status: "waiting on you", runs: [], chain: { id: "b", name: "Ops", archived: false } },
  ], unlisted: [] };
  sessions = [row("solo", { state: "streaming" })];
  drawer.renderDrawer(); drawer.openDrawer();
  expect(shown("#rail-items-head")).toBe("Items · 2");
  expect([...railRows(), ...railLoose()]).toEqual(labels());
  expect(labels()).toEqual(["asks", "auth", "solo"]);
  expect(rail().querySelector("[data-list]")).not.toBeNull();
  const railItem = (key: string) => rail().querySelector(`[data-row-key='${key}']`)!;
  expect(railItem("item:a/auth")).not.toBe(item("item:a/auth"));
  expect(railItem("item:b/asks").querySelector(".open-item-chain")!.textContent).toBe("Ops");
  expect(railItem("item:a/auth").querySelector("button")!.title).toBe("open 2h");
  // A refresh keeps each surface's node.
  const before = [railItem("item:a/auth"), item("item:a/auth")];
  open = { ...open, items: [{ ...open.items[0]!, stage: "signing in" }, open.items[1]!] };
  drawer.renderDrawer();
  expect([railItem("item:a/auth"), item("item:a/auth")]).toEqual(before);
  // Close from the rail: `Closed — Undo` on both, then gone from both at once; focus stays in the rail's list.
  choose(railItem("item:a/auth"), "Mark done");
  expect([railItem("item:a/auth").textContent, item("item:a/auth").textContent]).toEqual(["Closed \u2014Undo", "Closed \u2014Undo"]);
  expect(shown("#rail-items-head")).toBe("Items · 1");
  expect(doc.activeElement).toBe(undoOf(railItem("item:a/auth")));
  lapse();
  expect(railRows()).toEqual(["asks"]);
  expect(labels()).toEqual(["asks", "solo"]);
  // Focus stays in the Items list: the session sits in its own section.
  expect(doc.activeElement).toBe(railItem("item:b/asks").querySelector(".session-open"));
  expect(railLoose()).toEqual(["solo"]);
  await vi.waitFor(() => expect(asked).toEqual(["POST /api/continuous/items/a/auth/close"]));
  // Refused from the rail: the row is back on both, the sentence atop the rail's list, the panel left as it was.
  menu.closeMenu();
  answer = { ok: false, status: 409, json: async () => ({ error: "auth is still running" }) };
  choose(railItem("item:b/asks"), "Mark done");
  lapse();
  expect(railRows()).toEqual([]);
  await vi.waitFor(() => expect(railRows()).toEqual(["asks"]));
  const list = rail().querySelector("[data-list]")!;
  expect(list.children[0]!.textContent).toBe("auth is still running");
  expect(list.children[0]!.className).toContain("text-red-600");
  expect(menu.openPanel).toHaveBeenCalledOnce();
  // The refusal stands while its row does: closed another way, the sentence leaves with it.
  const kept = open;
  open = { ...open, items: [open.items[0]!] };
  drawer.renderDrawer();
  expect(railRows()).toEqual([]);
  expect(rail().textContent).not.toContain("still running");
  open = kept;
  drawer.renderDrawer();
  choose(railItem("item:b/asks"), "Mark done");
  lapse();
  await vi.waitFor(() => expect(rail().querySelector("[data-list]")!.children[0]!.textContent).toBe("auth is still running"));
  // The panel's next Close takes the rail's refusal down too.
  drawer.openDrawer();
  expect(panel().querySelector("[data-list]")!.children[0]!.textContent).not.toContain("still running");
  answer = { ok: true, status: 200, json: async () => ({ closed: "asks" }) };
  choose(item("item:b/asks"), "Mark done");
  lapse();
  expect(railRows()).toEqual([]);
  expect(rail().textContent).not.toContain("still running");
  vi.useRealTimers();
});

// An item row has one ⋯ and its context menu, the same menu on both surfaces: the item view, Mark done and Stop.
it("gives an item row on either surface one menu of its item view, Mark done and Stop", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const c = { id: "a", name: "Main", archived: false };
  chainId = "a";
  const asked: string[] = [];
  let answer: { ok: boolean; status: number; json: () => Promise<unknown> } = { ok: true, status: 200, json: async () => ({ stopped: 3 }) };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => { asked.push(`${String(init.method)} ${url}`); return answer; }));
  const confirm = vi.fn(() => true);
  vi.stubGlobal("window", { addEventListener: (name: string, fn: () => void) => onWindow.set(name, fn), confirm });
  open = { items: [{ problem: "auth", stage: "", status: "running", runs: [], chain: c, tree: { runs: 4, running: 3, queued: 1, lead: true } },
    { problem: "idle", stage: "", status: "waiting on you", runs: [], chain: c, tree: { runs: 1, running: 0, queued: 0 } },
    { problem: "next", stage: "", status: "running", runs: [], chain: c, tree: { runs: 1, running: 0, queued: 1 } }], unlisted: [] };
  sessions = [row("solo", { state: "streaming" })];
  drawer.renderDrawer(); drawer.openDrawer();
  const railItem = (key: string) => rail().querySelector(`[data-row-key='${key}']`)!;
  expect(railSessions().querySelector("[data-row-key='session:solo']")!.querySelector(".item-more")).toBeNull();
  const more = railItem("item:a/auth").querySelector(".item-more")!;
  expect([more.getAttribute("aria-label"), more.getAttribute("aria-haspopup")]).toEqual(["Actions for auth", "menu"]);
  more.onclick?.();
  const [anchor, entries, title] = menu.openMenu.mock.calls[0]! as [unknown, Entry[], string];
  expect([anchor, title]).toEqual([more, "auth"]);
  expect(entries.map(({ label, hint, disabled }) => [label, hint, disabled])).toEqual([
    ["Item view", "its conversation", undefined], ["Mark done", undefined, undefined], ["Stop\u2026", "4 runs", false]]);
  entries[0]!.onSelect();
  expect(itemView).toHaveBeenCalledWith("auth", "a");
  // A right click opens the same menu on the ⋯, the browser's own kept away.
  const right = new Event("contextmenu", { cancelable: true });
  railItem("item:a/auth").dispatchEvent(right);
  expect([right.defaultPrevented, menu.openMenu.mock.lastCall![0]]).toEqual([true, more]);
  // Nothing running: Stop is shown, not offered.
  expect(menuOf(railItem("item:a/idle")).at(-1)).toMatchObject({ hint: "nothing running", disabled: true });
  // A queued run is stopped too: a worker's item asks for its run alone.
  expect(menuOf(railItem("item:a/next")).at(-1)).toMatchObject({ hint: "1 run", disabled: false });
  confirm.mockReturnValueOnce(false);
  choose(railItem("item:a/next"), "Stop\u2026");
  expect(confirm).toHaveBeenLastCalledWith("Stop next? Its run will be cancelled.");

  // Stop asks first; declined, nothing is sent.
  confirm.mockReturnValueOnce(false);
  choose(railItem("item:a/auth"), "Stop\u2026");
  expect(confirm).toHaveBeenLastCalledWith("Stop auth? Its lead and every worker it launched will be cancelled \u2014 4 runs.");
  expect(asked).toEqual([]);
  choose(railItem("item:a/auth"), "Stop\u2026");
  await vi.waitFor(() => expect(asked).toEqual(["POST /api/continuous/items/a/auth/stop"]));
  expect(railRows()).toEqual(["idle", "auth", "next"]);
  // A refusal stands atop the rail's list.
  answer = { ok: false, status: 409, json: async () => ({ error: 'nothing of "auth" is running or queued' }) };
  choose(railItem("item:a/auth"), "Stop\u2026");
  await vi.waitFor(() => expect(rail().querySelector("[data-list]")!.children[0]!.textContent).toBe('nothing of "auth" is running or queued'));
  // The panel's row is the same row, its menu the same: a refusal there lands atop the panel's list.
  drawer.openDrawer();
  expect(item("item:a/auth").querySelector(".item-more")!.getAttribute("aria-label")).toBe("Actions for auth");
  expect(menuOf(item("item:a/auth")).map(({ label, hint }) => [label, hint])).toEqual(entries.map(({ label, hint }) => [label, hint]));
  choose(item("item:a/auth"), "Stop\u2026");
  await vi.waitFor(() => expect(panel().querySelector("[data-list]")!.children[0]!.textContent).toBe('nothing of "auth" is running or queued'));
  // The next Stop takes the standing refusals with it, on both surfaces.
  answer = { ok: true, status: 200, json: async () => ({ stopped: 1 }) };
  choose(item("item:a/next"), "Stop\u2026");
  expect(rail().querySelector("[data-list]")!.querySelector("[data-refused]")).toBeNull();
  expect(panel().querySelector("[data-list]")!.querySelector("[data-refused]")).toBeNull();
  await vi.waitFor(() => expect(asked.filter((a) => a.endsWith("/stop"))).toHaveLength(4));

  choose(railItem("item:a/auth"), "Mark done");
  lapse();
  expect(railRows()).toEqual(["idle", "next"]);
  expect(railLoose()).toEqual(["solo"]);
  await vi.waitFor(() => expect(asked.at(-1)).toBe("POST /api/continuous/items/a/auth/close"));
  vi.useRealTimers();
});

// The rail's last row closed leaves `Nothing open` and no list to keep the focus in: the current chain's row above takes it.
it("moves the focus to the current chain's row when the rail's last item row closes", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const c = { id: "a", name: "Main", archived: false };
  chainId = "a";
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ closed: "auth" }) })));
  const chainRow = doc.createElement("button");
  chainRow.setAttribute("aria-current", "page");
  doc.querySelector("#rail-chains")!.append(chainRow);
  open = { items: [{ problem: "auth", stage: "", status: "running", runs: [], chain: c }], unlisted: [] };
  drawer.renderDrawer();
  choose(rail().querySelector("[data-row-key='item:a/auth']")!, "Mark done");
  lapse();
  expect(rail().textContent).toContain("Nothing open");
  expect(doc.activeElement).toBe(chainRow);
  vi.useRealTimers();
});

// An item closed elsewhere takes its focused Undo away with no timer to hand the focus on: the render does, as a sent Close does.
it("keeps the focus in the list when a focused Undo's item closes elsewhere, on the chain's row after the rail's last", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const c = { id: "a", name: "Main", archived: false };
  chainId = "a";
  const asked = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  vi.stubGlobal("fetch", asked);
  const chainRow = doc.createElement("button");
  chainRow.setAttribute("aria-current", "page");
  doc.querySelector("#rail-chains")!.append(chainRow);
  const of = (problem: string) => ({ problem, stage: "", status: "running" as const, runs: [], chain: c });
  const railItem = (key: string) => rail().querySelector(`[data-row-key='${key}']`)!;
  const closeFocused = (li: () => ReturnType<typeof item>): void => {
    choose(li(), "Mark done");
    expect(doc.activeElement).toBe(undoOf(li()));
  };
  open = { items: [of("auth"), of("deploy"), of("billing")], unlisted: [] };
  drawer.renderDrawer(); drawer.openDrawer();

  // The panel's middle row: the row that takes its place takes the focus.
  closeFocused(() => item("item:a/deploy"));
  open = { items: [of("auth"), of("billing")], unlisted: [] };
  drawer.renderDrawer();
  expect(doc.activeElement).toBe(item("item:a/billing").querySelector(".session-open"));
  // The rail's bottom row: the one above it.
  closeFocused(() => railItem("item:a/billing"));
  open = { items: [of("auth")], unlisted: [] };
  drawer.renderDrawer();
  expect(doc.activeElement).toBe(railItem("item:a/auth").querySelector(".session-open"));
  // The rail's last row: `Nothing open` has no list, so the current chain's row.
  closeFocused(() => railItem("item:a/auth"));
  open = { items: [], unlisted: [] };
  drawer.renderDrawer();
  expect(rail().textContent).toContain("Nothing open");
  expect(doc.activeElement).toBe(chainRow);
  lapse();
  expect(asked).not.toHaveBeenCalled();
  vi.useRealTimers();
});

// A search's open match is its panel row: a row the stream drops leaves the results too, not left behind as a detached node.
it("drops a search's open match whose row the stream took away", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ items: [{ problem: "auth", aliases: [], updatedAt: 1 }] }) })));
  open = { items: [{ problem: "auth", stage: "", status: "running", runs: [] }, { problem: "deploy", stage: "", status: "running", runs: [] }], unlisted: [] };
  drawer.renderDrawer(); drawer.openDrawer();
  const field = doc.querySelector("input[type='search']")!;
  field.value = "auth";
  field.oninput?.(new Event("input"));
  await vi.advanceTimersByTimeAsync(300);
  expect(labels()).toEqual(["auth"]);
  open = { items: [open.items[1]!], unlisted: [] };
  drawer.renderDrawer();
  expect(labels()).toEqual([]);
  // Its last match gone, the search says so rather than leaving the panel blank.
  expect(panel().querySelector("[data-list]")!.textContent).toBe("No item matches.");
  vi.useRealTimers();
});

// Which chain is current tags and orders the rows: switching to another chain with the same members redraws both surfaces.
it("redraws both surfaces' chain tags when only the current chain changes", () => {
  open = { items: [
    { problem: "auth", stage: "", status: "running", runs: [], chain: { id: "a", name: "Main", archived: false } },
    { problem: "deploy", stage: "", status: "running", runs: [], chain: { id: "b", name: "Ops", archived: false } },
  ], unlisted: [] };
  chainId = "a";
  drawer.renderDrawer(); drawer.openDrawer();
  const tag = (root: ReturnType<typeof rail>, key: string) => root.querySelector(`[data-row-key='${key}']`)!.querySelector(".open-item-chain")!;
  expect(railRows()).toEqual(["auth", "deploy"]);
  chainId = "b";
  drawer.renderDrawer();
  expect(railRows()).toEqual(["deploy", "auth"]);
  expect(labels()).toEqual(["deploy", "auth"]);
  expect([tag(rail(), "item:a/auth").textContent, tag(panel(), "item:a/auth").textContent]).toEqual(["Main", "Main"]);
  expect(tag(rail(), "item:b/deploy").classList.contains("hidden")).toBe(true);
});
