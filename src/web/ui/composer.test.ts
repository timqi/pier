// Real queue controls with deferred HTTP, drawn into the shell's own markup.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { button, fake, installPage, type FakeDocument, type FakeElement } from "./dom.testkit.js";

const state = vi.hoisted(() => ({
  appendTurn: vi.fn(), fetch: vi.fn(), reload: vi.fn(), id: "a" as string | null, visible: true,
  observed: [] as (ResizeObserverOptions | undefined)[],
}));
vi.mock("./chat.js", () => ({
  appendTurn: state.appendTurn, followTail: vi.fn(), scrollBottom: vi.fn(), turnsPane: {},
}));
vi.mock("./attachments.js", () => ({ imageThumb: () => document.createElement("img") }));
vi.mock("./shortcut.js", () => ({ escapeKey: vi.fn(), letterKey: vi.fn() }));

const node = (selector: string): FakeElement => fake(document.querySelector(selector));
/** The nodes on screen right now: a redraw replaces them even when it reads the same. */
const onScreen = (selector: string): FakeElement[] => [...node(selector).children];
const same = (before: FakeElement[], after: FakeElement[]): boolean =>
  before.length === after.length && before.every((el, i) => el === after[i]);

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
let doc: FakeDocument;
let drafts: Map<string, string>;
let stored: Map<string, string>;
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  state.id = "a"; state.visible = true; state.observed = [];
  drafts = new Map();
  stored = new Map();
  vi.stubGlobal("window", {});
  doc = installPage();
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
  if (control === "recall") node("#queue-recall").onclick!();
  else {
    composer.renderRecovery([{ id: "batch", steering: ["original"], followUp: [], status: "uncertain" }]);
    void button(doc.body, "Acknowledge")!.onclick!();
  }
}

function type(text: string): void {
  const input = node("#input");
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
    const rows = onScreen("#queue-rows");
    const panel = node("#queue-panel").className;
    const input = node("#input");
    const height = input.style.height;
    await finish([" steer\nline ", "", "follow up\n"]);
    expect(input.value).toBe(" B draft \n");
    expect(drafts.get("pier.draft.b")).toBe(" B draft \n");
    expect(input.style.height).toBe(height);
    expect(doc.activeElement).not.toBe(input);
    expect(same(rows, onScreen("#queue-rows"))).toBe(true);
    expect(node("#queue-panel").className).toBe(panel);
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
    const rows = onScreen("#queue-rows");
    await finish(["recalled"]);
    const input = node("#input");
    expect(input.value).toBe(" edited A \n\nrecalled");
    expect(doc.activeElement).not.toBe(input);
    expect(same(rows, onScreen("#queue-rows"))).toBe(true);
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
    expect(node("#input").value).toBe(expected);
    expect(drafts.get("pier.draft.a")).toBe(expected);
    expect(doc.activeElement).toBe(node("#input"));
    expect(onScreen("#queue-rows")).toEqual([]);
  });

  it("does not resurrect text sent while recall was pending", async () => {
    type("sent draft");
    const finish = await recallPending("body");
    state.fetch.mockResolvedValueOnce(Response.json({}));
    await composer.send("auto");
    expect(drafts.has("pier.draft.a")).toBe(false);
    type("next draft");
    await finish(["recalled"]);
    expect(node("#input").value).toBe("next draft\nrecalled");
    expect(state.fetch.mock.calls[1]?.[0]).toBe("/api/sessions/a/messages");
  });

  it("checkpoints A before createSession removes its selection", async () => {
    node("#input").value = "A unsaved input";
    const finish = await recallPending("fetch");
    state.id = null;
    type("new session input");
    await finish(["recalled"]);
    expect(node("#input").value).toBe("new session input");
    expect(doc.activeElement).not.toBe(node("#input"));
    select("a");
    expect(node("#input").value).toBe("A unsaved input\nrecalled");
  });

  it("retains selected recalled text in the input when storage fills up", async () => {
    type("draft");
    const finish = await recallPending("body");
    vi.spyOn(sessionStorage, "setItem").mockImplementation(() => { throw new Error("quota exceeded"); });
    await finish([" first\n", "second"]);
    expect(node("#input").value).toBe("draft\n first\n\nsecond");
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
    const rows = onScreen("#queue-rows");
    vi.spyOn(sessionStorage, method).mockImplementation(() => { throw new Error("storage unavailable"); });
    await finish([" first\n", "second"]);
    expect(node("#input").value).toBe("B draft");
    expect(doc.activeElement).not.toBe(node("#input"));
    expect(same(rows, onScreen("#queue-rows"))).toBe(true);
    expect(drafts.get("pier.draft.a")).toBe("A draft");
    expect(drafts.get("pier.draft.b")).toBe("B draft");
    expect(state.appendTurn).toHaveBeenCalledWith("error",
      "Could not save recalled messages for session a: Error: storage unavailable\nRecalled messages (not saved):\n first\n\nsecond");
  });

  it.each([{ messages: [] }, { messages: ["recalled"] }])("preserves a newer authoritative queue for response $messages", async ({ messages }) => {
    const finish = await recallPending("body");
    composer.renderQueue([], ["new queue"]);
    const rows = onScreen("#queue-rows");
    await finish(messages);
    expect(same(rows, onScreen("#queue-rows"))).toBe(true);
  });

  it("keeps an empty response from changing the draft or focus", async () => {
    type("unchanged");
    const finish = await recallPending("body");
    await finish([]);
    expect(node("#input").value).toBe("unchanged");
    expect(doc.activeElement).not.toBe(node("#input"));
  });

  it.each(["focus", "view"])("does not steal focus after a %s change", async (change) => {
    const finish = await recallPending("body");
    if (change === "view") state.visible = false;
    else node("#send").focus();
    await finish(["recalled"]);
    expect(node("#input").value).toBe("recalled");
    expect(doc.activeElement).not.toBe(node("#input"));
  });

  it("coalesces same-session clicks through body parsing and allows the next recall", async () => {
    const finish = await recallPending("body");
    click("recall");
    composer.renderRecovery([], true);
    button(doc.body, "Recall queue")!.onclick!();
    expect(state.fetch).toHaveBeenCalledOnce();
    await finish(["first"]);
    const next = await recallPending("fetch");
    await next(["second"]);
    expect(node("#input").value).toBe("first\nsecond");
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
    expect(node("#input").value).toBe("B\nB recalled");
    expect(drafts.get("pier.draft.a")).toBe("A\nA recalled");
    expect(state.fetch.mock.calls.map(([url]) => url)).toEqual([
      "/api/sessions/a/queue/recall", "/api/sessions/b/queue/recall",
    ]);
  });
});

// A `--after` task message is its sender's to cancel: shown, never recalled.
describe("parked task messages", () => {
  const parked = [{ messageId: "m1", runName: "review worker", text: "then run the tests" }];

  it("shows parked rows by run name with no queue actions when they are all there is", () => {
    composer.renderQueue([], [], parked);
    expect(node("#queue-panel").classList.contains("hidden")).toBe(false);
    expect(node("#queue-rows").textContent).toBe("after this turn · review workerthen run the tests");
    expect(node("#queue-label").textContent).toBe("Queued");
    expect(node("#queue-actions").classList.contains("hidden")).toBe(true);
  });

  it("counts them beside Pi's queue and keeps them across its queue-state events", () => {
    composer.renderQueue([], ["mine"], parked);
    expect(node("#queue-label").textContent).toBe("Queued · 2");
    expect(node("#queue-actions").classList.contains("hidden")).toBe(false);
    composer.renderQueue([], []);
    expect(onScreen("#queue-rows")).toHaveLength(1);
    expect(node("#queue-actions").classList.contains("hidden")).toBe(true);
    composer.dropParked("m1");
    expect(node("#queue-panel").classList.contains("hidden")).toBe(true);
  });
});

describe("queue control failures", () => {
  it("offers the existing recall action from an empty acknowledged pause notice", async () => {
    composer.renderQueue([], []);
    composer.renderRecovery([], true);
    expect(doc.body.textContent).toContain("Automatic queue paused: acceptance unknown (in memory)");
    const recall = button(doc.body, "Recall queue")!;
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
    const rows = onScreen("#queue-rows");
    state.fetch.mockResolvedValueOnce(Response.json({ error: "Queue operation in progress" }, { status: 409 }));
    click("recall");
    await settled();
    expect(node("#input").value).toBe("draft");
    expect(same(rows, onScreen("#queue-rows"))).toBe(true);
    const finish = await recallPending("fetch");
    await finish(["queued"]);
    expect(node("#input").value).toBe("draft\nqueued");
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
    node("#input").onpaste!({
      clipboardData: {
        items: [{ kind: "file", getAsFile: () => ({ name, size: 4, type: "image/png" }) }],
        getData: () => "",
      },
    });
  };
  const staged = (): number => node("#image-strip").childElementCount;

  it("uploads a file as it is attached, so Enter does not wait on it", () => {
    state.fetch.mockResolvedValueOnce(Response.json({ path: "/inbox/shot.png" }));
    paste("shot.png");
    expect(state.fetch.mock.calls.map(([url]) => url)).toEqual(["/api/inbox"]);
  });

  it("leaves a session's staged files where they were when it comes back", () => {
    state.fetch.mockResolvedValue(Response.json({ path: "/inbox/x.png" }));
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

it("ends the optimistic turn a continuous command never starts", async () => {
  const setState = vi.fn();
  composer.initComposer({
    sessionId: () => "m1", starting: () => false, sessionState: () => "idle",
    chatVisible: () => true, setState, reload: state.reload, continuous: () => true,
  });
  state.fetch.mockResolvedValueOnce(Response.json({ sessionId: "m1", command: "status" }, { status: 202 }));
  type("/status");
  await composer.send("auto");
  expect(state.fetch.mock.calls[0]?.[0]).toBe("/api/continuous/messages");
  expect(setState.mock.calls).toEqual([["streaming"], ["idle"]]);
  // A message is a turn: its own events end it.
  state.fetch.mockResolvedValueOnce(Response.json({ sessionId: "m1" }, { status: 202 }));
  type("hello");
  await composer.send("auto");
  expect(setState.mock.calls).toEqual([["streaming"], ["idle"], ["streaming"]]);
});

describe("the chat-command completion", () => {
  const menu = () => node("#command-menu");
  const rows = () => onScreen("#command-menu").map((li) => li.textContent);
  const key = (init: Partial<KeyboardEvent>) => {
    const ev = { preventDefault: vi.fn(), ...init } as unknown as KeyboardEvent;
    node("#input").onkeydown!(ev);
    return ev;
  };
  const continuous = (on: boolean) => composer.initComposer({
    sessionId: () => "m1", starting: () => false, sessionState: () => "idle",
    chatVisible: () => true, setState: vi.fn(), reload: state.reload, continuous: () => on,
  });

  it("lists every command with its line at a bare `/`, narrows on the prefix, hides on the exact word", () => {
    continuous(true);
    expect(menu().classList.contains("hidden")).toBe(true);
    type("/");
    expect(menu().classList.contains("hidden")).toBe(false);
    expect(rows()).toEqual(["/statuswhat is open — in flight, or waiting on you", "/newstart a new session now", "/stopstop the reply in progress"]);
    expect(onScreen("#command-menu")[0]!.getAttribute("aria-selected")).toBe("true");
    type("/st");
    expect(rows()).toEqual(["/statuswhat is open — in flight, or waiting on you", "/stopstop the reply in progress"]);
    type("/stop");
    expect(rows()).toEqual([]);
    expect(menu().classList.contains("hidden")).toBe(true);
    type("/stop now");
    expect(rows()).toEqual([]);
    type("status");
    expect(rows()).toEqual([]);
  });

  it("walks with the arrows, picks with Enter or Tab into the draft, and Enter then sends", async () => {
    continuous(true);
    type("/");
    const down = key({ key: "ArrowDown" });
    expect(down.preventDefault).toHaveBeenCalled();
    expect(onScreen("#command-menu").map((li) => li.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
    key({ key: "ArrowUp" });
    key({ key: "ArrowUp" });
    expect(onScreen("#command-menu")[2]!.getAttribute("aria-selected")).toBe("true");
    const enter = key({ key: "Enter" });
    expect(enter.preventDefault).toHaveBeenCalled();
    expect(node("#input").value).toBe("/stop");
    expect(menu().classList.contains("hidden")).toBe(true);
    expect(state.fetch).not.toHaveBeenCalled();
    state.fetch.mockResolvedValueOnce(Response.json({ sessionId: "m1", command: "stop" }, { status: 202 }));
    key({ key: "Enter" });
    await settled();
    expect(state.fetch.mock.calls[0]?.[0]).toBe("/api/continuous/messages");
    type("/n");
    key({ key: "Tab" });
    expect(node("#input").value).toBe("/new");
    // A pointer picks too, without blurring the textarea.
    type("/");
    onScreen("#command-menu")[0]!.onpointerdown!({ preventDefault: vi.fn() });
    expect(node("#input").value).toBe("/status");
  });

  it("closes on Esc until the draft changes, and never opens outside the continuous conversation", () => {
    continuous(true);
    type("/");
    key({ key: "Escape" });
    expect(menu().classList.contains("hidden")).toBe(true);
    expect(key({ key: "ArrowDown" }).preventDefault).not.toHaveBeenCalled(); // the textarea's key again
    type("/s");
    expect(rows()).toHaveLength(2);
    continuous(false);
    type("/");
    expect(rows()).toEqual([]);
  });

  const skills = [
    { name: "pier-tasks", description: "Delegate work to a run." },
    { name: "pier-boards", description: "Publish a Board." },
  ];

  it("lists the chain commands, then every skill with its description, as one list", () => {
    continuous(true);
    composer.setSkills(skills);
    type("/");
    expect(rows()).toEqual([
      "/statuswhat is open — in flight, or waiting on you", "/newstart a new session now", "/stopstop the reply in progress",
      "/skill:pier-tasksDelegate work to a run.", "/skill:pier-boardsPublish a Board.",
    ]);
    type("/s");
    expect(rows()).toEqual(["/statuswhat is open — in flight, or waiting on you", "/stopstop the reply in progress",
      "/skill:pier-tasksDelegate work to a run.", "/skill:pier-boardsPublish a Board."]);
    // The exact chain word hides the list, skills that would match included.
    composer.setSkills([{ name: "stop-all", description: "x" }]);
    type("/stop");
    expect(rows()).toEqual([]);
  });

  it("matches a skill by its name alone, and never takes its full word as exact", () => {
    continuous(true);
    composer.setSkills(skills);
    type("/pier-t");
    expect(rows()).toEqual(["/skill:pier-tasksDelegate work to a run."]);
    type("/skill:pier-b");
    expect(rows()).toEqual(["/skill:pier-boardsPublish a Board."]);
    type("/skill:pier-boards");
    expect(rows()).toEqual(["/skill:pier-boardsPublish a Board."]);
  });

  it("fills a skill with a trailing space that closes the list for the ask", () => {
    continuous(true);
    composer.setSkills(skills);
    type("/pier-b");
    key({ key: "Enter" });
    expect(node("#input").value).toBe("/skill:pier-boards ");
    expect(menu().classList.contains("hidden")).toBe(true);
    expect(state.fetch).not.toHaveBeenCalled();
    type("/pier");
    onScreen("#command-menu")[0]!.onpointerdown!({ preventDefault: vi.fn() });
    expect(node("#input").value).toBe("/skill:pier-tasks ");
  });

  it("offers skills outside the continuous conversation, and nothing when there are none", () => {
    continuous(false);
    composer.setSkills(skills);
    type("/");
    expect(rows()).toEqual(["/skill:pier-tasksDelegate work to a run.", "/skill:pier-boardsPublish a Board."]);
    type("/status");
    expect(rows()).toEqual([]);
    composer.setSkills([]);
    type("/");
    expect(rows()).toEqual([]);
    expect(menu().classList.contains("hidden")).toBe(true);
  });
});
