// Reopening the model picker must not wait on the network: the catalog and the
// model's reasoning levels are cached, so the second open draws before the read
// that reconciles it.
import { beforeEach, expect, it, vi } from "vitest";
import type { ModelRef, ThinkingLevel } from "../../core/types.js";
import type { SessionInfo } from "./sidebar.js";

interface Node {
  tag: string;
  children: (Node | string)[];
  isConnected: boolean;
  onclick: (() => void) | null;
  classList: { toggle: () => void; add: () => void };
  title: string;
  textContent: string;
  closest: () => null;
  setAttribute: () => void;
  attrs: Record<string, boolean>;
  toggleAttribute: (name: string, on: boolean) => void;
  append: (...kids: (Node | string)[]) => void;
  replaceChildren: (...kids: (Node | string)[]) => void;
  replaceWith: (next: Node) => void;
}

const state = vi.hoisted(() => ({ roots: [] as unknown[], nodes: 0 }));

const node = (tag: string, ...children: unknown[]): Node => {
  state.nodes++;
  const self: Node = {
    tag,
    children: children as (Node | string)[],
    isConnected: true,
    onclick: null,
    classList: { toggle: () => {}, add: () => {} },
    title: "",
    textContent: "",
    closest: () => null,
    setAttribute: () => {},
    attrs: {},
    toggleAttribute: (name, on) => {
      self.attrs[name] = on;
    },
    append: (...kids) => self.children.push(...kids),
    replaceChildren: (...kids) => {
      self.children = kids;
    },
    replaceWith: () => {},
  };
  return self;
};

vi.mock("./dom.js", () => ({
  $: () => {
    const el = node("div");
    state.roots.push(el);
    return el;
  },
  h: (tag: string, _cls: string, ...kids: unknown[]) => node(tag, ...kids),
  agoLabel: () => "",
  basename: () => "",
  copyBtn: () => node("button"),
  stampTime: () => "",
  untitled: () => "untitled",
}));
vi.mock("./icons.js", () => ({ icon: () => node("svg") }));
vi.mock("./api.js", () => ({ mustGetJson: vi.fn(), sendJson: vi.fn() }));
vi.mock("./chat.js", () => ({ appendTurn: vi.fn(), revealActiveRun: vi.fn(() => true) }));
vi.mock("./menu.js", () => ({ closeMenu: vi.fn(), openMenu: vi.fn(), openPanel: vi.fn() }));
vi.mock("./model-picker.js", () => ({ modelPicker: vi.fn(() => node("div")) }));
vi.mock("./shortcut.js", () => ({ chord: vi.fn(), chordLabel: () => "", modalOpen: vi.fn() }));
vi.mock("./sidebar.js", () => ({
  renameSession: vi.fn(),
  // Marked so the chip's title proves it uses the rail's words, which
  // sidebar.test.ts owns, rather than spelling its own second copy.
  runsLabel: (runs: number) => `RUNS(${runs})`,
}));

const model: ModelRef = { provider: "test", id: "test-model" };
const levels: ThinkingLevel[] = ["low", "high"];

/** What the orchestrator's list says about the selected session. */
let current: SessionInfo | undefined;

let header: typeof import("./session-header.js");
let picker: typeof import("./model-picker.js");
let api: typeof import("./api.js");

/** Buttons in the meta row, in render order: the running chip when there is
 *  one, then the model chip that opens the picker. */
function chips(): Node[] {
  const meta = state.roots[2] as Node;
  return meta.children.filter((c): c is Node => typeof c !== "string" && c.tag === "button");
}

/** The model chip — the first button when no run is in flight (model, then
 *  reasoning), the button that opens the picker. */
function chip(): Node {
  const button = chips()[0];
  if (!button) throw new Error("no model chip rendered");
  return button;
}

const session = (activeRuns: number): SessionInfo =>
  ({ id: "s1", cwd: "/tmp", createdAt: 0, state: "idle", unread: false, channel: "web", activeRuns });

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  state.roots = [];
  current = undefined;
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
  });
  vi.mocked(api.mustGetJson).mockImplementation((url: string) =>
    Promise.resolve(url.endsWith("/models") ? [model] : { level: "high", levels }) as never
  );
  header.setHeaderState(model, null, "high", null);
});

// Below md the chips cost the bar a line, so only the row that has to be seen
// without opening anything keeps it (style.css reads the mark).
it("marks the meta row urgent only once the context is near full", () => {
  const meta = () => state.roots[2] as Node;
  const usage = { contextWindow: 100_000, tokens: 20_000 };
  header.setHeaderState(model, usage, "high", null);
  expect(meta().attrs["data-urgent"]).toBe(false);
  header.setHeaderState(model, { ...usage, tokens: 75_000 }, "high", null);
  expect(meta().attrs["data-urgent"]).toBe(true);
});

// A background run is the other kind of "nothing happening": the card sits far
// up the transcript, so the chip is the count and the way back to it.
it("shows a running chip that reveals the newest card, and keeps the row urgent", async () => {
  const meta = () => state.roots[2] as Node;
  expect(chips()).toHaveLength(2); // model + reasoning
  current = session(2);
  header.setHeaderState(model, null, "high", null);
  const running = chips()[0]!;
  expect(running.children).toContain("2 running");
  expect(running.title).toBe("RUNS(2) · show the newest");
  expect(meta().attrs["data-urgent"]).toBe(true);

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
  expect(meta().attrs["data-urgent"]).toBe(false);
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
