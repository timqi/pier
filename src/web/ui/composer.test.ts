// Real queue controls with deferred HTTP; only DOM rendering is replaced.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class Element {
  value = "";
  style = { height: "" };
  scrollHeight = 24;
  children: Element[] = [];
  onclick: (() => void | Promise<void>) | null = null;
  classList = { toggle: vi.fn() };
  focus = vi.fn();
  constructor(readonly text = "") {}
  append(...children: Element[]) { this.children.push(...children); }
  prepend(...children: Element[]) { this.children.unshift(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  after() {}
  get childElementCount() { return this.children.length; }
}

const state = vi.hoisted(() => ({
  nodes: new Map<string, Element>(), created: [] as Element[],
  appendTurn: vi.fn(), fetch: vi.fn(), reload: vi.fn(), id: "a",
}));
vi.mock("./dom.js", () => ({
  $: (selector: string) => {
    if (!state.nodes.has(selector)) state.nodes.set(selector, new Element());
    return state.nodes.get(selector);
  },
  h: (_tag: string, _classes: string, text?: string) => {
    const el = new Element(text); state.created.push(el); return el;
  },
  copyBtn: () => new Element(),
}));
vi.mock("./chat.js", () => ({
  appendTurn: state.appendTurn, followTail: vi.fn(), scrollBottom: vi.fn(), turnsPane: {},
}));
vi.mock("./attachments.js", () => ({ imageThumb: vi.fn() }));
vi.mock("./shortcut.js", () => ({ escapeKey: vi.fn(), letterKey: vi.fn() }));

const settled = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
let composer: typeof import("./composer.js");
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  state.nodes.clear(); state.created = []; state.id = "a";
  vi.stubGlobal("window", {});
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal("fetch", state.fetch);
  vi.stubGlobal("localStorage", { setItem: vi.fn(), removeItem: vi.fn() });
  composer = await import("./composer.js");
  composer.initComposer({
    sessionId: () => state.id, starting: () => false, sessionState: () => "idle",
    chatVisible: () => true, setState: vi.fn(), reload: state.reload,
  });
});
afterEach(() => vi.unstubAllGlobals());

function click(control: "recall" | "ack"): void {
  if (control === "recall") state.nodes.get("#queue-recall")!.onclick!();
  else {
    composer.renderRecovery([{ id: "batch", steering: ["original"], followUp: [], status: "uncertain" }]);
    void state.created.find((el) => el.text === "Acknowledge")!.onclick!();
  }
}

describe("queue control failures", () => {
  it("offers the existing recall action from an empty acknowledged pause notice", async () => {
    composer.renderQueue([], []);
    composer.renderRecovery([], true);
    expect(state.created.some((el) => el.text === "Automatic queue paused: acceptance unknown (in memory)")).toBe(true);
    const recall = state.created.find((el) => el.text === "Recall queue")!;
    state.fetch.mockResolvedValueOnce(Response.json({ messages: [] }));
    recall.onclick!();
    await settled();
    expect(state.fetch).toHaveBeenCalledWith("/api/sessions/a/queue/recall", { method: "POST" });
    expect(state.appendTurn).not.toHaveBeenCalled();
  });
  it.each(["recall", "ack"] as const)("shows the %s conflict reason", async (control) => {
    state.fetch.mockResolvedValueOnce(Response.json({ error: "Queue operation in progress" }, { status: 409 }));
    click(control);
    await settled();
    expect(state.appendTurn).toHaveBeenCalledWith("error", "Queue operation in progress");
  });

  it.each(["recall", "ack"] as const)("does not put a delayed %s error body in another session", async (control) => {
    let finish!: (value: unknown) => void;
    const json = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    state.fetch.mockResolvedValueOnce({ ok: false, json });
    click(control);
    await settled();
    expect(json).toHaveBeenCalledOnce();
    state.id = "b";
    finish({ error: "Queue operation in progress" });
    await settled();
    expect(state.appendTurn).not.toHaveBeenCalled();
    expect(state.reload).not.toHaveBeenCalled();
  });
});
