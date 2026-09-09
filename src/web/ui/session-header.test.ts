// Reopening the model picker must not wait on the network: the catalog and the
// model's reasoning levels are cached, so the second open draws before the read
// that reconciles it.
import { beforeEach, expect, it, vi } from "vitest";
import type { ModelRef, ThinkingLevel } from "../../core/types.js";

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
vi.mock("./chat.js", () => ({ appendTurn: vi.fn() }));
vi.mock("./menu.js", () => ({ closeMenu: vi.fn(), openMenu: vi.fn(), openPanel: vi.fn() }));
vi.mock("./model-picker.js", () => ({ modelPicker: vi.fn(() => node("div")) }));
vi.mock("./shortcut.js", () => ({ chord: vi.fn(), chordLabel: () => "", modalOpen: vi.fn() }));
vi.mock("./sidebar.js", () => ({ renameSession: vi.fn() }));

const model: ModelRef = { provider: "test", id: "test-model" };
const levels: ThinkingLevel[] = ["low", "high"];

let header: typeof import("./session-header.js");
let picker: typeof import("./model-picker.js");
let api: typeof import("./api.js");

/** The model chip in the meta row — the button that opens the picker. */
function chip(): Node {
  const meta = state.roots[2] as Node;
  const button = meta.children.find((c): c is Node => typeof c !== "string" && c.tag === "button");
  if (!button) throw new Error("no model chip rendered");
  return button;
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  state.roots = [];
  header = await import("./session-header.js");
  picker = await import("./model-picker.js");
  api = await import("./api.js");
  header.initHeader({
    currentId: () => "s1",
    currentSession: () => undefined,
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
