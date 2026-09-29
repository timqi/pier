// System rows on index.html: the `/status` card opens its runs' sessions, and
// seeds, callbacks, delegations and run cards fold to one line that opens in place.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SystemInputOrigin } from "../../core/types.js";
import { fake, installPage, type FakeDocument, type FakeElement } from "./dom.testkit.js";

let doc: FakeDocument;
let chat: typeof import("./chat.js");

// A reply renders through marked; the sanitizer and the highlighter want a real DOM.
vi.mock("dompurify", () => ({ default: { sanitize: (html: string) => html } }));
vi.mock("./highlight.js", () => ({ highlightCode: async () => {} }));
const select = vi.fn();
/** The browser's remembered choices (the Show work toggle). */
const stored = new Map<string, string>();
const quote = vi.fn();

beforeEach(async () => {
  vi.resetModules();
  select.mockClear();
  doc = installPage();
  // Only the tail-follow uses them, and the fake DOM has no layout to follow.
  for (const name of ["ResizeObserver", "MutationObserver"]) vi.stubGlobal(name, class { observe(): void {} });
  stored.clear();
  vi.stubGlobal("localStorage", { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => stored.set(k, v) });
  chat = await import("./chat.js");
  chat.initChat({
    sessionId: () => "h1", sessionCwd: () => null, sessionChannel: () => "web", sessionState: () => "idle",
    select, send: vi.fn(), ownTurn: vi.fn(), reload: vi.fn(async () => {}), quote,
  });
  quote.mockClear();
});

afterEach(() => vi.unstubAllGlobals());

const text = [
  "Open",
  "- open items 视图 — lead designing · run 1prwmabc… running 23m · workers: 1 running",
  "- model menu — merged · run gone1 — not in the ledger · run short running 1m",
].join("\n");
const origin: SystemInputOrigin = { kind: "chat-command", command: "status", sessions: { "1prwmabcdefghijk": "s-lead", short: "s-short" } };
const card = () => doc.querySelector("#turns")!.querySelectorAll("[data-kind='system']").at(-1)!;
const links = () => card().querySelectorAll("button").filter((b) => b.textContent.startsWith("run "));

it("links every run token whose session the answer carries, and leaves the rest as text", () => {
  chat.appendSystemInput(text, origin);
  expect(card().textContent).toContain("/status");
  expect(card().textContent).toContain(text);
  expect(links().map((b) => b.textContent)).toEqual(["run 1prwmabc…", "run short"]);
  links()[0]!.onclick?.();
  expect(select).toHaveBeenLastCalledWith("s-lead");
  links()[1]!.onclick?.();
  expect(select).toHaveBeenLastCalledWith("s-short");
});

it("draws the same links from a reloaded transcript, and none for an answer without the map", () => {
  chat.renderSnapshot([{ role: "system", text, origin, at: 1 }], "idle", []);
  expect(links().map((b) => b.textContent)).toEqual(["run 1prwmabc…", "run short"]);
  chat.appendSystemInput(text, { kind: "chat-command", command: "status" });
  expect(links()).toEqual([]);
  expect(card().textContent).toContain(text);
});

const toggle = () => card().querySelector("button[aria-expanded]")!;
/** The collapsed line: what a sighted reader sees with the body hidden. */
const line = () => toggle().textContent;
const body = () => card().children.at(-1)!;
const model = { provider: "anthropic", id: "claude-x" };

it("folds a session seed to its reason and the previous session's id", () => {
  chat.appendSystemInput("Memory\n\nlast exchanges…", { kind: "session-seed", reason: "idle", previousSessionId: "prev1234abcd" });
  expect(card().classList.contains("system-row")).toBe(true);
  expect(line()).toBe("session seedidle");
  expect(card().querySelector(".run-session")!.textContent).toBe("prev1234");
  expect(body().hidden).toBe(true);
});

it("shows a callback without the language stamp the model reads", () => {
  chat.appendSystemInput('[lang=zh]\nTask "fix it" finished with state: succeeded\nrun r1\n\nAll green.', {
    kind: "task-callback", taskId: "t1", runId: "run45678xyz", sourceSessionId: "s-run", state: "succeeded",
  });
  // No source of its own: the caption is the first line, which the stamp must not be.
  expect(line()).toBe('callback · succeededTask "fix it" finished with state: succeeded');
  expect(card().textContent).not.toContain("lang=zh");
});

it("folds a callback to state, name, model and run id, and opens and closes on its button", () => {
  chat.appendSystemInput('Task "fix it" finished with state: succeeded\nrun r1\n\nAll green.', {
    kind: "task-callback", taskId: "t1", runId: "run45678xyz", sourceSessionId: "s-run",
    source: { taskName: "fix it", tier: "balanced", model, thinking: "high" }, state: "succeeded",
  });
  // The model is quiet text after the name, inside the toggle (below md, its own line under the label).
  expect(line()).toBe("callback · succeededfix itbalancedclaude-xhigh");
  expect(card().querySelector(".run-id")!.textContent).toBe("run45678");
  // One badge, `tier · id · level`: the stylesheet draws the dots between its parts.
  const badge = toggle().querySelector(".run-model")!;
  expect([...badge.children].map((part) => [part.className, part.textContent]))
    .toEqual([["run-tier", "balanced"], ["run-model-id", "claude-x"], ["run-thinking", "high"]]);
  expect(badge.getAttribute("title")).toBe("Tier balanced · anthropic / claude-x · Reasoning high");
  expect(body().textContent).toBe("All green.");
  expect(toggle().localName).toBe("button"); // Enter and Space are the browser's
  expect(toggle().getAttribute("type")).toBe("button");
  toggle().onclick?.();
  expect(card().hasAttribute("data-expanded")).toBe(true);
  expect(toggle().getAttribute("aria-expanded")).toBe("true");
  expect(body().hidden).toBe(false);
  card().querySelector(".run-session")!.onclick?.();
  expect(select).toHaveBeenLastCalledWith("s-run");
  toggle().onclick?.();
  expect(card().hasAttribute("data-expanded")).toBe(false);
  expect(body().hidden).toBe(true);
});

it("keeps a failed callback's reason on the line, in the state's colour", () => {
  chat.appendSystemInput('Task "deploy" finished with state: failed\nrun r2\n\n\nprovider 529: overloaded\nstack…', {
    kind: "task-callback", taskId: "t2", runId: "run2", sourceSessionId: null, source: { taskName: "deploy" }, state: "failed",
  });
  expect(line()).toBe("callback · faileddeployprovider 529: overloaded");
  expect(card().querySelector(".run-model")).toBeNull(); // nothing recorded, no empty badge
  expect(toggle().querySelector(".run-label")!.classList.contains("text-red-600")).toBe(true);
  chat.appendSystemInput("x\n\n", {
    kind: "task-callback", taskId: "t3", runId: "run3", sourceSessionId: null, source: { taskName: "probe" }, state: "interrupted",
  });
  expect(line()).toBe("callback · interruptedprobeinterrupted");
  expect(toggle().querySelector(".run-label")!.classList.contains("text-amber-700")).toBe(true);
});

it("folds a delegation and a task message to name and run id; a command answer stays open", () => {
  chat.appendSystemInput("Task: review\n\nRead the diff.", { kind: "task-delegation", taskId: "t4", runId: "run4abcdefg", sourceSessionId: "s-lead" });
  expect(line()).toBe("delegationTask: review");
  expect(card().querySelector(".run-id")!.textContent).toBe("run4abcd");
  chat.appendSystemInput("steer text", {
    kind: "task-message", taskId: "t5", runId: "run5", sourceSessionId: "s5", messageId: "m", messageKind: "follow_up", source: { taskName: "lead" },
  });
  expect(line()).toBe("follow uplead");
  chat.appendSystemInput("Started a new session.", { kind: "chat-command", command: "new" });
  expect(card().classList.contains("system-row")).toBe(false);
  expect(card().querySelector("button[aria-expanded]")).toBeNull();
  expect(body().hidden).toBe(false);
  expect(card().getAttribute("data-kind")).toBe("system");
});

it("folds a run card like a callback, and a status update keeps it open", async () => {
  const run = {
    runId: "qvv3qbffxyz", taskId: "t6", taskName: "IM conversation", state: "running" as const, targetSessionId: "s-run6",
    sessionMode: "fresh" as const, prompt: "Build per the design doc.", queuedAt: 1, startedAt: 1, finishedAt: null, queuedMessages: 0,
    model, thinking: "medium" as const,
  };
  const { renderBackgroundRun } = await import("./turn-activity.js");
  renderBackgroundRun(run);
  const runCard = () => doc.querySelector("#turns")!.querySelectorAll("[data-kind='background-run']").at(-1)!;
  const runToggle = () => runCard().querySelector("button[aria-expanded]")!;
  expect(runCard().classList.contains("system-row")).toBe(true);
  expect(runToggle().textContent).toBe("run · runningIM conversationclaude-xmedium");
  expect(runCard().querySelector(".run-model")!.textContent).toBe("claude-xmedium");
  expect(runCard().children.at(-1)!.hidden).toBe(true);
  runToggle().onclick?.();
  expect(runCard().hasAttribute("data-expanded")).toBe(true);
  renderBackgroundRun({ ...run, state: "succeeded", finishedAt: 142_001 });
  expect(runToggle().textContent).toBe("run · succeededIM conversationclaude-xmedium");
  expect(runToggle().getAttribute("aria-expanded")).toBe("true");
  expect(runCard().children.at(-1)!.hidden).toBe(false);
  expect(runCard().children.at(-1)!.textContent).toBe("Build per the design doc.");
});

it("names a run card by its session once there is one, and by the run id until then", async () => {
  const run = {
    runId: "ykt7hre3nzenaweb", taskId: "t7", taskName: "Pier 产品简化合并", state: "queued" as const, targetSessionId: null,
    sessionMode: "fresh" as const, prompt: "研究一下", queuedAt: 1, startedAt: null, finishedAt: null, queuedMessages: 0,
  };
  const { renderBackgroundRun } = await import("./turn-activity.js");
  renderBackgroundRun(run);
  const runCard = () => doc.querySelector("#turns")!.querySelectorAll("[data-kind='background-run']").at(-1)!;
  expect(runCard().querySelector(".run-id")!.textContent).toBe("ykt7hre3");
  expect(runCard().querySelector(".run-session")).toBeNull();
  renderBackgroundRun({ ...run, state: "running", targetSessionId: "s7abcdef1234", startedAt: 2 });
  const session = runCard().querySelector(".run-session")!;
  expect(session.localName).toBe("button");
  expect(session.textContent).toBe("s7abcdef");
  session.onclick?.();
  expect(select).toHaveBeenLastCalledWith("s7abcdef1234");
});

it("replays a refused prompt as the user's row and the reason", () => {
  chat.renderSnapshot([
    { role: "user", text: "hello" },
    { role: "assistant", text: "", error: "No API key found for anthropic" },
  ], "idle", []);
  const rows = doc.querySelector("#turns")!.querySelectorAll("[data-kind]");
  expect(rows.map((r) => [r.dataset.kind, r.textContent])).toEqual([
    ["user", "hello"],
    ["error", "No API key found for anthropic"],
  ]);
});

it("keeps the prior answer's buttons when the turn after it failed", () => {
  chat.renderSnapshot([
    { role: "assistant", text: "Done.\n\n---\n[Ship it] | [Wait]" },
    { role: "user", text: "Ship it" },
    { role: "assistant", text: "", error: "overloaded" },
  ], "idle", []);
  const buttons = doc.querySelector("#turns")!.querySelectorAll("button").map((b) => b.textContent).filter(Boolean);
  expect(buttons).toEqual(["Ship it", "Wait"]);
});

// A snapshot re-arms tail follow; a page of history above the reader must not
// leave it armed, or the next repin takes them to the newest row.
it("keeps a reader put above the tail after a re-render, and follows one who was at it", () => {
  const pane = doc.querySelector("#turns")!;
  Object.defineProperties(pane, { scrollHeight: { value: 2000 }, clientHeight: { value: 500 } });
  chat.renderSnapshot([{ role: "user", text: "hello" }], "idle", []);
  expect(pane.scrollTop).toBe(2000);
  chat.keepScroll(1990);
  expect(pane.scrollTop).toBe(10);
  chat.scrollBottom();
  expect(pane.scrollTop).toBe(10);
  chat.keepScroll(500);
  pane.scrollTop = 1500;
  chat.scrollBottom();
  expect(pane.scrollTop).toBe(2000);
});

describe("file references", () => {
  /** Answers the existence check from `onDisk`, recording every path asked. */
  const disk = (onDisk: string[]): string[][] => {
    const asked: string[][] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url !== "/api/fs/exists") return Response.json({ error: "unexpected" }, { status: 404 });
      const { paths } = JSON.parse(String(init?.body)) as { paths: string[] };
      asked.push(paths);
      return Response.json({ exists: paths.map((p) => onDisk.includes(p)) });
    }));
    return asked;
  };
  const codes = (root: FakeElement) => root.querySelectorAll("code") as unknown as HTMLElement[];
  const refs = (root: FakeElement | HTMLElement) => codes(root as FakeElement).filter((c) => c.classList.contains("fileref")).map((c) => c.title);

  it("resolves a reply's relative paths against its session's cwd, and links only what exists", async () => {
    const asked = disk(["/w/main/src/a.ts"]);
    // A reply's code spans as renderMarkdown hands them over.
    const { renderFileRefs } = await import("./attachments.js");
    const reply = doc.createElement("div");
    reply.innerHTML = "<p>See <code>src/a.ts:3</code> and <code>gone.ts</code> and <code>~/x.md</code>.</p>";
    renderFileRefs(codes(reply), "h1", ["/w/main"]);
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    // One request for the whole reply; `~` with no home to expand to is never asked.
    expect(asked[0]).toEqual(["/w/main/src/a.ts", "/w/main/gone.ts"]);
    await vi.waitFor(() => expect(refs(reply)).toEqual(["/w/main/src/a.ts:3"]));
  });

  it("falls back to the cwds earlier callbacks carried, most recent first, when the session's own has nothing", async () => {
    const asked = disk(["/w/main/src/a.ts", "/w/one/src/b.ts", "/w/two/src/b.ts", "/w/one/src/c.ts"]);
    const deps = { sessionId: () => "h1", sessionCwd: () => "/w/main" as string | null, sessionChannel: () => "web", sessionState: () => "idle" as const, select, send: vi.fn(), ownTurn: vi.fn(), reload: vi.fn(async () => {}), quote };
    chat.initChat(deps);
    const callback = (cwd: string) => chat.appendSystemInput("Task \"t\" finished with state: succeeded\n\nok", {
      kind: "task-callback", taskId: "t1", runId: "r1", sourceSessionId: "s", source: { taskName: "t" }, state: "succeeded", cwd,
    });
    callback("/w/one");
    callback("/w/two");
    callback("/w/one");
    const reply = chat.appendTurn("assistant", "See `src/a.ts`, `src/b.ts:2`, `src/c.ts` and `src/d.ts`.", true);
    await vi.waitFor(() => expect(refs(reply)).toEqual(["/w/main/src/a.ts", "/w/one/src/b.ts:2", "/w/one/src/c.ts"]));
    // One request for the reply: every candidate of every path, the session's own cwd first.
    expect(asked).toEqual([[
      "/w/main/src/a.ts", "/w/one/src/a.ts", "/w/two/src/a.ts",
      "/w/main/src/b.ts", "/w/one/src/b.ts", "/w/two/src/b.ts",
      "/w/main/src/c.ts", "/w/one/src/c.ts", "/w/two/src/c.ts",
      "/w/main/src/d.ts", "/w/one/src/d.ts", "/w/two/src/d.ts",
    ]]);
    // Another session's transcript starts with no callbacks of its own.
    chat.resetChat();
    deps.sessionCwd = () => null;
    const fresh = chat.appendTurn("assistant", "See `src/b.ts`.", true);
    await new Promise((r) => setTimeout(r, 5));
    expect(refs(fresh)).toEqual([]);
    expect(asked).toHaveLength(1);
  });

  it("resolves a callback's paths against the child's cwd, never the recipient's", async () => {
    const asked = disk(["/w/child/src/config-sync.ts", "/tmp/run.log"]);
    const text = 'Task "sync" finished with state: succeeded\nRun: r1\n\nFixed `src/config-sync.ts:239`; log at `/tmp/run.log`, not `res.text`.';
    chat.appendSystemInput(text, {
      kind: "task-callback", taskId: "t1", runId: "r1", sourceSessionId: "s-child",
      source: { taskName: "sync" }, state: "succeeded", cwd: "/w/child",
    });
    const callback = card();
    await vi.waitFor(() => expect(refs(callback)).toEqual(["/w/child/src/config-sync.ts:239", "/tmp/run.log"]));
    expect(asked.flat()).toEqual(["/w/child/src/config-sync.ts", "/tmp/run.log"]);
    // The body still reads as the child wrote it, backticks included.
    expect(body().textContent).toBe(text.slice(text.indexOf("\n\n") + 2));
    expect(codes(callback).map((c) => c.textContent)).toEqual(["src/config-sync.ts:239", "/tmp/run.log"]);
  });

  it("leaves a batch callback's relative paths plain: no one cwd is theirs", async () => {
    const asked = disk(["/tmp/run.log", "/w/main/src/a.ts"]);
    chat.appendSystemInput("2 task callbacks\n\n`src/a.ts` and `/tmp/run.log`", {
      kind: "task-callback", taskId: "t1", runId: "r1", sourceSessionId: null, runIds: ["r1", "r2"],
    });
    await vi.waitFor(() => expect(refs(card())).toEqual(["/tmp/run.log"]));
    expect(asked.flat()).toEqual(["/tmp/run.log"]);
  });
});

describe("the reply quote", () => {
  const noon = new Date(2024, 5, 1, 12, 0, 0).getTime();
  const pane = () => doc.querySelector("#turns")!;
  const tools = (row: FakeElement) => row.querySelector(".message-tools")!.querySelectorAll("button").map((b) => b.getAttribute("aria-label"));

  it("offers Reply on every chat row and Edit only on the head's user rows", () => {
    const user = fake(chat.appendTurn("user", "hi", false, noon).parentElement);
    const reply = fake(chat.appendTurn("assistant", "Merged.\n<topic>auth</topic>", true, noon + 1000).parentElement);
    expect(tools(user)).toEqual(["Edit message", "Reply to this message"]);
    expect(tools(reply)).toEqual(["Reply to this message"]);
    fake(reply.querySelector(".message-tools")!.querySelector("button")).onclick!();
    // The raw text, marker and all: the source's topic paints the quote.
    expect(quote).toHaveBeenCalledWith({ role: "assistant", at: noon + 1000, text: "Merged.\n<topic>auth</topic>" });
    chat.renderSnapshot([{ role: "user", text: "old", at: noon }], "idle", [], true);
    expect(tools(fake(pane().querySelectorAll("[data-kind='user']").at(-1)))).toEqual(["Reply to this message"]);
  });

  it("draws the quote over the reply's own words and a click reveals the source", () => {
    const reply = fake(chat.appendTurn("assistant", "Merged.\n<topic>auth</topic>\n\nNext: deploy.", true, noon).parentElement);
    const stored = "[operator<web> 12:01]\n[re assistant 2024-06-01 12:00]\n> Merged.\n> <topic>auth</topic>\n>\n> Next: deploy.\n\nship it";
    const user = fake(chat.appendTurn("user", stored, false, noon + 60_000).parentElement);
    const block = fake(user.querySelector(".quote-block"));
    expect(block.textContent).toBe("assistant · 12:00Merged.\nNext: deploy.");
    expect(block.style.getPropertyValue("--topic")).toMatch(/^oklch/);
    expect(fake(user.querySelector(".whitespace-pre-wrap")).textContent).toBe("ship it");
    // Editing resends the quote with the words.
    expect(fake(user.querySelector(".whitespace-pre-wrap")).dataset.raw).toBe(stored);
    block.onclick!();
    expect(reply.dataset.reveal).toBe("");
  });

  it("quotes a user row's shown words, header and markers off, and finds the source by them", () => {
    const stored = "[qiqi<U1> 2024-06-01 12:00 lang=zh]\n看一下";
    const user = fake(chat.appendTurn("user", stored, false, noon).parentElement);
    fake(user.querySelector("[data-reply]")).onclick!();
    expect(quote).toHaveBeenCalledWith({ role: "user", at: noon, text: "看一下" });
    const reply = fake(chat.appendTurn("user", "[re user 2024-06-01 12:00]\n> 看一下\n\n好", false, noon + 60_000).parentElement);
    fake(reply.querySelector(".quote-block")).onclick!();
    expect(user.dataset.reveal).toBe("");
  });

  it("offers Reply only once the row has a time to name", () => {
    chat.renderSnapshot([
      { role: "assistant", text: "Cut off." },
      { role: "assistant", text: "Done.", meta: { completedAt: noon, durationMs: 1, tokens: 1 } },
    ], "idle", []);
    const [cut, done] = pane().querySelectorAll("[data-reply]");
    expect(cut!.hidden).toBe(true);
    expect(done!.hidden).toBe(false);
  });

  it("stays inert when the source is not on screen", () => {
    const user = fake(chat.appendTurn("user", "[re user 2024-06-01 11:00]\n> gone\n\nok", false, noon).parentElement);
    const block = fake(user.querySelector(".quote-block"));
    block.onclick!();
    expect(pane().querySelector("[data-reveal]")).toBeNull();
    expect(block.title).toMatch(/Not on this screen/);
  });
});

describe("turn cards", () => {
  const pane = () => doc.querySelector("#turns")!;
  const kinds = () => pane().children.map((r) => r.dataset.kind);
  const card = () => pane().querySelectorAll("[data-kind='turn']").at(-1)!;
  const inCard = () => card().children.map((r) => r.dataset.kind);
  const run = (runId: string, over: Partial<import("../../core/types.js").BackgroundRun> = {}) => ({
    runId, taskId: "t", taskName: runId, state: "running" as const, targetSessionId: null, sessionMode: "fresh" as const,
    prompt: "go", queuedAt: 1, startedAt: 1, finishedAt: null, queuedMessages: 0, ...over,
  });
  const callback = (runId: string, state: "succeeded" | "failed" = "succeeded") => chat.appendSystemInput("done\n\nok", {
    kind: "task-callback", taskId: "t", runId, sourceSessionId: null, source: { taskName: runId }, state,
  });
  const steps = [{ kind: "tool" as const, id: "c1", toolName: "bash", args: {}, done: true }];
  let activity: typeof import("./turn-activity.js");
  beforeEach(async () => {
    activity = await import("./turn-activity.js");
  });

  it("tags an `<open>` reply and the user message above it; a `<done>` marks the topic done", async () => {
    const topics = await import("./topics.js");
    chat.renderSnapshot([
      { role: "user", text: "review auth please", at: 1 },
      { role: "assistant", text: "On it.\n<open>auth review — worker running</open>" },
      { role: "user", text: "and later", at: 2 },
      { role: "assistant", text: "Merged.\n<done>auth review</done>" },
      { role: "user", text: "thanks", at: 3 },
      { role: "assistant", text: "Welcome." },
    ], "idle", []);
    const [u1, a1, u2, a2, u3, a3] = pane().children.filter((r) => r.dataset.kind !== "time");
    for (const r of [u1, a1, u2, a2]) expect(r!.dataset.topic).toBe("auth review");
    expect(a1!.querySelector(".topic-tag")!.textContent).toBe("auth review");
    expect(a1!.textContent).not.toContain("<open>");
    for (const r of [u3, a3]) expect(r!.dataset.topic).toBeUndefined();
    expect(topics.seenTopics()).toEqual([{ problem: "auth review", done: true }]);
    // The filter keeps the topic's rows and hides the rest.
    topics.setTopicFilter("auth review");
    expect([u1, a1, u2, a2, u3, a3].map((r) => r!.hidden)).toEqual([false, false, false, false, true, true]);
    chat.resetChat();
    expect(topics.topicFilter()).toBeNull();
    expect(topics.seenTopics()).toEqual([]);
  });

  it("keeps a reply visible inside its card whatever the filter, and a card takes the topic of a reply tagged first", async () => {
    const topics = await import("./topics.js");
    chat.appendTurn("user", "go", false, 1);
    chat.completeTurn("On it.\n<open>auth</open>", { completedAt: 2, durationMs: 1, tokens: 1 });
    topics.setTopicFilter("auth");
    // The card of a reply about something else arrives live, and its reply with it.
    chat.appendTurn("user", "and this", false, 3);
    callback("r1");
    chat.completeTurn("Other.\n<topic>deploy</topic>", { completedAt: 4, durationMs: 1, tokens: 1 });
    expect(card().dataset.topic).toBe("deploy");
    expect(card().hidden).toBe(false);
    expect(card().querySelector("[data-kind='assistant']")!.hidden).toBe(false);
    // Switching the filter hides the card, never a row inside it.
    topics.setTopicFilter(null);
    topics.setTopicFilter("auth");
    expect(card().hidden).toBe(true);
    expect(card().querySelector("[data-kind='assistant']")!.hidden).toBe(false);
    topics.setTopicFilter(null);
    // A bare tagged reply gets its card only when a run lands after it.
    chat.appendTurn("user", "more", false, 5);
    chat.completeTurn("Later.\n<topic>docs</topic>", { completedAt: 6, durationMs: 1, tokens: 1 });
    expect(kinds().at(-1)).toBe("assistant");
    activity.renderBackgroundRun(run("r2"));
    expect(inCard()).toEqual(["assistant", "background-run"]);
    expect(card().dataset.topic).toBe("docs");
    expect(card().style.getPropertyValue("--topic")).toMatch(/^oklch/);
  });

  it("closes the card over lines a mid-turn filter change hid, so clearing the filter shows them all", async () => {
    const topics = await import("./topics.js");
    chat.appendTurn("user", "go", false, 1);
    chat.completeTurn("On it.\n<open>auth</open>", { completedAt: 2, durationMs: 1, tokens: 1 });
    callback("r1");
    activity.activityToolStart(1, "c1", "bash", {});
    topics.setTopicFilter("auth");
    expect(pane().querySelectorAll("[data-kind='system'], [data-kind='activity']").map((r) => r.hidden)).toEqual([true, true]);
    activity.activityToolEnd("c1", false, "ok");
    chat.completeTurn("Other.\n<topic>deploy</topic>", { completedAt: 3, durationMs: 1, tokens: 1 });
    expect(inCard()).toEqual(["system", "activity", "assistant"]);
    expect(card().hidden).toBe(false);
    topics.setTopicFilter(null);
    expect(card().children.map((r) => r.hidden)).toEqual([false, false, false]);
  });

  it("closes a card around the cause line, the steps line and the reply; a plain reply stays a bare row", () => {
    chat.appendTurn("user", "go", false, 1);
    chat.appendTurn("assistant", "Sure.", true);
    expect(kinds()).toEqual(["time", "user", "assistant"]);
    callback("r1");
    activity.activityToolStart(1, "c1", "bash", {});
    activity.activityToolEnd("c1", false, "ok");
    expect(kinds()).toEqual(["time", "user", "assistant", "system", "activity"]);
    chat.completeTurn("Done.\n<topic>deploy</topic>", { completedAt: 5, durationMs: 1000, tokens: 1 });
    expect(kinds()).toEqual(["time", "user", "assistant", "turn"]);
    expect(inCard()).toEqual(["system", "activity", "assistant"]);
    // The steps line says the count, not an outcome; the card carries the topic.
    expect(card().querySelector("[data-kind='activity']")!.querySelector("summary")!.textContent).toMatch(/^1 step · \d+s$/);
    expect(card().dataset.topic).toBe("deploy");
    expect(card().querySelector("[data-kind='assistant']")!.dataset.topic).toBe("deploy");
    expect(card().hasAttribute("data-frame")).toBe(true);
  });

  it("keeps a steered input between the two steps lines it split, and a launched run as the footer", () => {
    activity.activityToolStart(1, "c1", "bash", {});
    activity.activityToolEnd("c1", false, "");
    activity.renderBackgroundRun(run("r1"));
    callback("r2");
    activity.activityToolStart(2, "c2", "read", {});
    activity.activityToolEnd("c2", false, "");
    expect(kinds()).toEqual(["activity", "background-run", "system", "activity"]);
    chat.completeTurn("Both done.");
    expect(kinds()).toEqual(["turn"]);
    expect(inCard()).toEqual(["activity", "system", "activity", "assistant", "background-run"]);
    // A run launched after the reply landed joins the same footer; a status update stays in place.
    activity.renderBackgroundRun(run("r3"));
    activity.renderBackgroundRun(run("r1", { state: "succeeded", finishedAt: 9 }));
    expect(inCard()).toEqual(["activity", "system", "activity", "assistant", "background-run", "background-run"]);
    expect(card().querySelectorAll("[data-kind='background-run']").map((r) => r.dataset.state)).toEqual(["succeeded", "running"]);
  });

  it("leaves a cause line unframed when a user bubble separates it from the reply", () => {
    callback("r1");
    chat.appendTurn("user", "and this", false, 1);
    chat.completeTurn("Reply.");
    expect(kinds()).toEqual(["system", "time", "user", "assistant"]);
    // A run launched by a bare reply frames it after the fact.
    activity.renderBackgroundRun(run("r2"));
    expect(kinds()).toEqual(["system", "time", "user", "turn"]);
    expect(inCard()).toEqual(["assistant", "background-run"]);
  });

  it("closes a silent turn, an interrupted turn and a failed turn as cards too", () => {
    callback("r1");
    chat.completeTurn("<silent>nothing to add</silent>");
    expect(inCard()).toEqual(["system", "assistant"]);
    expect(card().textContent).toContain("Stayed silent — nothing to add");
    activity.activityToolStart(1, "c1", "bash", {});
    chat.interruptTurn();
    expect(kinds()).toEqual(["turn", "turn"]);
    expect(inCard()).toEqual(["activity"]);
    expect(card().querySelector("summary")!.textContent).toMatch(/^interrupted · 1 step/);
    activity.activityToolStart(2, "c2", "bash", {});
    activity.activityToolEnd("c2", true, "boom");
    activity.noteTurnError();
    chat.appendTurn("error", "provider 529");
    chat.completeTurn(undefined);
    expect(kinds()).toEqual(["turn", "turn", "turn"]);
    expect(inCard()).toEqual(["activity", "error"]);
    // Nothing left to adopt: a turn that ends with nothing draws nothing.
    chat.completeTurn(undefined);
    expect(kinds()).toEqual(["turn", "turn", "turn"]);
    // A chat command's answer is Pier's, never a turn's.
    chat.appendSystemInput("ok", { kind: "chat-command", command: "new" });
    chat.completeTurn("Hi.");
    expect(kinds()).toEqual(["turn", "turn", "turn", "system", "assistant"]);
  });

  it("builds the same cards from a snapshot as the live stream drew", () => {
    const shape = () => pane().children.map((r) => [r.dataset.kind, r.dataset.topic, ...(r.dataset.kind === "turn" ? [r.children.map((c) => c.dataset.kind)] : [])]);
    chat.appendTurn("user", "go", false, 1);
    chat.appendSystemInput("done\n\nok", { kind: "task-callback", taskId: "t", runId: "r0", sourceSessionId: null, source: { taskName: "r0" }, state: "succeeded" });
    activity.activityToolStart(1, "c1", "bash", {});
    activity.activityToolEnd("c1", false, "");
    activity.renderBackgroundRun(run("r1"));
    chat.completeTurn("Launched.\n<topic>deploy</topic>", { completedAt: 5, durationMs: 1000, tokens: 1 });
    activity.activityToolStart(6, "c2", "bash", {});
    chat.interruptTurn();
    const live = shape();
    expect(live).toEqual([
      ["time", "deploy"], ["user", "deploy"],
      ["turn", "deploy", ["system", "activity", "assistant", "background-run"]],
      ["turn", undefined, ["activity"]],
    ]);
    chat.resetChat();
    chat.renderSnapshot([
      { role: "user", text: "go", at: 1 },
      { role: "system", text: "done\n\nok", origin: { kind: "task-callback", taskId: "t", runId: "r0", sourceSessionId: null, source: { taskName: "r0" }, state: "succeeded" } },
      { role: "assistant", text: "Launched.\n<topic>deploy</topic>", steps, meta: { completedAt: 5, durationMs: 1000, tokens: 1 } },
      { role: "assistant", text: "", steps: [{ kind: "tool", id: "c2", toolName: "bash", args: {}, done: false }] },
    ], "idle", [run("r1")]);
    expect(shape()).toEqual(live);
    expect(pane().querySelectorAll("[data-frame]")).toEqual([]); // history replay does not animate
  });

  it("opens and closes every line-level fold from one remembered choice; a line that arrives follows it", () => {
    callback("r1");
    activity.activityToolStart(1, "c1", "bash", {});
    activity.activityToolEnd("c1", false, "out");
    activity.renderBackgroundRun(run("r2"));
    chat.completeTurn("Done.");
    const folds = () => [
      ...card().querySelectorAll("button[aria-expanded]").map((b) => b.getAttribute("aria-expanded")),
      String(card().querySelector("details[data-kind='activity']")!.open),
    ];
    expect(folds()).toEqual(["false", "false", "false"]);
    activity.setWorkOpen(true);
    expect(folds()).toEqual(["true", "true", "true"]);
    expect(stored.get("pier.work")).toBe("open");
    // Tool rows inside the log stay per row: opening every output would fetch every output.
    expect(card().querySelector("[data-kind='activity']")!.querySelector("details")!.open).toBe(false);
    callback("r3");
    activity.activityToolStart(2, "c2", "bash", {});
    chat.completeTurn("Again.");
    expect(folds()).toEqual(["true", "true"]);
    // One line's own chevron overrides the choice for that line alone.
    card().querySelector("button[aria-expanded]")!.onclick?.();
    expect(folds()).toEqual(["false", "true"]);
    activity.setWorkOpen(false);
    expect(folds()).toEqual(["false", "false"]);
    expect(pane().querySelectorAll("button[aria-expanded='true']")).toEqual([]);
  });

  it("leaves a replayed log whose detail is still on the server closed, whatever the choice, until the reader opens it", async () => {
    const fetch = vi.fn(async () => Response.json({ steps: [{ kind: "tool", id: "c1", toolName: "bash", args: { cmd: "ls" }, done: true }] }));
    vi.stubGlobal("fetch", fetch);
    stored.set("pier.work", "open");
    chat.renderSnapshot([
      { role: "user", text: "go", at: 1 },
      { role: "assistant", text: "Done.", steps: [{ kind: "tool", id: "c1", toolName: "bash", done: true }], meta: { completedAt: 2, durationMs: 1, tokens: 1 } },
      { role: "user", text: "again", at: 3 },
      { role: "assistant", text: "Done.", steps, meta: { completedAt: 4, durationMs: 1, tokens: 1 } },
    ], "idle", []);
    const [lazy, held] = pane().querySelectorAll("details[data-kind='activity']");
    expect([lazy!.open, held!.open]).toEqual([false, true]);
    expect(fetch).not.toHaveBeenCalled();
    activity.setWorkOpen(false);
    activity.setWorkOpen(true);
    expect([lazy!.open, held!.open]).toEqual([false, true]);
    expect(fetch).not.toHaveBeenCalled();
    // Opened by hand: fetched once, and from then on it follows the choice.
    lazy!.open = true;
    lazy!.dispatchEvent(new Event("toggle"));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect("lazy" in lazy!.dataset).toBe(false));
    activity.setWorkOpen(false);
    activity.setWorkOpen(true);
    expect(lazy!.open).toBe(true);
  });
});
