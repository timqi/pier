// Reopening the model picker must not wait on the network: the catalog and the
// model's reasoning levels are cached, so the second open draws before the read
// that reconciles it.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ModelRef, ThinkingLevel } from "../../core/types.js";
import type { SessionInfo } from "./drawer.js";
import { fake, installPage, type FakeElement } from "./dom.testkit.js";

const meta = (): FakeElement => fake(document.querySelector("#session-meta"));

vi.mock("./menu.js", () => ({
  closeMenu: vi.fn(), openMenu: vi.fn(),
  // A panel is on screen once opened: the header checks before drawing into it.
  openPanel: vi.fn((_anchor: HTMLElement, panel: HTMLElement) => { if (!panel.isConnected) document.body.append(panel); }),
}));
vi.mock("./api.js", () => ({ mustGetJson: vi.fn(), sendJson: vi.fn() }));
vi.mock("./chat.js", () => ({ appendTurn: vi.fn() }));
vi.mock("./model-picker.js", () => ({ modelPicker: vi.fn(() => document.createElement("div")) }));
vi.mock("./shortcut.js", () => ({ chord: vi.fn(), chordLabel: (key: string) => `⌘${key.toUpperCase()}`, modalOpen: vi.fn(), escapeKey: vi.fn() }));
const drawer = vi.hoisted(() => ({ head: undefined as unknown }));
vi.mock("./drawer.js", () => ({
  headSession: () => drawer.head,
  phaseTag: (s: SessionInfo) => (s.phase ? [Object.assign(document.createElement("span"), { textContent: s.phase })] : []),
  stateDot: () => [document.createElement("i")],
  // Marked so the chip's title proves it uses the drawer's words, which
  // drawer.test.ts owns, rather than spelling its own second copy.
}));
const chains = vi.hoisted(() => ({ openChains: vi.fn(), toggleSidebar: vi.fn(), SIDEBAR_KEY: "b", sidebarDocked: vi.fn(() => false) }));
vi.mock("./chains.js", () => chains);
const systemPrompt = vi.hoisted(() => ({ openSystemPrompt: vi.fn() }));
vi.mock("./system-prompt.js", () => systemPrompt);
const charter = vi.hoisted(() => ({ openCharter: vi.fn() }));
vi.mock("./charter.js", () => charter);

const model: ModelRef = { provider: "test", id: "test-model" };
const levels: ThinkingLevel[] = ["low", "high"];

const openSettings = vi.fn();
const openContinuous = vi.fn();
const goBack = vi.fn();
/** The current chain's row; undefined before the list is read. */
let chain: import("../types.js").ChainInfo | undefined;

/** What the orchestrator's list says about the selected session. */
let current: SessionInfo | undefined;
/** The continuous conversation is on screen. */
let conversation = false;
let viewing: string | null = null;

let header: typeof import("./session-header.js");
let picker: typeof import("./model-picker.js");
let api: typeof import("./api.js");

/** Buttons in the meta row, in render order: the running chip when there is
 *  one, then the model chip that opens the picker. */
function chips(): FakeElement[] {
  return meta().children.filter((c) => c.localName === "button");
}

/** The model chip — the first button when no run is in flight (model, then
 *  reasoning), the button that opens the picker. */
function chip(): FakeElement {
  const button = chips()[0];
  if (!button) throw new Error("no model chip rendered");
  return button;
}

const session = (activeRuns: number): SessionInfo =>
  ({ id: "s1", cwd: "/tmp", createdAt: 0, state: "idle", unread: false, channel: "web", activeRuns });

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  installPage();
  current = undefined;
  conversation = false;
  viewing = null;
  chain = undefined;
  drawer.head = undefined;
  header = await import("./session-header.js");
  picker = await import("./model-picker.js");
  api = await import("./api.js");
  header.initHeader({
    currentId: () => "s1",
    currentSession: () => current,
    openFiles: vi.fn(),
    toggleFiles: vi.fn(),
    openSettings,
    continuousOpen: () => conversation,
    rotateAt: () => 60_000,
    openContinuous,
    back: goBack,
    chain: () => chain,
    item: () => viewing,
  });
  vi.mocked(api.mustGetJson).mockImplementation((url: string) =>
    Promise.resolve(url.endsWith("/models") ? [model] : { level: "high", levels }) as never
  );
  header.setHeaderState(model, null, "high", null);
});

afterEach(() => vi.unstubAllGlobals());

// Below md the chips cost the bar a line, so only the row that has to be seen
// without opening anything keeps it (style.css reads the mark).
it("marks the meta row urgent only once the context is near full", () => {
  // 75K is 7.5% of the window but 75% of the way to compaction: the latter warns.
  const usage = { contextWindow: 1_000_000, tokens: 20_000, compactAt: 100_000 };
  header.setHeaderState(model, usage, "high", null);
  expect(meta().hasAttribute("data-urgent")).toBe(false);
  header.setHeaderState(model, { ...usage, tokens: 75_000 }, "high", null);
  expect(meta().hasAttribute("data-urgent")).toBe(true);
});

// The distance that matters is to compaction, not to a window it never reaches.
it("reads the context against where the session compacts", async () => {
  const context = async (): Promise<string> => {
    current = session(0);
    header.renderHeader();
    fake(document.querySelector("#chat-title")).onclick?.();
    const panel = fake(vi.mocked((await import("./menu.js")).openPanel).mock.lastCall?.[1]);
    const row = panel.querySelectorAll("div").find((d) => d.firstElementChild?.textContent === "Context");
    return fake(row?.querySelector("dd")).textContent;
  };
  header.setHeaderState(model, { contextWindow: 1_000_000, tokens: 50_000, compactAt: 100_000 }, "high", null);
  expect(await context()).toBe("50K/100K · 50% left");
  header.setHeaderState(model, { contextWindow: 1_000_000, tokens: null, compactAt: 100_000 }, "high", null);
  expect(await context()).toBe("?/100K");
  // The conversation's head is replaced before it compacts: its room is rotateAt.
  conversation = true;
  header.setHeaderState(model, { contextWindow: 1_000_000, tokens: 36_000, compactAt: 100_000 }, "high", null);
  expect(await context()).toBe("36K/60K · 40% left");
});

// The conversation rotates sessions and spans topics: the header names it as
// its own name, whatever the head was titled; every other session keeps its own.
it("titles the continuous conversation Pier, other sessions by their own title", () => {
  const title = () => fake(document.querySelector("#chat-title")).textContent;
  current = { ...session(0), title: "Worker展示功能" };
  header.renderHeader();
  expect(title()).toBe("Worker展示功能");
  conversation = true;
  header.renderHeader();
  expect(title()).toBe("Pier");
  // Before its first session exists there is no row to title it either.
  current = undefined;
  header.renderHeader();
  expect(title()).toBe("Pier");
});

const title = () => fake(document.querySelector("#chat-title"));
const back = () => fake(document.querySelector("#bar-back"));

// The title names the chain and opens the list; before the list is read it is Pier and opens Session info.
it("titles the conversation by its chain, the title opening the chain list", async () => {
  conversation = true;
  current = session(0);
  chain = { id: "c1", name: "Design", createdAt: 1, unread: false, waiting: 0 };
  header.renderHeader();
  expect(title().textContent).toBe("Design");
  expect(title().getAttribute("aria-haspopup")).toBe("dialog");
  title().onclick?.();
  expect(chains.openChains).toHaveBeenCalledOnce();
  // With the sidebar docked the list is already on screen: a plain heading — an <h1>, not a disabled button.
  const button = title();
  // Docked by crossing 64rem with the floated list open from it: the list closes, the focus moves to the heading.
  const { closeMenu } = await import("./menu.js");
  vi.mocked(closeMenu).mockClear();
  button.setAttribute("aria-expanded", "true");
  button.focus();
  chains.sidebarDocked.mockReturnValue(true);
  header.renderHeader();
  expect(closeMenu).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(title());
  expect(title().localName).toBe("h1");
  expect(title().textContent).toBe("Design");
  expect(title().hasAttribute("aria-haspopup")).toBe(false);
  expect(title().onclick).toBeNull();
  chain = { ...chain, archivedAt: 2 };
  header.renderHeader();
  expect(title().textContent).toBe("Design · archived");
  // Hidden again (⌘B): the button is back, in the bar, with its type.
  chains.sidebarDocked.mockReturnValue(false);
  header.renderHeader();
  expect(title().localName).toBe("button");
  expect(title().getAttribute("type")).toBe("button");
  expect(title().className).toBe(button.className);
  expect(title().getAttribute("aria-haspopup")).toBe("dialog");
  // The item view keeps its problem; a child its own title.
  viewing = "auth";
  header.renderHeader();
  expect(title().textContent).toBe("auth");
  viewing = null;
  conversation = false;
  header.renderHeader();
  expect(title().hasAttribute("aria-haspopup")).toBe(false);
  chain = undefined;
  conversation = true;
  header.renderHeader();
  expect(title().textContent).toBe("Pier");
  const { openPanel } = await import("./menu.js");
  title().onclick?.();
  expect(openPanel).toHaveBeenCalled();
});

// No Chain mode in ⋯: the sidebar's entry is always live, with ⌘B's label, whether the list is read or not.
it("offers the sidebar in the ⋯ menu always, and no Chain mode", async () => {
  conversation = true;
  current = session(0);
  header.renderHeader();
  const items = await menuItems();
  expect(items.find((i) => i.label === "Chain mode")).toBeUndefined();
  const sidebar = items.find((i) => i.label === "Sidebar")!;
  expect(sidebar).toMatchObject({ hint: "⌘B", separatorBefore: true });
  expect(sidebar).not.toHaveProperty("disabled");
  sidebar.onSelect();
  expect(chains.toggleSidebar).toHaveBeenCalledOnce();
});

async function menuItems() {
  const { openMenu } = await import("./menu.js");
  fake(document.querySelector("#chat-menu")).onclick?.();
  return vi.mocked(openMenu).mock.lastCall![1];
}

it("offers the same ⋯ items on the conversation and on a child", async () => {
  conversation = true;
  current = session(0);
  header.renderHeader();
  const items = await menuItems();
  const labels = ["Session info", "System prompt", "Browse files", "Model & reasoning…", "Sidebar", "Settings"];
  expect(items.map((i) => i.label)).toEqual(labels);
  items[1]!.onSelect();
  expect(systemPrompt.openSystemPrompt).toHaveBeenCalledWith(current);
  items[5]!.onSelect();
  expect(openSettings).toHaveBeenCalledOnce();

  conversation = false;
  header.renderHeader();
  expect((await menuItems()).map((i) => i.label)).toEqual(labels);
});

// The charter is the chain's: offered in its conversation only, before its first reply too.
it("offers the chain's Charter… in its conversation, not on a child", async () => {
  chain = { id: "c1", name: "Parsers", createdAt: 0, unread: false, waiting: 0 };
  conversation = true;
  header.renderHeader();
  const items = await menuItems();
  expect(items.map((i) => i.label)).toEqual(["Session info", "System prompt", "Browse files", "Model & reasoning…", "Charter…", "Sidebar", "Settings"]);
  const entry = items.find((i) => i.label === "Charter…")!;
  expect(entry).toMatchObject({ separatorBefore: true });
  expect(entry).not.toHaveProperty("disabled");
  expect(items.find((i) => i.label === "Sidebar")!.separatorBefore).toBe(false);
  entry.onSelect();
  expect(charter.openCharter).toHaveBeenCalledWith(chain);

  conversation = false;
  current = session(0);
  header.renderHeader();
  expect((await menuItems()).map((i) => i.label)).not.toContain("Charter…");
});

// Before the conversation's first reply there is no session to describe or
// re-model, and ⋯ still opens: the two say why they are not available yet.
it("keeps ⋯ on a conversation with no session yet, its session actions disabled", async () => {
  conversation = true;
  header.renderHeader();
  expect(fake(document.querySelector("#chat-menu")).classList.contains("hidden")).toBe(false);
  expect(title().disabled).toBe(true);
  const items = await menuItems();
  const byLabel = (label: string) => items.find((i) => i.label === label)!;
  expect(byLabel("Session info")).toMatchObject({ disabled: true, hint: "after the first reply" });
  expect(byLabel("System prompt")).toMatchObject({ disabled: true, hint: "after the first reply" });
  expect(byLabel("Model & reasoning…")).toMatchObject({ disabled: true, hint: "after the first reply" });
  expect(byLabel("Settings").disabled).toBeUndefined();
});

// The ‹ is the way back from a child, wearing the head's dot while the
// conversation is doing something; on the conversation it is not there.
it("shows ‹ with the head's dot on a child, and the child's phase tag", () => {
  current = { ...session(0), title: "lead", phase: "design" };
  header.renderHeader();
  expect(back().classList.contains("hidden")).toBe(false);
  expect(back().querySelectorAll("i")).toHaveLength(0);
  expect(fake(document.querySelector("#chat-phase")).textContent).toBe("design");
  drawer.head = { ...session(0), id: "h", state: "streaming" };
  header.renderHeader();
  expect(back().querySelectorAll("i")).toHaveLength(1);
  back().onclick?.();
  expect(goBack).toHaveBeenCalledOnce();

  conversation = true;
  header.renderHeader();
  expect(back().classList.contains("hidden")).toBe(true);
  expect(fake(document.querySelector("#chat-phase")).textContent).toBe("");
});

// The item view's bar: its dot and problem with ×, which Esc shares; ‹ and × go back to the conversation.
it("names the item view's problem with its dot and ×, each way out opening the conversation", async () => {
  const { escapeKey } = await import("./shortcut.js");
  const { topicColour } = await import("./topics.js");
  const close = fake(document.querySelector("#item-close"));
  conversation = true;
  header.renderHeader();
  expect(close.classList.contains("hidden")).toBe(true);
  const bar = fake(document.querySelector("#bar"));
  expect(bar.hasAttribute("data-item")).toBe(false);
  viewing = "auth review";
  header.renderHeader();
  // Below md the × is the one way back: the bar's mark hides ‹, ⌂ and the context chip (style.css).
  expect(bar.hasAttribute("data-item")).toBe(true);
  expect(title().textContent).toBe("auth review");
  expect(title().querySelector("span")!.style.background).toBe(topicColour("auth review"));
  expect(close.classList.contains("hidden")).toBe(false);
  expect(close.getAttribute("aria-label")).toBe("Close the item view");
  expect(back().classList.contains("hidden")).toBe(false);
  close.onclick?.();
  back().onclick?.();
  const [el, , run, when] = vi.mocked(escapeKey).mock.calls[0]!;
  expect(el).toBe(document.querySelector("#item-close"));
  expect(when()).toBe(true);
  run();
  expect(openContinuous).toHaveBeenCalledTimes(2);
  expect(goBack).toHaveBeenCalledOnce();
  viewing = null;
  expect(when()).toBe(false);
  header.renderHeader();
  expect(title().textContent).toBe("Pier");
  expect(close.classList.contains("hidden")).toBe(true);
  expect(bar.hasAttribute("data-item")).toBe(false);
});

// The floating home button is the same way back, there only off the conversation.
it("shows the floating 回到主会话 button on a run or another session, and it opens the conversation", () => {
  const toMain = fake(document.querySelector("#to-main"));
  expect(toMain.getAttribute("aria-label")).toBe("回到主会话");
  expect(toMain.title).toBe("回到主会话");
  current = { ...session(0), title: "run" };
  header.renderHeader();
  expect(toMain.hasAttribute("data-show")).toBe(true);
  toMain.onclick?.();
  expect(openContinuous).toHaveBeenCalledOnce();
  conversation = true;
  header.renderHeader();
  expect(toMain.hasAttribute("data-show")).toBe(false);
});

// Subagents are the status panel's rows (drawer.ts): the meta row is model,
// reasoning and context only, and a phone shows it just for a context near full.
it("keeps the meta row to model, reasoning and context, urgent only under context pressure", () => {
  current = session(2);
  header.setHeaderState(model, null, "high", null);
  expect(chips().map((c) => c.textContent)).toEqual([model.id, "high"]);
  expect(meta().hasAttribute("data-urgent")).toBe(false);
  header.setHeaderState(model, { contextWindow: 1_000_000, tokens: 90_000, compactAt: 100_000 }, "high", null);
  expect(meta().hasAttribute("data-urgent")).toBe(true);
});

// The conversation's model is the default and never moves: its bar reads only
// the used context, inline at every width; the room is in Session info.
it("shows only the used context on the conversation's bar", () => {
  conversation = true;
  current = session(0);
  header.setHeaderState(model, { contextWindow: 1_000_000, tokens: 16_000, compactAt: 984_000 }, "high", null);
  expect(chips()).toHaveLength(0);
  expect(meta().textContent).toBe("16k");
  expect(meta().firstElementChild!.className).toContain("text-neutral-500");
  expect(meta().hasAttribute("data-inline")).toBe(true);
  conversation = false;
  header.renderHeader();
  expect(chips().map((c) => c.textContent)).toEqual([model.id, "high"]);
  expect(meta().hasAttribute("data-inline")).toBe(false);
});

// Tone and urgency are read against the rotation threshold, not where Pi compacts.
it("colours the conversation's context against the rotation threshold", () => {
  conversation = true;
  current = session(0);
  const at = (tokens: number) => {
    header.setHeaderState(model, { contextWindow: 1_000_000, tokens, compactAt: 984_000 }, "high", null);
    return meta().firstElementChild!.className;
  };
  expect(at(45_000)).toContain("text-amber-700");
  expect(meta().hasAttribute("data-urgent")).toBe(true);
  expect(at(55_000)).toContain("text-red-700");
  expect(at(30_000)).toContain("text-neutral-500");
  expect(meta().hasAttribute("data-urgent")).toBe(false);
});

it("draws the second open from cache, before the read answers", async () => {
  chip().onclick!();
  await vi.waitFor(() => expect(picker.modelPicker).toHaveBeenCalledTimes(1));

  // Nothing may resolve during the second open: what is drawn is the cache.
  let answer: () => void = () => {};
  vi.mocked(api.mustGetJson).mockImplementation(
    (url: string) =>
      new Promise((resolve) => {
        answer = () => resolve((url.endsWith("/models") ? [model] : { level: "high", levels }) as never);
      }),
  );
  chip().onclick!();
  expect(picker.modelPicker).toHaveBeenCalledTimes(2);
  expect(vi.mocked(picker.modelPicker).mock.lastCall![0]).toMatchObject({
    models: [model],
    thinkingLevel: "high",
    thinkingLevels: levels,
  });
  answer();
});

it("does not redraw when the read confirms the cache", async () => {
  chip().onclick!();
  await vi.waitFor(() => expect(picker.modelPicker).toHaveBeenCalledTimes(1));
  chip().onclick!();
  // Cache draw only: the identical answer must not replace the list under a
  // typed search.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(picker.modelPicker).toHaveBeenCalledTimes(2);
});

it("keeps the cached list and reports the failure when the read fails", async () => {
  chip().onclick!();
  await vi.waitFor(() => expect(picker.modelPicker).toHaveBeenCalledTimes(1));
  vi.mocked(api.mustGetJson).mockRejectedValue(new Error("offline"));
  const { appendTurn } = await import("./chat.js");
  chip().onclick!();
  await vi.waitFor(() =>
    expect(appendTurn).toHaveBeenCalledWith("error", expect.stringContaining("model options are stale"))
  );
  expect(picker.modelPicker).toHaveBeenCalledTimes(2);
});


// Pi clamps the level to the model being left: the level picked in the selector
// is applied again after the switch, and the header shows what Pi kept.
it("re-applies the selector's reasoning level after a model switch and shows what Pi returns", async () => {
  const other: ModelRef = { provider: "test", id: "other" };
  const reply = (body: unknown) => ({ ok: true, json: async () => body }) as Response;
  vi.mocked(api.sendJson).mockImplementation(async (url: string) =>
    url.endsWith("/model") ? reply({ model: other, thinkingLevel: "low" }) : reply({ level: "high" }));
  chip().onclick!();
  await vi.waitFor(() => expect(picker.modelPicker).toHaveBeenCalledTimes(1));
  const props = vi.mocked(picker.modelPicker).mock.lastCall![0];
  props.onThinkingPick("low");
  props.onThinkingPick("high");
  vi.mocked(api.sendJson).mockClear();
  props.onPick(other);
  await vi.waitFor(() => expect(api.sendJson).toHaveBeenCalledTimes(2));
  expect(vi.mocked(api.sendJson).mock.calls).toEqual([
    ["/api/sessions/s1/model", other],
    ["/api/sessions/s1/thinking", { level: "high" }],
  ]);
  await vi.waitFor(() => expect(chips().map((c) => c.textContent)).toEqual([other.id, "high"]));
});

it("shows the reasoning level the model switch came back with", async () => {
  const other: ModelRef = { provider: "test", id: "other" };
  let level: () => void = () => {};
  vi.mocked(api.sendJson).mockImplementation(async (url: string) =>
    url.endsWith("/model")
      ? ({ ok: true, json: async () => ({ model: other, thinkingLevel: "low" }) }) as Response
      // The level write is still on the wire: the header already reads the switch's answer.
      : new Promise<Response>((resolve) => { level = () => resolve({ ok: true, json: async () => ({ level: "high" }) } as Response); }));
  chip().onclick!();
  await vi.waitFor(() => expect(picker.modelPicker).toHaveBeenCalledTimes(1));
  vi.mocked(picker.modelPicker).mock.lastCall![0].onPick(other);
  await vi.waitFor(() => expect(chips().map((c) => c.textContent)).toEqual([other.id, "low"]));
  level();
  await vi.waitFor(() => expect(chips().map((c) => c.textContent)).toEqual([other.id, "high"]));
});

it("keeps the level picked in the selector when a read that left before it redraws the picker", async () => {
  chip().onclick!();
  await vi.waitFor(() => expect(picker.modelPicker).toHaveBeenCalledTimes(1));
  const other: ModelRef = { provider: "test", id: "other" };
  const answers: (() => void)[] = [];
  vi.mocked(api.mustGetJson).mockImplementation((url: string) =>
    new Promise((resolve) => {
      answers.push(() => resolve((url.endsWith("/models") ? [model, other] : { level: "high", levels }) as never));
    }));
  vi.mocked(api.sendJson).mockResolvedValue({ ok: true, json: async () => ({ level: "low" }) } as Response);
  chip().onclick!();
  vi.mocked(picker.modelPicker).mock.lastCall![0].onThinkingPick("low");
  for (const answer of answers) answer();
  await vi.waitFor(() => expect(picker.modelPicker).toHaveBeenCalledTimes(3));
  expect(vi.mocked(picker.modelPicker).mock.lastCall![0]).toMatchObject({ models: [model, other], thinkingLevel: "low" });
});
