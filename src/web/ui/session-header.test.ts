// Reopening the model picker must not wait on the network: the catalog and the
// model's reasoning levels are cached, so the second open draws before the read
// that reconciles it.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ModelRef, ThinkingLevel } from "../../core/types.js";
import type { SessionInfo } from "./sidebar.js";
import { fake, installPage, type FakeElement } from "./dom.testkit.js";

const meta = (): FakeElement => fake(document.querySelector("#session-meta"));

vi.mock("./menu.js", () => ({
  closeMenu: vi.fn(), openMenu: vi.fn(),
  // A panel is on screen once opened: the header checks before drawing into it.
  openPanel: vi.fn((_anchor: HTMLElement, panel: HTMLElement) => { if (!panel.isConnected) document.body.append(panel); }),
}));
vi.mock("./api.js", () => ({ mustGetJson: vi.fn(), sendJson: vi.fn() }));
vi.mock("./chat.js", () => ({ appendTurn: vi.fn(), revealActiveRun: vi.fn(() => true) }));
vi.mock("./model-picker.js", () => ({ modelPicker: vi.fn(() => document.createElement("div")) }));
vi.mock("./shortcut.js", () => ({ chord: vi.fn(), chordLabel: () => "", modalOpen: vi.fn() }));
vi.mock("./sidebar.js", () => ({
  renameSession: vi.fn(),
  // Marked so the chip's title proves it uses the rail's words, which
  // sidebar.test.ts owns, rather than spelling its own second copy.
  runsLabel: (runs: number) => `RUNS(${runs})`,
}));

const model: ModelRef = { provider: "test", id: "test-model" };
const levels: ThinkingLevel[] = ["low", "high"];

const closeSession = vi.fn();

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
  header = await import("./session-header.js");
  picker = await import("./model-picker.js");
  api = await import("./api.js");
  header.initHeader({
    currentId: () => "s1",
    currentSession: () => current,
    createSession: vi.fn(),
    syncBar: vi.fn(),
    openFiles: vi.fn(),
    toggleFiles: vi.fn(),
    closeSession,
    inConversation: (id) => id === "head",
    continuousOpen: () => conversation,
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
    header.sessionInfo(document.createElement("button"), { id: "s1", cwd: "/tmp", createdAt: 0 });
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
// the rail does, whatever the head was titled; every other session keeps its own.
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

// Close sits after Rename and is handed to the orchestrator, which owns the
// list it optimistically edits. The conversation's sessions are not managed:
// no Rename, Close or Continue in… on them.
it("offers Close after Rename, and neither nor Continue in… on the continuous conversation", async () => {
  const { openMenu } = await import("./menu.js");
  const items = (s: SessionInfo) => {
    header.sessionMenu(document.createElement("button"), s);
    return vi.mocked(openMenu).mock.lastCall![1];
  };
  const own = items(session(0));
  expect(own.map((i) => i.label).slice(0, 2)).toEqual(["Rename…", "Close"]);
  expect(own[1]).toMatchObject({ hint: "leaves the rail; a message reopens it" });
  expect(own[1]!.disabled).toBeUndefined();
  own[1]!.onSelect();
  expect(closeSession).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }));
  expect(own.map((i) => i.label)).toContain("Continue in Lark/Slack…");
  expect(items({ ...session(0), id: "head" }).map((i) => i.label))
    .toEqual(["Session info", "Browse files", "Model & reasoning…"]);
});

// A background run is the other kind of "nothing happening": the card sits far
// up the transcript, so the chip is the count and the way back to it.
it("shows a running chip that reveals the newest card, and keeps the row urgent", async () => {
  expect(chips()).toHaveLength(2); // model + reasoning
  current = session(2);
  header.setHeaderState(model, null, "high", null);
  const running = chips()[0]!;
  expect(running.textContent).toBe("2 running");
  expect(running.title).toBe("RUNS(2) · show the newest");
  expect(meta().hasAttribute("data-urgent")).toBe(true);

  const { appendTurn, revealActiveRun } = await import("./chat.js");
  running.onclick!();
  expect(revealActiveRun).toHaveBeenCalled();
  expect(appendTurn).not.toHaveBeenCalled();

  // Counted by the server, drawn from this pane: no card means say so.
  vi.mocked(revealActiveRun).mockReturnValue(false);
  chips()[0]!.onclick!();
  expect(appendTurn).toHaveBeenCalledWith("error", expect.stringContaining("no run card"));

  current = undefined;
  header.setHeaderState(model, null, "high", null);
  expect(chips()).toHaveLength(2);
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
