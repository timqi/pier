// System rows on index.html: the `/status` card opens its runs' sessions, and
// seeds, callbacks, delegations and run cards fold to one line that opens in place.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SystemInputOrigin } from "../../core/types.js";
import { installPage, type FakeDocument, type FakeElement } from "./dom.testkit.js";

let doc: FakeDocument;
let chat: typeof import("./chat.js");

// A reply renders through marked; the sanitizer and the highlighter want a real DOM.
vi.mock("dompurify", () => ({ default: { sanitize: (html: string) => html } }));
vi.mock("./highlight.js", () => ({ highlightCode: async () => {} }));
const select = vi.fn();

beforeEach(async () => {
  vi.resetModules();
  select.mockClear();
  doc = installPage();
  // Only the tail-follow uses them, and the fake DOM has no layout to follow.
  for (const name of ["ResizeObserver", "MutationObserver"]) vi.stubGlobal(name, class { observe(): void {} });
  chat = await import("./chat.js");
  chat.initChat({
    sessionId: () => "h1", sessionCwd: () => null, sessionChannel: () => "web", sessionState: () => "idle",
    select, send: vi.fn(), ownTurn: vi.fn(), reload: vi.fn(async () => {}),
  });
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
    const deps = { sessionId: () => "h1", sessionCwd: () => "/w/main" as string | null, sessionChannel: () => "web", sessionState: () => "idle" as const, select, send: vi.fn(), ownTurn: vi.fn(), reload: vi.fn(async () => {}) };
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

describe("topics and the process line", () => {
  const pane = () => doc.querySelector("#turns")!;
  const kinds = () => pane().children.map((r) => r.dataset.kind);
  const run = (runId: string, over: Partial<import("../../core/types.js").BackgroundRun> = {}) => ({
    runId, taskId: "t", taskName: runId, state: "running" as const, targetSessionId: null, sessionMode: "fresh" as const,
    prompt: "go", queuedAt: 1, startedAt: 1, finishedAt: null, queuedMessages: 0, ...over,
  });
  const callback = (runId: string, state: "succeeded" | "failed" = "succeeded") => chat.appendSystemInput("done\n\nok", {
    kind: "task-callback", taskId: "t", runId, sourceSessionId: null, source: { taskName: runId }, state,
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

  it("folds callbacks and a run card after a reply into one line that says what is in it", () => {
    chat.appendTurn("assistant", "Delegated.", true);
    callback("r1");
    callback("r2", "failed");
    renderRun(run("r3"));
    expect(kinds()).toEqual(["assistant", "process"]);
    const fold = pane().children.at(-1)!;
    expect(fold.localName).toBe("details");
    expect(fold.open).toBe(false);
    expect(fold.querySelector(".process-summary")!.textContent).toBe("1 run · 1 running · 2 callbacks");
    expect(fold.querySelector(".process-glyph")!.querySelector(".spinner")).not.toBeNull();
    renderRun(run("r3", { state: "succeeded", finishedAt: 2 }));
    expect(fold.querySelector(".process-summary")!.textContent).toBe("1 run · 1 succeeded · 2 callbacks");
    // Nothing moving: the glyph is the state to look at.
    expect(fold.querySelector(".process-glyph")!.querySelector(".spinner")).toBeNull();
    expect(fold.querySelector(".process-glyph")!.querySelector("svg")!.getAttribute("class")).toContain("text-red-600");
  });

  it("hangs a run launched during a turn under that turn's reply, live and on replay alike", async () => {
    const steps = [{ kind: "tool" as const, id: "c1", toolName: "bash", args: {}, done: true }];
    const { replayActivity } = await import("./turn-activity.js");
    replayActivity(steps, 1000);
    renderRun(run("r1"));
    chat.completeTurn("Launched.\n<topic>deploy</topic>");
    expect(kinds()).toEqual(["activity", "assistant", "process"]);
    const live = pane().children.map((r) => [r.dataset.kind, r.dataset.topic]);
    expect(live).toEqual([["activity", "deploy"], ["assistant", "deploy"], ["process", "deploy"]]);

    chat.resetChat();
    chat.renderSnapshot([{ role: "assistant", text: "Launched.\n<topic>deploy</topic>", steps, meta: { completedAt: 5, durationMs: 1000, tokens: 1 } }], "idle", [run("r1")]);
    expect(pane().children.map((r) => [r.dataset.kind, r.dataset.topic])).toEqual(live);
  });

  let renderRun: (r: ReturnType<typeof run>) => void;
  beforeEach(async () => {
    renderRun = (await import("./turn-activity.js")).renderBackgroundRun;
  });
});
