// Real queue controls with deferred HTTP; only DOM rendering is replaced.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class Element {
  value = "";
  style = { height: "" };
  scrollHeight = 24;
  children: Element[] = [];
  onclick: (() => void | Promise<void>) | null = null;
  oninput: (() => void) | null = null;
  onpaste: ((ev: unknown) => void) | null = null;
  classList = { toggle: vi.fn() };
  focus = vi.fn();
  setAttribute = vi.fn();
  constructor(readonly text = "") {}
  append(...children: Element[]) { this.children.push(...children); }
  prepend(...children: Element[]) { this.children.unshift(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  after() {}
  get childElementCount() { return this.children.length; }
}

const state = vi.hoisted(() => ({
  nodes: new Map<string, Element>(), created: [] as Element[],
  appendTurn: vi.fn(), fetch: vi.fn(), reload: vi.fn(), id: "a" as string | null, visible: true,
  observed: [] as (ResizeObserverOptions | undefined)[],
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
vi.mock("./icons.js", () => ({ icon: () => ({}) })); // lucide wants a real document
vi.mock("./shortcut.js", () => ({ escapeKey: vi.fn(), letterKey: vi.fn() }));

const settled = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
/** Enough of the Storage interface for a draft: the migration enumerates it. */
const storage = (entries: Map<string, string>) => ({
  getItem: (key: string) => entries.get(key) ?? null,
  setItem: (key: string, value: string) => entries.set(key, value),
  removeItem: (key: string) => entries.delete(key),
  key: (i: number) => [...entries.keys()][i] ?? null,
  get length() { return entries.size; },
});

let composer: typeof import("./composer.js");
let drafts: Map<string, string>;
let stored: Map<string, string>;
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  state.nodes.clear(); state.created = []; state.id = "a"; state.visible = true; state.observed = [];
  drafts = new Map();
  stored = new Map();
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", { activeElement: null });
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal("ResizeObserver", class {
    observe(_el: unknown, options?: ResizeObserverOptions) { state.observed.push(options); }
  });
  // A pasted screenshot: the reader hands back a data URL, synchronously here.
  vi.stubGlobal("FileReader", class {
    onload: (() => void) | null = null;
    result = "data:image/png;base64,AAAA";
    readAsDataURL() { this.onload?.(); }
  });
  vi.stubGlobal("fetch", state.fetch);
  // Drafts live in sessionStorage: a board's script shares this origin but
  // never this tab.
  vi.stubGlobal("sessionStorage", storage(drafts));
  vi.stubGlobal("localStorage", storage(stored));
  composer = await import("./composer.js");
  composer.initComposer({
    sessionId: () => state.id, starting: () => false, sessionState: () => "idle",
    chatVisible: () => state.visible, setState: vi.fn(), reload: state.reload,
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function click(control: "recall" | "ack"): void {
  if (control === "recall") state.nodes.get("#queue-recall")!.onclick!();
  else {
    composer.renderRecovery([{ id: "batch", steering: ["original"], followUp: [], status: "uncertain" }]);
    void state.created.find((el) => el.text === "Acknowledge")!.onclick!();
  }
}

function type(text: string): void {
  const input = state.nodes.get("#input")!;
  input.value = text;
  input.oninput!();
}

function select(id: string): void {
  composer.saveDraft();
  state.id = id;
  composer.restoreDraft(id);
  composer.renderQueue([], []);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function recallPending(stage: "fetch" | "body") {
  const response = deferred<Response>();
  const body = deferred<{ messages: string[] }>();
  const json = vi.fn(() => body.promise);
  state.fetch.mockReturnValueOnce(stage === "fetch" ? response.promise : Promise.resolve({ ok: true, json }));
  click("recall");
  await settled();
  if (stage === "body") expect(json).toHaveBeenCalledOnce();
  return async (messages: string[]) => {
    if (stage === "fetch") response.resolve(Response.json({ messages }));
    else body.resolve({ messages });
    await settled();
  };
}

// A content-box round is not delivered for a padding-only change, and the
// composer's bottom padding is the home-indicator inset the keyboard drops and
// pays back — measured that way, --dock-h stayed 34px short and the last
// transcript row sat under the input pill.
it("measures the dock's parts as border-box", () => {
  expect(state.observed.length).toBe(3);
  expect(state.observed).toEqual(state.observed.map(() => ({ box: "border-box" })));
});

// A board's page is active content on this origin (boards/boards.ts), so
// localStorage is readable by a script the agent wrote; a tab-scoped store is not.
it("keeps an unsent draft out of localStorage", () => {
  type("unsent operator secret");
  expect(drafts.get("pier.draft.a")).toBe("unsent operator secret");
  expect([...stored.keys()]).toEqual([]);
});

// A workbench upgraded mid-draft: what the old build wrote is still readable by
// a board's script, so the first load after it takes the drafts along and clears
// them. Only drafts — the other pier.* preferences belong in localStorage.
it("moves drafts left in localStorage into this tab and deletes them", async () => {
  stored.set("pier.draft.a", "pre-upgrade secret");
  stored.set("pier.draft.b", "another one");
  stored.set("pier.filesPrefs", "{}");
  drafts.set("pier.draft.b", "typed in this tab");

  vi.resetModules();
  composer = await import("./composer.js");
  composer.initComposer({
    sessionId: () => state.id, starting: () => false, sessionState: () => "idle",
    chatVisible: () => state.visible, setState: vi.fn(), reload: state.reload,
  });

  expect([...stored.keys()]).toEqual(["pier.filesPrefs"]);
  expect(drafts.get("pier.draft.a")).toBe("pre-upgrade secret");
  // The tab's own draft is the newer one and survives the move.
  expect(drafts.get("pier.draft.b")).toBe("typed in this tab");
});

describe("queue recall drafts", () => {
  it.each(["fetch", "body"] as const)("returns delayed %s messages to A without touching B", async (stage) => {
    type(" A draft \n");
    composer.renderQueue(["old queue"], []);
    const finish = await recallPending(stage);
    select("b");
    type(" B draft \n");
    composer.renderQueue([], ["B queue"]);
    const rows = state.nodes.get("#queue-rows")!.children;
    const toggles = state.nodes.get("#queue-panel")!.classList.toggle.mock.calls.length;
    const input = state.nodes.get("#input")!;
    const height = input.style.height;
    await finish([" steer\nline ", "", "follow up\n"]);
    expect(input.value).toBe(" B draft \n");
    expect(drafts.get("pier.draft.b")).toBe(" B draft \n");
    expect(input.style.height).toBe(height);
    expect(input.focus).not.toHaveBeenCalled();
    expect(state.nodes.get("#queue-rows")!.children).toBe(rows);
    expect(state.nodes.get("#queue-panel")!.classList.toggle).toHaveBeenCalledTimes(toggles);
    select("a");
    expect(input.value).toBe(" A draft \n\n steer\nline \n\nfollow up\n");
    select("b");
    select("a");
    expect(input.value).toBe(" A draft \n\n steer\nline \n\nfollow up\n");
  });

  it.each(["fetch", "body"] as const)("merges latest A input once after A-B-A during delayed %s", async (stage) => {
    type("original");
    const finish = await recallPending(stage);
    select("b");
    type("B stays");
    select("a");
    type(" edited A \n");
    composer.renderQueue([], ["new A queue"]);
    const rows = state.nodes.get("#queue-rows")!.children;
    await finish(["recalled"]);
    const input = state.nodes.get("#input")!;
    expect(input.value).toBe(" edited A \n\nrecalled");
    expect(input.focus).not.toHaveBeenCalled();
    expect(state.nodes.get("#queue-rows")!.children).toBe(rows);
    select("b");
    expect(input.value).toBe("B stays");
    select("a");
    expect(input.value).toBe(" edited A \n\nrecalled");
  });

  it.each(["typed meanwhile", "", " \n"])("uses the current edited draft %j in the same session", async (latest) => {
    type("old draft");
    composer.renderQueue(["recalled"], []);
    const finish = await recallPending("body");
    type(latest);
    await finish(["recalled", "second\nline"]);
    const expected = `${latest ? `${latest}\n` : ""}recalled\nsecond\nline`;
    expect(state.nodes.get("#input")!.value).toBe(expected);
    expect(drafts.get("pier.draft.a")).toBe(expected);
    expect(state.nodes.get("#input")!.focus).toHaveBeenCalledOnce();
    expect(state.nodes.get("#queue-rows")!.children).toEqual([]);
  });

  it("does not resurrect text sent while recall was pending", async () => {
    type("sent draft");
    const finish = await recallPending("body");
    state.fetch.mockResolvedValueOnce(Response.json({}));
    await composer.send("auto");
    expect(drafts.has("pier.draft.a")).toBe(false);
    type("next draft");
    await finish(["recalled"]);
    expect(state.nodes.get("#input")!.value).toBe("next draft\nrecalled");
    expect(state.fetch.mock.calls[1]?.[0]).toBe("/api/sessions/a/messages");
  });

  it("checkpoints A before createSession removes its selection", async () => {
    state.nodes.get("#input")!.value = "A unsaved input";
    const finish = await recallPending("fetch");
    state.id = null;
    type("new session input");
    await finish(["recalled"]);
    expect(state.nodes.get("#input")!.value).toBe("new session input");
    expect(state.nodes.get("#input")!.focus).not.toHaveBeenCalled();
    select("a");
    expect(state.nodes.get("#input")!.value).toBe("A unsaved input\nrecalled");
  });

  it("retains selected recalled text in the input when storage fills up", async () => {
    type("draft");
    const finish = await recallPending("body");
    vi.spyOn(sessionStorage, "setItem").mockImplementation(() => { throw new Error("quota exceeded"); });
    await finish([" first\n", "second"]);
    expect(state.nodes.get("#input")!.value).toBe("draft\n first\n\nsecond");
    expect(drafts.get("pier.draft.a")).toBe("draft");
    expect(state.appendTurn).toHaveBeenCalledWith("error",
      "Could not save recalled messages for session a: Error: quota exceeded\nRecalled messages (not saved):\n first\n\nsecond");
  });

  it.each(["getItem", "setItem"] as const)("shows an unsaved recovery copy if offscreen storage %s fails", async (method) => {
    type("A draft");
    const finish = await recallPending("body");
    select("b");
    type("B draft");
    composer.renderQueue([], ["B queue"]);
    const rows = state.nodes.get("#queue-rows")!.children;
    vi.spyOn(sessionStorage, method).mockImplementation(() => { throw new Error("storage unavailable"); });
    await finish([" first\n", "second"]);
    expect(state.nodes.get("#input")!.value).toBe("B draft");
    expect(state.nodes.get("#input")!.focus).not.toHaveBeenCalled();
    expect(state.nodes.get("#queue-rows")!.children).toBe(rows);
    expect(drafts.get("pier.draft.a")).toBe("A draft");
    expect(drafts.get("pier.draft.b")).toBe("B draft");
    expect(state.appendTurn).toHaveBeenCalledWith("error",
      "Could not save recalled messages for session a: Error: storage unavailable\nRecalled messages (not saved):\n first\n\nsecond");
  });

  it.each([{ messages: [] }, { messages: ["recalled"] }])("preserves a newer authoritative queue for response $messages", async ({ messages }) => {
    const finish = await recallPending("body");
    composer.renderQueue([], ["new queue"]);
    const rows = state.nodes.get("#queue-rows")!.children;
    await finish(messages);
    expect(state.nodes.get("#queue-rows")!.children).toBe(rows);
  });

  it("keeps an empty response from changing the draft or focus", async () => {
    type("unchanged");
    const finish = await recallPending("body");
    await finish([]);
    expect(state.nodes.get("#input")!.value).toBe("unchanged");
    expect(state.nodes.get("#input")!.focus).not.toHaveBeenCalled();
  });

  it.each(["focus", "view"])("does not steal focus after a %s change", async (change) => {
    const finish = await recallPending("body");
    if (change === "view") state.visible = false;
    else Object.assign(document, { activeElement: new Element() });
    await finish(["recalled"]);
    expect(state.nodes.get("#input")!.value).toBe("recalled");
    expect(state.nodes.get("#input")!.focus).not.toHaveBeenCalled();
  });

  it("coalesces same-session clicks through body parsing and allows the next recall", async () => {
    const finish = await recallPending("body");
    click("recall");
    composer.renderRecovery([], true);
    state.created.find((el) => el.text === "Recall queue")!.onclick!();
    expect(state.fetch).toHaveBeenCalledOnce();
    await finish(["first"]);
    const next = await recallPending("fetch");
    await next(["second"]);
    expect(state.nodes.get("#input")!.value).toBe("first\nsecond");
    expect(state.fetch).toHaveBeenCalledTimes(2);
  });

  it("allows different sessions to recall concurrently and finish out of order", async () => {
    type("A");
    const finishA = await recallPending("body");
    select("b");
    type("B");
    const finishB = await recallPending("fetch");
    await finishB(["B recalled"]);
    await finishA(["A recalled"]);
    expect(state.nodes.get("#input")!.value).toBe("B\nB recalled");
    expect(drafts.get("pier.draft.a")).toBe("A\nA recalled");
    expect(state.fetch.mock.calls.map(([url]) => url)).toEqual([
      "/api/sessions/a/queue/recall", "/api/sessions/b/queue/recall",
    ]);
  });
});

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

  it("allows retry after a failed recall without changing draft or queue", async () => {
    type("draft");
    composer.renderQueue([], ["queued"]);
    const rows = state.nodes.get("#queue-rows")!.children;
    state.fetch.mockResolvedValueOnce(Response.json({ error: "Queue operation in progress" }, { status: 409 }));
    click("recall");
    await settled();
    expect(state.nodes.get("#input")!.value).toBe("draft");
    expect(state.nodes.get("#queue-rows")!.children).toBe(rows);
    const finish = await recallPending("fetch");
    await finish(["queued"]);
    expect(state.nodes.get("#input")!.value).toBe("draft\nqueued");
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

describe("pending attachments", () => {
  const paste = (name: string): void => {
    state.nodes.get("#input")!.onpaste!({
      clipboardData: {
        items: [{ kind: "file", getAsFile: () => ({ name, size: 4, type: "image/png" }) }],
        getData: () => "",
      },
    });
  };
  const staged = (): number => state.nodes.get("#image-strip")!.children.length;

  it("leaves a session's staged files where they were when it comes back", () => {
    paste("shot.png");
    paste("other.png");
    expect(staged()).toBe(2);
    select("b");
    expect(staged()).toBe(0);
    paste("b.png");
    expect(staged()).toBe(1);
    select("a");
    expect(staged()).toBe(2);
  });
});
