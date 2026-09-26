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
vi.mock("./shortcut.js", () => ({ chord: vi.fn(), chordLabel: (key: string) => `⌘${key.toUpperCase()}`, modalOpen: vi.fn() }));
const drawer = vi.hoisted(() => ({ head: undefined as unknown, openStatus: vi.fn() }));
vi.mock("./drawer.js", () => ({
  headSession: () => drawer.head,
  phaseTag: (s: SessionInfo) => (s.phase ? [Object.assign(document.createElement("span"), { textContent: s.phase })] : []),
  stateDot: () => [document.createElement("i")],
  openStatus: drawer.openStatus,
  // Marked so the chip's title proves it uses the drawer's words, which
  // drawer.test.ts owns, rather than spelling its own second copy.
}));
const palette = vi.hoisted(() => ({ togglePalette: vi.fn() }));
vi.mock("./palette.js", () => palette);

const model: ModelRef = { provider: "test", id: "test-model" };
const levels: ThinkingLevel[] = ["low", "high"];

const openSettings = vi.fn();
const openContinuous = vi.fn();

/** What the orchestrator's list says about the selected session. */
let current: SessionInfo | undefined;
/** The continuous conversation is on screen. */
let conversation = false;

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
    openContinuous,
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
});

// The conversation rotates sessions and spans topics: the header names it as
// its own name, whatever the head was titled; every other session keeps its own.
it("titles the continuous conversation Conversation, other sessions by their own title", () => {
  const title = () => fake(document.querySelector("#chat-title")).textContent;
  current = { ...session(0), title: "Worker展示功能" };
  header.renderHeader();
  expect(title()).toBe("Worker展示功能");
  conversation = true;
  header.renderHeader();
  expect(title()).toBe("Conversation");
  // Before its first session exists there is no row to title it either.
  current = undefined;
  header.renderHeader();
  expect(title()).toBe("Conversation");
});

const title = () => fake(document.querySelector("#chat-title"));
const back = () => fake(document.querySelector("#bar-back"));

async function menuItems() {
  const { openMenu } = await import("./menu.js");
  fake(document.querySelector("#chat-menu")).onclick?.();
  return vi.mocked(openMenu).mock.lastCall![1];
}

it("offers Search first on the conversation, and the rest without it on a child", async () => {
  conversation = true;
  current = session(0);
  header.renderHeader();
  const items = await menuItems();
  expect(items.map((i) => i.label)).toEqual(["Search", "Status", "Session info", "Browse files", "Model & reasoning…", "Settings"]);
  expect(items[0]!.hint).toBe("⌘K");
  items[0]!.onSelect();
  expect(palette.togglePalette).toHaveBeenCalledOnce();
  items[1]!.onSelect();
  expect(drawer.openStatus).toHaveBeenCalledOnce();
  items[5]!.onSelect();
  expect(openSettings).toHaveBeenCalledOnce();

  conversation = false;
  header.renderHeader();
  expect((await menuItems()).map((i) => i.label)).toEqual(["Status", "Session info", "Browse files", "Model & reasoning…", "Settings"]);
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
  expect(byLabel("Model & reasoning…")).toMatchObject({ disabled: true, hint: "after the first reply" });
  expect(byLabel("Search").disabled).toBeUndefined();
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
  expect(openContinuous).toHaveBeenCalledOnce();

  conversation = true;
  header.renderHeader();
  expect(back().classList.contains("hidden")).toBe(true);
  expect(fake(document.querySelector("#chat-phase")).textContent).toBe("");
});

// Subagents are the status chip's count (drawer.ts): the meta row is model,
// reasoning and context only, and a phone shows it just for a context near full.
it("keeps the meta row to model, reasoning and context, urgent only under context pressure", () => {
  current = session(2);
  header.setHeaderState(model, null, "high", null);
  expect(chips().map((c) => c.textContent)).toEqual([model.id, "high"]);
  expect(meta().hasAttribute("data-urgent")).toBe(false);
  header.setHeaderState(model, { contextWindow: 1_000_000, tokens: 90_000, compactAt: 100_000 }, "high", null);
  expect(meta().hasAttribute("data-urgent")).toBe(true);
});

// The conversation's model is the default and never moves: its bar reads the
// context in full, inline at every width, and ⋯ keeps the model picker.
it("shows only the context, used/compactAt, on the conversation's bar", () => {
  conversation = true;
  current = session(0);
  header.setHeaderState(model, { contextWindow: 1_000_000, tokens: 52_000, compactAt: 160_000 }, "high", null);
  expect(chips()).toHaveLength(0);
  expect(meta().textContent).toBe("52k/160k");
  expect(meta().hasAttribute("data-inline")).toBe(true);
  conversation = false;
  header.renderHeader();
  expect(chips().map((c) => c.textContent)).toEqual([model.id, "high"]);
  expect(meta().hasAttribute("data-inline")).toBe(false);
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
