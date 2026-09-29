// The turns pane on index.html: the `/status` card opens its runs' sessions;
// seeds, callbacks, delegations and runs are chips of the reply's bubble, each
// opening in place to its detail.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SystemInputOrigin } from "../../core/types.js";
import { fake, installPage, type FakeDocument, type FakeElement } from "./dom.testkit.js";

let doc: FakeDocument;
let chat: typeof import("./chat.js");

// A reply renders through marked; the sanitizer and the highlighter want a real DOM.
vi.mock("dompurify", () => ({ default: { sanitize: (html: string) => html } }));
vi.mock("./highlight.js", () => ({ highlightCode: async () => {} }));
const select = vi.fn();
const quote = vi.fn();
const send = vi.fn();

beforeEach(async () => {
  vi.resetModules();
  select.mockClear();
  doc = installPage();
  // Only the tail-follow uses them, and the fake DOM has no layout to follow.
  for (const name of ["ResizeObserver", "MutationObserver"]) vi.stubGlobal(name, class { observe(): void {} });
  chat = await import("./chat.js");
  chat.initChat({
    sessionId: () => "h1", sessionCwd: () => null, sessionChannel: () => "web", sessionState: () => "idle",
    select, send, ownTurn: vi.fn(), reload: vi.fn(async () => {}), quote,
  });
  quote.mockClear();
  send.mockClear();
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

/** A cause chip (`data-kind="system"` on the chip) and the detail it opens. */
const toggle = () => card();
/** The chip's words: what a reader sees with the detail closed. */
const line = () => toggle().textContent;
const bubble = () => doc.querySelector("#turns")!.querySelectorAll("[data-kind='assistant'], [data-kind='error']").at(-1)!;
const detail = () => bubble().querySelector(".chip-details")!.children.at(-1)!;
const body = () => detail().children.at(-1)!;
const model = { provider: "anthropic", id: "claude-x" };

it("folds a session seed to its reason and the previous session's id", () => {
  chat.appendSystemInput("Memory\n\nlast exchanges…", { kind: "session-seed", reason: "idle", previousSessionId: "prev1234abcd" });
  expect(toggle().classList.contains("chip")).toBe(true);
  expect(line()).toBe("session seedidle");
  expect(detail().querySelector(".run-session")!.textContent).toBe("prev1234");
  expect(detail().hidden).toBe(true);
});

it("shows a callback without the language stamp the model reads", () => {
  chat.appendSystemInput('[lang=zh]\nTask "fix it" finished with state: succeeded\nrun r1\n\nAll green.', {
    kind: "task-callback", taskId: "t1", runId: "run45678xyz", sourceSessionId: "s-run", state: "succeeded",
  });
  // No source of its own: the caption is the first line, which the stamp must not be.
  expect(line()).toBe('callback · succeededTask "fix it" finished with state: succeeded');
  expect(card().textContent).not.toContain("lang=zh");
});

it("folds a callback to state and name; the detail carries model, ids and the text, and opens on the chip", () => {
  chat.appendSystemInput('Task "fix it" finished with state: succeeded\nrun r1\n\nAll green.', {
    kind: "task-callback", taskId: "t1", runId: "run45678xyz", sourceSessionId: "s-run",
    source: { taskName: "fix it", tier: "balanced", model, thinking: "high" }, state: "succeeded",
  });
  // Mode, model and ids leave the chip for its opened head.
  expect(line()).toBe("callback · succeededfix it");
  expect(toggle().querySelector(".chip-name")!.textContent).toBe("fix it");
  const head = detail().querySelector(".run-head")!;
  expect(head.textContent).toBe("callback · succeededfix itbalancedclaude-xhighrun45678s-run");
  // One badge, `tier · id · level`: the stylesheet draws the dots between its parts.
  const badge = head.querySelector(".run-model")!;
  expect([...badge.children].map((part) => [part.className, part.textContent]))
    .toEqual([["run-tier", "balanced"], ["run-model-id", "claude-x"], ["run-thinking", "high"]]);
  expect(badge.getAttribute("title")).toBe("Tier balanced · anthropic / claude-x · Reasoning high");
  expect(body().textContent).toBe("All green.");
  expect(toggle().localName).toBe("button"); // Enter and Space are the browser's
  expect(toggle().getAttribute("type")).toBe("button");
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
  toggle().onclick?.();
  expect(toggle().hasAttribute("data-open")).toBe(true);
  expect(toggle().getAttribute("aria-expanded")).toBe("true");
  expect(detail().hidden).toBe(false);
  detail().querySelector(".run-session")!.onclick?.();
  expect(select).toHaveBeenLastCalledWith("s-run");
  toggle().onclick?.();
  expect(toggle().hasAttribute("data-open")).toBe(false);
  expect(detail().hidden).toBe(true);
});

it("keeps a failed callback's reason on the line, in the state's colour", () => {
  chat.appendSystemInput('Task "deploy" finished with state: failed\nrun r2\n\n\nprovider 529: overloaded\nstack…', {
    kind: "task-callback", taskId: "t2", runId: "run2", sourceSessionId: null, source: { taskName: "deploy" }, state: "failed",
  });
  expect(line()).toBe("callback · faileddeploy");
  expect(toggle().classList.contains("text-red-600")).toBe(true);
  expect(detail().querySelector(".run-failure")!.textContent).toBe("provider 529: overloaded");
  expect(detail().querySelector(".run-model")).toBeNull(); // nothing recorded, no empty badge
  chat.appendSystemInput("x\n\n", {
    kind: "task-callback", taskId: "t3", runId: "run3", sourceSessionId: null, source: { taskName: "probe" }, state: "interrupted",
  });
  expect(line()).toBe("callback · interruptedprobe");
  expect(toggle().classList.contains("text-amber-700")).toBe(true);
  expect(detail().querySelector(".run-failure")!.textContent).toBe("interrupted");
});

it("folds a delegation and a task message to name and run id; a command answer stays open", () => {
  chat.appendSystemInput("Task: review\n\nRead the diff.", { kind: "task-delegation", taskId: "t4", runId: "run4abcdefg", sourceSessionId: "s-lead" });
  expect(line()).toBe("delegationTask: review");
  expect(detail().querySelector(".run-id")!.textContent).toBe("run4abcd");
  chat.appendSystemInput("steer text", {
    kind: "task-message", taskId: "t5", runId: "run5", sourceSessionId: "s5", messageId: "m", messageKind: "follow_up", source: { taskName: "lead" },
  });
  expect(line()).toBe("follow uplead");
  chat.appendSystemInput("Started a new session.", { kind: "chat-command", command: "new" });
  expect(card().classList.contains("chip")).toBe(false);
  expect(card().querySelector("button[aria-expanded]")).toBeNull();
  expect(card().children.at(-1)!.hidden).toBe(false);
  expect(card().parentElement).toBe(doc.querySelector("#turns"));
});

it("folds a run to a chip like a callback, and a status update keeps its detail open", async () => {
  const run = {
    runId: "qvv3qbffxyz", taskId: "t6", taskName: "IM conversation", state: "running" as const, targetSessionId: "s-run6",
    sessionMode: "fresh" as const, prompt: "Build per the design doc.", queuedAt: 1, startedAt: 1, finishedAt: null, queuedMessages: 0,
    model, thinking: "medium" as const,
  };
  const { renderBackgroundRun } = await import("./turn-activity.js");
  renderBackgroundRun(run);
  const runToggle = () => doc.querySelector("#turns")!.querySelectorAll("[data-kind='background-run']").at(-1)!;
  expect(runToggle().classList.contains("chip")).toBe(true);
  expect(runToggle().textContent).toBe("run · runningIM conversation");
  expect(detail().querySelector(".run-model")!.textContent).toBe("claude-xmedium");
  expect(detail().querySelector(".run-note")!.textContent).toMatch(/^fresh · \d+s$/);
  expect(detail().hidden).toBe(true);
  runToggle().onclick?.();
  expect(runToggle().hasAttribute("data-open")).toBe(true);
  renderBackgroundRun({ ...run, state: "succeeded", finishedAt: 142_001 });
  expect(runToggle().textContent).toBe("run · succeededIM conversation");
  expect(runToggle().getAttribute("aria-expanded")).toBe("true");
  expect(detail().hidden).toBe(false);
  expect(detail().querySelector(".run-note")!.textContent).toBe("fresh · 142s");
  expect(body().textContent).toBe("Build per the design doc.");
});

it("names a run card by its session once there is one, and by the run id until then", async () => {
  const run = {
    runId: "ykt7hre3nzenaweb", taskId: "t7", taskName: "Pier 产品简化合并", state: "queued" as const, targetSessionId: null,
    sessionMode: "fresh" as const, prompt: "研究一下", queuedAt: 1, startedAt: null, finishedAt: null, queuedMessages: 0,
  };
  const { renderBackgroundRun } = await import("./turn-activity.js");
  renderBackgroundRun(run);
  expect(detail().querySelector(".run-id")!.textContent).toBe("ykt7hre3");
  expect(detail().querySelector(".run-session")).toBeNull();
  renderBackgroundRun({ ...run, state: "running", targetSessionId: "s7abcdef1234", startedAt: 2 });
  const session = detail().querySelector(".run-session")!;
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
    const callback = detail();
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
    await vi.waitFor(() => expect(refs(detail())).toEqual(["/tmp/run.log"]));
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
    // The raw text, marker and all.
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
    // The bar is neutral: a topic's colour lives on its tag alone.
    expect(block.style.getPropertyValue("--topic")).toBe("");
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

describe("the turn's bubble", () => {
  const pane = () => doc.querySelector("#turns")!;
  const kinds = () => pane().children.map((r) => r.dataset.kind);
  const bubble = () => pane().querySelectorAll("[data-kind='assistant'], [data-kind='error']").at(-1)!;
  const chipRow = (b = bubble()) => b.children.find((el) => el.classList.contains("chip-row"))!;
  const chips = (b = bubble()) => chipRow(b)?.children.map((c) => c.dataset.kind ?? c.className.split(" ")[0]) ?? [];
  const details = () => bubble().children.find((el) => el.classList.contains("chip-details"))!.children;
  const stepsChip = () => chipRow().querySelector("[data-kind='activity']")!;
  /** The bubble's parts, top to bottom, by the class that names each. */
  const parts = () => bubble().children.map((el) => ["chip-row", "chip-details", "stream", "md", "message-tools"].find((c) => el.classList.contains(c)) ?? el.className);
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

  it("tags an `<open>` reply and the user message above it; a tag jumps to the topic's reply before", () => {
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
    a2!.querySelector(".topic-tag")!.onclick!();
    expect("reveal" in a1!.dataset).toBe(true);
    // The user message's tag jumps past its own reply's exchange, to the reply before it.
    delete a1!.dataset.reveal;
    u2!.querySelector(".topic-tag")!.onclick!();
    expect("reveal" in a1!.dataset).toBe(true);
    // The earliest on screen lights itself: the jump happened, there is nothing above.
    a1!.querySelector(".topic-tag")!.onclick!();
    expect("reveal" in a1!.dataset).toBe(true);
    expect("reveal" in u1!.dataset).toBe(false);
    // The status panel's landing: the newest reply of the topic, or false.
    expect(chat.revealTopic("auth review")).toBe(true);
    expect("reveal" in a2!.dataset).toBe(true);
    expect(chat.revealTopic("deploy")).toBe(false);
  });

  it("puts the topic tag first in the chip row, whichever of tag and chip came first", () => {
    chat.appendTurn("user", "go", false, 1);
    callback("r1");
    chat.completeTurn("Other.\n<topic>deploy</topic>", { completedAt: 4, durationMs: 1, tokens: 1 });
    expect(chips()).toEqual(["topic-tag", "system"]);
    expect(chipRow().children[0]!.classList.contains("mb-1")).toBe(false);
    expect(bubble().dataset.topic).toBe("deploy");
    // A bare tagged reply grows its chip row when a run lands after it.
    chat.appendTurn("user", "more", false, 5);
    chat.completeTurn("Later.\n<topic>docs</topic>", { completedAt: 6, durationMs: 1, tokens: 1 });
    expect(chipRow()).toBeUndefined();
    expect(bubble().children[0]!.classList.contains("mb-1")).toBe(true);
    activity.renderBackgroundRun(run("r2"));
    expect(chips()).toEqual(["topic-tag", "background-run"]);
    expect(chipRow().children[0]!.classList.contains("mb-1")).toBe(false);
    expect(parts()).toEqual(["chip-row", "chip-details", "md", "message-tools"]);
  });

  it("opens the bubble with its first chip and fills it with the reply; a plain reply has no chip row", () => {
    chat.appendTurn("user", "go", false, 1);
    chat.appendTurn("assistant", "Sure.", true);
    expect(kinds()).toEqual(["time", "user", "assistant"]);
    expect(chipRow()).toBeUndefined();
    callback("r1");
    expect(kinds()).toEqual(["time", "user", "assistant", "assistant"]);
    expect("pending" in bubble().dataset).toBe(true);
    activity.activityToolStart(1, "c1", "bash", {});
    activity.activityToolEnd("c1", false, "ok");
    expect(chips()).toEqual(["system", "activity"]);
    chat.completeTurn("Done.\n<topic>deploy</topic>", { completedAt: 5, durationMs: 1000, tokens: 1 });
    expect(kinds()).toEqual(["time", "user", "assistant", "assistant"]);
    expect("pending" in bubble().dataset).toBe(false);
    expect(chips()).toEqual(["topic-tag", "system", "activity"]);
    expect(parts()).toEqual(["chip-row", "chip-details", "md", "message-tools"]);
    expect(bubble().querySelector(".md")!.textContent.trim()).toBe("Done.");
    // The steps chip says the count, not an outcome; its detail is the log, closed.
    expect(stepsChip().textContent).toMatch(/^1 step · \d+s$/);
    expect(stepsChip().getAttribute("aria-expanded")).toBe("false");
    expect(details().map((d) => d.hidden)).toEqual([true, true]);
    expect(bubble().dataset.topic).toBe("deploy");
  });

  it("streams the reply's text under the chip row, and moves it to the log at a tool boundary", () => {
    callback("r1");
    chat.appendDelta("Looking");
    expect(parts()).toEqual(["chip-row", "chip-details", "stream"]);
    expect(bubble().textContent).toContain("Looking");
    chat.finalizeStreaming();
    activity.activityToolStart(1, "c1", "bash", {});
    activity.activityToolEnd("c1", false, "ok");
    expect(chips()).toEqual(["system", "activity"]);
    const log = details().at(-1)!;
    expect(log.querySelectorAll("[data-kind='progress']").map((r) => r.textContent)).toEqual(["Looking"]);
    chat.appendDelta("Done");
    expect(parts()).toEqual(["chip-row", "chip-details", "stream"]);
    chat.completeTurn("Done.", { completedAt: 5, durationMs: 1000, tokens: 1 });
    expect(stepsChip().textContent).toMatch(/^2 steps · \d+s$/);
    expect(parts()).toEqual(["chip-row", "chip-details", "md", "message-tools"]);
    expect(kinds()).toEqual(["assistant"]);
  });

  it("keeps chips in arrival order across a steered input, and a launched run joins the reply's bubble", () => {
    activity.activityToolStart(1, "c1", "bash", {});
    activity.activityToolEnd("c1", false, "");
    activity.renderBackgroundRun(run("r1"));
    callback("r2");
    activity.activityToolStart(2, "c2", "read", {});
    activity.activityToolEnd("c2", false, "");
    expect(kinds()).toEqual(["assistant"]);
    expect(chips()).toEqual(["activity", "background-run", "system", "activity"]);
    chat.completeTurn("Both done.");
    expect(kinds()).toEqual(["assistant"]);
    // A run launched after the reply landed joins the same row; a status update stays in place.
    activity.renderBackgroundRun(run("r3"));
    activity.renderBackgroundRun(run("r1", { state: "succeeded", finishedAt: 9 }));
    expect(chips()).toEqual(["activity", "background-run", "system", "activity", "background-run"]);
    expect(chipRow().querySelectorAll("[data-kind='background-run']").map((r) => r.dataset.state)).toEqual(["succeeded", "running"]);
    expect(details().map((d) => d.className.split(" ")[0])).toEqual(["activity-log", "system-card", "system-card", "activity-log", "system-card"]);
  });

  it("opens one chip's detail per bubble: another chip in its row closes, another bubble's stays", () => {
    callback("r1");
    activity.renderBackgroundRun(run("r2"));
    chat.completeTurn("First.");
    const firstDetails = details();
    const [cause, launched] = chipRow().children.filter((c) => c.classList.contains("chip"));
    chat.appendTurn("user", "more", false, 1);
    callback("r3");
    const other = chipRow().children.at(-1)!;
    cause!.onclick?.();
    launched!.onclick?.();
    expect([cause, launched].map((c) => c!.getAttribute("aria-expanded"))).toEqual(["false", "true"]);
    expect(firstDetails.map((d) => d.hidden)).toEqual([true, false]);
    other.onclick?.();
    expect([launched, other].map((c) => c!.hasAttribute("data-open"))).toEqual([true, true]);
    launched!.onclick?.();
    expect(firstDetails.map((d) => d.hidden)).toEqual([true, true]);
  });

  it("keeps the open run chip the row's one open detail through a status update", () => {
    callback("r1");
    activity.renderBackgroundRun(run("r2"));
    const [cause, launched] = chipRow().children.filter((c) => c.classList.contains("chip"));
    launched!.onclick?.();
    activity.renderBackgroundRun(run("r2", { state: "succeeded", finishedAt: 9 }));
    expect(launched!.dataset.state).toBe("succeeded");
    expect([cause, launched].map((c) => c!.getAttribute("aria-expanded"))).toEqual(["false", "true"]);
    expect(details().map((d) => d.hidden)).toEqual([true, false]);
    cause!.onclick?.();
    expect(details().map((d) => d.hidden)).toEqual([false, true]);
  });

  it("leaves a chip-row-only bubble when a user bubble separates it from the reply", () => {
    callback("r1");
    chat.appendTurn("user", "and this", false, 1);
    chat.completeTurn("Reply.");
    expect(kinds()).toEqual(["assistant", "time", "user", "assistant"]);
    const [orphan] = pane().querySelectorAll("[data-kind='assistant']");
    expect("pending" in orphan!.dataset).toBe(false);
    expect(chips(orphan)).toEqual(["system"]);
    expect(chipRow()).toBeUndefined();
    // A run launched by a bare reply grows its chip row after the fact.
    activity.renderBackgroundRun(run("r2"));
    expect(kinds()).toEqual(["assistant", "time", "user", "assistant"]);
    expect(chips()).toEqual(["background-run"]);
  });

  it("carries the chip row on a silent, an interrupted and a failed turn's own material", () => {
    callback("r1");
    chat.completeTurn("<silent>nothing to add</silent>");
    expect(chips()).toEqual(["system"]);
    expect(bubble().textContent).toContain("Stayed silent — nothing to add");
    activity.activityToolStart(1, "c1", "bash", {});
    chat.interruptTurn();
    expect(kinds()).toEqual(["assistant", "assistant"]);
    expect(chips()).toEqual(["activity"]);
    expect(stepsChip().textContent).toMatch(/^interrupted · 1 step/);
    expect(stepsChip().classList.contains("text-amber-700")).toBe(true);
    // A turn that ends on a failure: the turn-end carries it, then the error row is its result.
    activity.activityToolStart(2, "c2", "bash", {});
    activity.activityToolEnd("c2", true, "boom");
    chat.completeTurn("", undefined, "provider 529");
    expect("pending" in bubble().dataset).toBe(true);
    chat.appendTurn("error", "provider 529");
    expect(kinds()).toEqual(["assistant", "assistant", "error"]);
    expect(chips()).toEqual(["activity"]);
    expect(stepsChip().textContent).toMatch(/^failed · 1 step/);
    expect(stepsChip().classList.contains("text-red-600")).toBe(true);
    // Nothing pending: a turn that ends with nothing draws nothing.
    chat.completeTurn(undefined);
    expect(kinds()).toEqual(["assistant", "assistant", "error"]);
    // A chat command's answer is Pier's, never a turn's.
    chat.appendSystemInput("ok", { kind: "chat-command", command: "new" });
    chat.completeTurn("Hi.");
    expect(kinds()).toEqual(["assistant", "assistant", "error", "system", "assistant"]);
    expect(chipRow()).toBeUndefined();
  });

  it("leaves an error reported mid-flight a bare row, never the turn's result", () => {
    callback("r1");
    activity.activityToolStart(1, "c1", "bash", {});
    chat.appendTurn("error", "notify slack failed");
    // The row goes above the turn's bubble, which stays pending for its result.
    expect(kinds()).toEqual(["error", "assistant"]);
    expect(chipRow(pane().children[0]!)).toBeUndefined();
    activity.activityToolEnd("c1", false, "ok");
    // In the gap after a tool answered, before the next step, the turn is still on.
    chat.appendTurn("error", "notify slack failed again");
    activity.activityToolStart(2, "c2", "bash", {});
    activity.activityToolEnd("c2", false, "ok");
    activity.activityThinking(3, "hm");
    chat.appendTurn("error", "session title: no auth");
    chat.appendDelta("Still");
    chat.appendTurn("error", "notify lark failed");
    expect(kinds()).toEqual(["error", "error", "error", "error", "assistant"]);
    chat.completeTurn("Done.");
    expect(kinds()).toEqual(["error", "error", "error", "error", "assistant"]);
    // One group, all of it: no error split the steps.
    expect(chips(pane().children[4]!)).toEqual(["system", "activity"]);
    expect(stepsChip().textContent).toMatch(/^3 steps/);
    expect(stepsChip().dataset.status).toBe("done");
    expect(pane().children[4]!.textContent).toContain("Done.");
  });

  it("builds the same bubbles from a snapshot as the live stream drew", () => {
    const shape = () => pane().children.map((r) => [r.dataset.kind, r.dataset.topic, chips(r), r.querySelector("[data-kind='activity']")?.dataset.status]);
    chat.appendTurn("user", "go", false, 1);
    chat.appendSystemInput("done\n\nok", { kind: "task-callback", taskId: "t", runId: "r0", sourceSessionId: null, source: { taskName: "r0" }, state: "succeeded" });
    activity.activityToolStart(1, "c1", "bash", {});
    activity.activityToolEnd("c1", false, "");
    activity.renderBackgroundRun(run("r1"));
    chat.completeTurn("Launched.\n<topic>deploy</topic>", { completedAt: 5, durationMs: 1000, tokens: 1 });
    activity.activityToolStart(6, "c2", "bash", {});
    chat.interruptTurn();
    activity.activityToolStart(7, "c3", "bash", {});
    activity.activityToolEnd("c3", false, "");
    chat.completeTurn("", undefined, "overloaded");
    chat.appendTurn("error", "overloaded");
    // Failed with a tool still owed: the failure names the group, not the cut.
    activity.activityToolStart(8, "c4", "bash", {});
    chat.completeTurn("", undefined, "overloaded");
    chat.appendTurn("error", "overloaded");
    const live = shape();
    expect(live).toEqual([
      ["time", undefined, [], undefined], ["user", "deploy", [], undefined],
      ["assistant", "deploy", ["topic-tag", "system", "activity", "background-run"], "done"],
      ["assistant", undefined, ["activity"], "interrupted"],
      ["error", undefined, ["activity"], "failed"],
      ["error", undefined, ["activity"], "failed"],
    ]);
    chat.resetChat();
    chat.renderSnapshot([
      { role: "user", text: "go", at: 1 },
      { role: "system", text: "done\n\nok", origin: { kind: "task-callback", taskId: "t", runId: "r0", sourceSessionId: null, source: { taskName: "r0" }, state: "succeeded" } },
      { role: "assistant", text: "Launched.\n<topic>deploy</topic>", steps, meta: { completedAt: 5, durationMs: 1000, tokens: 1 } },
      { role: "assistant", text: "", steps: [{ kind: "tool", id: "c2", toolName: "bash", args: {}, done: false }] },
      { role: "assistant", text: "", error: "overloaded", steps: [{ kind: "tool", id: "c3", toolName: "bash", args: {}, done: true }] },
      { role: "assistant", text: "", error: "overloaded", steps: [{ kind: "tool", id: "c4", toolName: "bash", args: {}, done: false }] },
    ], "idle", [run("r1")]);
    expect(shape()).toEqual(live);
    expect(pane().querySelectorAll("[data-enter]")).toEqual([]); // history replay does not animate
  });

  it("counts what an edit drops by messages, not bubbles: a cause chip is one, a bubble of chips alone none", () => {
    const user = chat.appendTurn("user", "go", false, 1).parentElement!;
    callback("r1");
    chat.appendTurn("user", "and this", false, 2);
    callback("r2");
    chat.completeTurn("Done.");
    activity.renderBackgroundRun(run("r3"));
    // r1's chip-only bubble, the second user row, r2 and the reply: four messages.
    fake(user.querySelector(".message-tools")!.querySelector("button")).onclick!();
    expect(user.textContent).toContain("sending drops the 4 messages after this one");
  });

  it("sends a picked next step as a reply to the bubble that offered it", () => {
    chat.appendTurn("user", "go", false, 1);
    chat.completeTurn("Done.\n\n---\n[Ship it] | [Wait]", { completedAt: 2, durationMs: 1, tokens: 1 });
    const buttons = bubble().querySelectorAll("button").filter((b) => b.textContent === "Ship it");
    buttons[0]!.onclick?.();
    expect(send).toHaveBeenCalledWith("auto", "Ship it", { role: "assistant", at: 2, text: "Done.\n\n---\n[Ship it] | [Wait]" });
  });

  it("opens each chip on its own click only; a replayed log fetches its detail on the first", async () => {
    const fetch = vi.fn(async () => Response.json({ steps: [{ kind: "tool", id: "c1", toolName: "bash", args: { cmd: "ls" }, done: true }] }));
    vi.stubGlobal("fetch", fetch);
    chat.renderSnapshot([
      { role: "user", text: "go", at: 1 },
      { role: "assistant", text: "Done.", steps: [{ kind: "tool", id: "c1", toolName: "bash", done: true }], meta: { completedAt: 2, durationMs: 1, tokens: 1 } },
      { role: "user", text: "again", at: 3 },
      { role: "assistant", text: "Done.", steps, meta: { completedAt: 4, durationMs: 1, tokens: 1 } },
    ], "idle", []);
    const [lazy, held] = pane().querySelectorAll("[data-kind='activity']");
    expect([lazy!.getAttribute("aria-expanded"), held!.getAttribute("aria-expanded")]).toEqual(["false", "false"]);
    expect("lazy" in lazy!.dataset).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    held!.onclick?.();
    expect(held!.getAttribute("aria-expanded")).toBe("true");
    expect(fetch).not.toHaveBeenCalled();
    // Tool rows inside the log stay per row: opening every output would fetch every output.
    expect(details().at(-1)!.querySelector("details")!.open).toBe(false);
    lazy!.onclick?.();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect("lazy" in lazy!.dataset).toBe(false));
    lazy!.onclick?.();
    lazy!.onclick?.();
    expect(fetch).toHaveBeenCalledOnce();
  });
});
