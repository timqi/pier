// The turns pane on index.html: the `/status` card opens its runs' sessions;
// callbacks, delegations and runs are chips of the reply's bubble, each
// opening in place to its detail.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SystemInputOrigin } from "../../core/types.js";
import { STREAM_PAINT_MS } from "./dom.js";
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

it("folds a session seed into the divider that opened its session, opening to its reason and the previous session's id", () => {
  chat.appendDivider("idle", 5);
  chat.appendSystemInput("Memory\n\nlast exchanges…", { kind: "session-seed", reason: "idle", previousSessionId: "prev1234abcd" });
  const rows = doc.querySelector("#turns")!.children;
  expect(rows.map((r) => r.dataset.kind)).toEqual(["divider", "system"]);
  const fold = rows[0]!.querySelector("button")!;
  expect(fold.textContent).toMatch(/^new session — idle 1h · /);
  expect(fold.getAttribute("aria-expanded")).toBe("false");
  expect(card().hidden).toBe(true);
  expect(card().querySelector(".run-head")!.textContent).toContain("session seedidle");
  expect(card().querySelector(".run-session")!.textContent).toBe("prev1234");
  fold.onclick?.();
  expect(fold.getAttribute("aria-expanded")).toBe("true");
  expect(card().hidden).toBe(false);
  fold.onclick?.();
  expect(card().hidden).toBe(true);
});

it("draws a seed its own divider, in the divider's words, where none opened its session", () => {
  chat.appendSystemInput("Memory", { kind: "session-seed", reason: "full", previousSessionId: null });
  const rows = doc.querySelector("#turns")!.children;
  expect(rows.map((r) => r.dataset.kind)).toEqual(["divider", "system"]);
  expect(rows[0]!.textContent).toBe("new session — the previous one was full");
  expect(card().hidden).toBe(true);
});

it("trims a seed's card with the divider that opens it", () => {
  chat.appendDivider("idle", 5);
  chat.appendSystemInput("Memory", { kind: "session-seed", reason: "idle", previousSessionId: null });
  const kinds = () => doc.querySelector("#turns")!.children.map((r) => r.dataset.kind);
  for (let i = 0; i < 400; i++) chat.appendTurn("user", `m${i}`);
  expect(kinds().slice(0, 2)).toEqual(["divider", "system"]);
  while (kinds().includes("divider")) chat.appendTurn("user", "more");
  expect(kinds().slice(0, 2)).toEqual(["trim", "user"]);
  expect(doc.querySelector("#turns")!.querySelector("[data-seed]")).toBeNull();
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

describe("an earlier turn's next steps", () => {
  const labels = () => doc.querySelector("#turns")!.querySelectorAll("button")
    .filter((b) => ["Ship it", "Wait", "Next"].includes(b.textContent) && !b.closest("[hidden]"))
    .map((b) => b.textContent);
  const earlier = "<open>auth — review</open>\nReview?\n\n---\n[Ship it] | [Wait]";
  const snapshot = (first = earlier) => chat.renderSnapshot([
    { role: "user", text: "go", at: 1 },
    { role: "assistant", text: first, meta: { completedAt: 2, durationMs: 1, tokens: 1 } },
    { role: "user", text: "else", at: 3 },
    { role: "assistant", text: "Other.\n\n---\n[Next]", meta: { completedAt: 4, durationMs: 1, tokens: 1 } },
  ], "idle", []);

  it("shows them muted while the topic is open, hides them once it is done, the last turn's live throughout", async () => {
    const topics = await import("./topics.js");
    const { refreshSuggestions } = await import("./suggestions.js");
    topics.setOpenTopics([{ problem: "auth", status: "running" }]);
    snapshot();
    expect(labels()).toEqual(["Ship it", "Wait", "Next"]);
    const group = doc.querySelector(".earlier-options")!;
    expect(group.querySelectorAll("button")[0]!.className).toContain("text-neutral-500");
    expect(doc.querySelectorAll(".earlier-options")).toHaveLength(1);
    topics.setOpenTopics([]);
    refreshSuggestions();
    expect(labels()).toEqual(["Next"]);
    topics.setOpenTopics([{ problem: "auth", status: "running" }]);
    refreshSuggestions();
    expect(labels()).toEqual(["Ship it", "Wait", "Next"]);
  });

  it("offers nothing on an earlier turn without a topic", async () => {
    (await import("./topics.js")).setOpenTopics([{ problem: "auth", status: "running" }]);
    snapshot("Review?\n\n---\n[Ship it] | [Wait]");
    expect(labels()).toEqual(["Next"]);
  });

  it("mutes the live group when a newer turn ends, and sends a pick as a reply to the turn that offered it", async () => {
    (await import("./topics.js")).setOpenTopics([{ problem: "auth", status: "running" }]);
    chat.appendTurn("user", "go", false, 1);
    chat.completeTurn(earlier, { completedAt: 2, durationMs: 1, tokens: 1 });
    expect(doc.querySelectorAll(".earlier-options")).toHaveLength(0);
    chat.appendTurn("user", "else", false, 3);
    chat.completeTurn("Other.", { completedAt: 4, durationMs: 1, tokens: 1 });
    expect(labels()).toEqual(["Ship it", "Wait"]);
    const pick = doc.querySelector(".earlier-options")!.querySelectorAll("button")[1]!;
    pick.onclick!();
    expect(send).toHaveBeenCalledWith("auto", "Wait", { role: "assistant", at: 2, text: earlier });
    expect(labels()).toEqual([]);
  });

  it("keeps a picked row away after a reload once the topic has a newer reply", async () => {
    (await import("./topics.js")).setOpenTopics([{ problem: "auth", status: "running" }]);
    const { withQuote } = await import("../../core/identity.js");
    chat.renderSnapshot([
      { role: "user", text: "go", at: 1 },
      { role: "assistant", text: earlier, meta: { completedAt: 2, durationMs: 1, tokens: 1 } },
      { role: "user", text: withQuote({ role: "assistant", at: 2, text: earlier }, "Wait"), at: 3 },
      { role: "assistant", text: "<topic>auth</topic>\nWaiting.", meta: { completedAt: 4, durationMs: 1, tokens: 1 } },
    ], "idle", []);
    expect(labels()).toEqual([]);
  });

  it("shows only the open topic's newest reply's row, none when that reply offers none", async () => {
    (await import("./topics.js")).setOpenTopics([{ problem: "auth", status: "running" }]);
    const reply = (at: number, text: string) => [
      { role: "user" as const, text: "go", at: at - 1 },
      { role: "assistant" as const, text, meta: { completedAt: at, durationMs: 1, tokens: 1 } },
    ];
    const newer = "<topic>auth</topic>\nAgain?\n\n---\n[Next]";
    chat.renderSnapshot([...reply(2, earlier), ...reply(4, newer), ...reply(6, "Other.")], "idle", []);
    expect(labels()).toEqual(["Next"]);
    chat.renderSnapshot([...reply(2, earlier), ...reply(4, "<topic>auth</topic>\nNoted."), ...reply(6, "Other.")], "idle", []);
    expect(labels()).toEqual([]);
  });

  it("reads a running snapshot's last reply as earlier: muted while its topic's newest", async () => {
    (await import("./topics.js")).setOpenTopics([{ problem: "auth", status: "running" }]);
    chat.renderSnapshot([
      { role: "user", text: "go", at: 1 },
      { role: "assistant", text: earlier, meta: { completedAt: 2, durationMs: 1, tokens: 1 } },
      { role: "user", text: "something else", at: 3 },
      { role: "assistant", text: "Work" },
    ], "streaming", []);
    expect(labels()).toEqual(["Ship it", "Wait"]);
    expect(doc.querySelector(".earlier-options")!.querySelectorAll("button")[0]!.getAttribute("aria-description")).toBe("option from an earlier reply");
  });

  it("hides the muted row live once a newer reply of the same topic ends", async () => {
    (await import("./topics.js")).setOpenTopics([{ problem: "auth", status: "running" }]);
    chat.appendTurn("user", "go", false, 1);
    chat.completeTurn(earlier, { completedAt: 2, durationMs: 1, tokens: 1 });
    chat.appendTurn("user", "else", false, 3);
    chat.completeTurn("Other.", { completedAt: 4, durationMs: 1, tokens: 1 });
    expect(labels()).toEqual(["Ship it", "Wait"]);
    chat.appendTurn("user", "more", false, 5);
    chat.completeTurn("<topic>auth</topic>\nStill on it.", { completedAt: 6, durationMs: 1, tokens: 1 });
    expect(labels()).toEqual([]);
  });

  it("drops a demoted group whose turn names no topic", () => {
    chat.appendTurn("user", "go", false, 1);
    chat.completeTurn("Plain.\n\n---\n[Ship it]", { completedAt: 2, durationMs: 1, tokens: 1 });
    chat.completeTurn("Other.", { completedAt: 4, durationMs: 1, tokens: 1 });
    expect(labels()).toEqual([]);
  });
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

// The final reply replaces the streamed block: the pin taken between the two
// sees the shorter pane, and its scroll event lands after the reply grew it back.
describe("tail follow across the final render", () => {
  let mutated: () => void;
  let frames: FrameRequestCallback[];
  let pane: FakeElement;
  let top: number;

  beforeEach(async () => {
    vi.resetModules();
    doc = installPage();
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("ResizeObserver", class { observe(): void {} });
    vi.stubGlobal("MutationObserver", class { constructor(cb: () => void) { mutated = cb; } observe(): void {} });
    pane = doc.querySelector("#turns")!;
    // A layout: the pane is as tall as its text, and scrollTop clamps to it.
    top = 0;
    const height = (): number => 500 + pane.textContent.length * 20;
    Object.defineProperties(pane, {
      clientHeight: { value: 500 },
      scrollHeight: { get: height },
      scrollTop: { get: () => top, set: (v: number) => { top = Math.max(0, Math.min(v, height() - 500)); } },
    });
    chat = await import("./chat.js");
    chat.initChat({
      sessionId: () => "h1", sessionCwd: () => null, sessionChannel: () => "web", sessionState: () => "streaming",
      select, send, ownTurn: vi.fn(), reload: vi.fn(async () => {}), quote,
    });
  });

  /** One frame: the scroll event — a browser fires one only when the offset
   *  moved — then the observers' re-pin. */
  let seen = 0;
  const frame = (): void => {
    if (top !== seen) pane.dispatchEvent(new Event("scroll"));
    seen = top;
    mutated();
    for (const cb of frames.splice(0)) cb(0);
  };
  const atEnd = (): boolean => top === pane.scrollHeight - 500;

  it("keeps a reader at the tail pinned to the end of the rendered reply", async () => {
    chat.appendTurn("user", "go", false, 1);
    const activity = await import("./turn-activity.js");
    activity.activityToolStart(2, "t1", "bash", { command: "ls" });
    activity.activityToolEnd("t1", false, "ok");
    chat.appendDelta("Looking at it");
    frame();
    expect(atEnd()).toBe(true);
    chat.completeTurn(`Looking at it.\n\n${"A long paragraph of the final answer. ".repeat(20)}`, { completedAt: 3, durationMs: 1, tokens: 1 });
    frame();
    expect(atEnd()).toBe(true);
  });

  it("leaves a reader who scrolled up where they are while the reply streams and lands", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      chat.appendTurn("user", "go", false, 1);
      chat.appendDelta("Looking at it. ".repeat(20));
      frame();
      expect(atEnd()).toBe(true);
      pane.scrollTop = 100;
      frame();
      const before = pane.scrollHeight;
      chat.appendDelta("More. ".repeat(20));
      vi.advanceTimersByTime(STREAM_PAINT_MS); // the coalesced paint of the second delta
      frame();
      expect(pane.scrollHeight).toBeGreaterThan(before);
      chat.completeTurn(undefined, { completedAt: 3, durationMs: 1, tokens: 1 });
      frame();
      expect(top).toBe(100);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases follow for a reader who drags up between the final render and its frame", () => {
    chat.appendTurn("user", "go", false, 1);
    chat.appendDelta("Looking at it. ".repeat(20));
    frame();
    expect(atEnd()).toBe(true);
    chat.completeTurn(`Looking at it.\n\n${"A long paragraph of the final answer. ".repeat(20)}`, { completedAt: 3, durationMs: 1, tokens: 1 });
    pane.scrollTop = 100;
    frame();
    expect(top).toBe(100);
    chat.scrollBottom(); // unforced: moves only a reader who is still followed
    frame();
    expect(top).toBe(100);
  });
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
    fake(user.querySelector("[data-action='Reply']")).onclick!();
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
    const [cut, done] = pane().querySelectorAll("[data-action='Reply']");
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

// A finger has no hover: it swipes a row to reply and holds it for the toolbar's actions.
describe("a touch on a row", () => {
  const noon = new Date(2024, 5, 1, 12, 0, 0).getTime();
  const pane = () => doc.querySelector("#turns")!;
  const written: string[] = [];
  beforeEach(() => {
    written.length = 0;
    vi.stubGlobal("window", Object.assign(new EventTarget(), { innerWidth: 390, innerHeight: 800 }));
    vi.stubGlobal("navigator", { clipboard: { writeText: async (t: string) => void written.push(t) } });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => vi.useRealTimers());
  const pointer = (row: FakeElement, type: string, x: number, y = 100, pointerType = "touch"): Event => {
    const ev = Object.assign(new Event(type, { cancelable: true }), { pointerType, isPrimary: true, clientX: x, clientY: y });
    row.dispatchEvent(ev);
    return ev;
  };
  const swipe = (row: FakeElement, to: number, dy = 0): void => {
    pointer(row, "pointerdown", 100);
    for (let x = 100; x <= 100 + to; x += 10) pointer(row, "pointermove", x, 100 + (dy * (x - 100)) / (to || 1));
  };
  const sheet = () => doc.querySelector(".glass-menu");
  const items = () => sheet()?.querySelectorAll("button").map((b) => b.textContent) ?? [];
  const pick = (label: string) => sheet()!.querySelectorAll("button").find((b) => b.textContent === label)!.onclick!();

  it("replies to a row swiped right past the threshold, the row following the finger and springing back", () => {
    const row = fake(chat.appendTurn("assistant", "Merged.", true, noon).parentElement);
    swipe(row, 70);
    expect(row.style.transform).toMatch(/^translateX\(\d+(\.\d+)?px\)$/);
    expect(row.querySelector(".swipe-hint")!.hasAttribute("data-armed")).toBe(true);
    pointer(row, "pointerup", 170);
    expect(quote).toHaveBeenCalledWith({ role: "assistant", at: noon, text: "Merged." });
    expect(row.style.transform).toBe("");
    expect(row.querySelector(".swipe-hint")).toBeNull();
  });

  it("lets go of a short swipe, a scroll, a mouse and a row with no time without replying", () => {
    const row = fake(chat.appendTurn("assistant", "Merged.", true, noon).parentElement);
    swipe(row, 30);
    pointer(row, "pointerup", 130);
    swipe(row, 70, 200); // mostly down: the pane's scroll
    expect(row.style.transform).toBe("");
    pointer(row, "pointerup", 170);
    pointer(row, "pointerdown", 100, 100, "mouse");
    pointer(row, "pointermove", 200, 100, "mouse");
    pointer(row, "pointerup", 200, 100, "mouse");
    swipe(row, 70);
    pointer(row, "pointercancel", 170);
    expect(quote).not.toHaveBeenCalled();
    expect(row.style.transform).toBe("");
    // A reply cut off before its time was recorded has no Reply to slide to.
    chat.renderSnapshot([{ role: "assistant", text: "Cut off." }], "idle", []);
    const cut = fake(pane().querySelectorAll("[data-kind='assistant']").at(-1));
    expect(fake(cut.querySelector("[data-action='Reply']")).hidden).toBe(true);
    swipe(cut, 70);
    expect(cut.style.transform ?? "").toBe("");
    pointer(cut, "pointerup", 170);
    expect(quote).not.toHaveBeenCalled();
  });

  it("holds a head's user row open to Reply, Copy, Edit and Select text, and edits from there", () => {
    const row = fake(chat.appendTurn("user", "[re user 2024-06-01 11:00]\n> gone\n\nship it", false, noon).parentElement);
    pointer(row, "pointerdown", 100);
    vi.advanceTimersByTime(450);
    expect(items()).toEqual(["Reply", "Copy", "Edit", "Select text"]);
    // The release clicks what is under the finger by then — the sheet's
    // backdrop — and that one click is the hold's, not a close.
    const click = (): boolean => {
      const ev = new Event("click", { cancelable: true });
      doc.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    doc.dispatchEvent(new Event("pointerup"));
    expect(click()).toBe(true);
    expect(click()).toBe(false);
    pick("Edit");
    expect(sheet()?.hasAttribute("data-closing") ?? true).toBe(true);
    expect(row.dataset.editing).toBe("");
    // An editing row keeps its textarea's own touch.
    pointer(row, "pointerdown", 100);
    vi.advanceTimersByTime(450);
    expect(doc.querySelectorAll(".glass-menu").filter((m) => !m.hasAttribute("data-closing"))).toEqual([]);
  });

  it("copies a reply's words without its markers, and an earlier session's rows offer no Edit", async () => {
    const row = fake(chat.appendTurn("assistant", "Merged.\n<topic>auth</topic>", true, noon).parentElement);
    pointer(row, "pointerdown", 100);
    vi.advanceTimersByTime(450);
    expect(items()).toEqual(["Reply", "Copy", "Select text"]);
    pick("Copy");
    await vi.waitFor(() => expect(row.dataset.copied).toBe("ok"));
    expect(written).toEqual(["Merged."]);
    // A second copy before the first flash fades restarts it.
    vi.advanceTimersByTime(100);
    pointer(row, "pointerdown", 100);
    vi.advanceTimersByTime(450);
    pick("Copy");
    await vi.waitFor(() => expect(written).toHaveLength(2));
    for (let i = 0; i < 5; i++) await Promise.resolve();
    vi.advanceTimersByTime(300); // past the first copy's 700 ms
    expect(row.dataset.copied).toBe("ok");
    vi.advanceTimersByTime(400);
    expect(row.dataset.copied).toBeUndefined();
    chat.renderSnapshot([{ role: "user", text: "old", at: noon }], "idle", [], true);
    const old = fake(pane().querySelectorAll("[data-kind='user']").at(-1));
    pointer(old, "pointerdown", 100);
    vi.advanceTimersByTime(450);
    expect(items()).toEqual(["Reply", "Copy", "Select text"]);
  });

  it("opens on Android's contextmenu after a cancelled touch, and the next tap on the menu is not eaten", () => {
    const row = fake(chat.appendTurn("user", "go", false, noon).parentElement);
    pointer(row, "pointerdown", 100);
    pointer(row, "pointercancel", 100);
    const menu = pointer(row, "contextmenu", 100);
    expect(menu.defaultPrevented).toBe(true);
    expect(items()).toEqual(["Reply", "Copy", "Edit", "Select text"]);
    // No release reaches the page; the tap on a menu item starts with its own press.
    doc.dispatchEvent(new Event("pointerdown"));
    const tap = new Event("click", { cancelable: true });
    doc.dispatchEvent(tap);
    expect(tap.defaultPrevented).toBe(false);
    // A contextmenu without pointerType is a touch's only while one is pressed.
    const idle = fake(chat.appendTurn("user", "and", false, noon).parentElement);
    const bare = new Event("contextmenu", { cancelable: true });
    idle.dispatchEvent(bare);
    expect(bare.defaultPrevented).toBe(false);
    // Nor on the held row once a mouse presses it: the hold is over.
    pointer(row, "pointerdown", 100, 100, "mouse");
    const right = new Event("contextmenu", { cancelable: true });
    row.dispatchEvent(right);
    expect(right.defaultPrevented).toBe(false);
  });

  it("leaves a row whose text is being selected to the platform's handles", () => {
    let selected = "";
    vi.stubGlobal("getSelection", () => ({ selectAllChildren: () => void (selected = "go"), toString: () => selected }));
    const row = fake(chat.appendTurn("user", "go", false, noon).parentElement);
    pointer(row, "pointerdown", 100);
    vi.advanceTimersByTime(450);
    pick("Select text");
    expect(row.dataset.selecting).toBe("");
    doc.dispatchEvent(new Event("pointerup"));
    vi.advanceTimersByTime(400);
    pointer(row, "pointerdown", 100);
    vi.advanceTimersByTime(450);
    expect(doc.querySelectorAll(".glass-menu").filter((m) => !m.hasAttribute("data-closing"))).toEqual([]);
    swipe(row, 70);
    expect(row.style.transform ?? "").toBe("");
    pointer(row, "pointerup", 170);
    expect(quote).not.toHaveBeenCalled();
    expect(pointer(row, "contextmenu", 100).defaultPrevented).toBe(false);
    // A collapsed selection gives the row back to the finger.
    selected = "";
    doc.dispatchEvent(new Event("selectionchange"));
    expect(row.dataset.selecting).toBeUndefined();
  });

  it("leaves a finger that moves before the hold, or holds a code span, to what it was doing", () => {
    const row = fake(chat.appendTurn("assistant", "Run `npm test` now.", true, noon).parentElement);
    pointer(row, "pointerdown", 100);
    pointer(row, "pointermove", 100, 140);
    vi.advanceTimersByTime(450);
    expect(sheet()).toBeNull();
    const code = fake(row.querySelector("code"));
    expect(code.dataset.hold).toBe("");
    const ev = Object.assign(new Event("pointerdown"), { pointerType: "touch", isPrimary: true, clientX: 100, clientY: 100 });
    Object.defineProperty(ev, "target", { value: code });
    row.dispatchEvent(ev);
    vi.advanceTimersByTime(450);
    expect(sheet()).toBeNull();
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

  describe("a topic waiting on the user", () => {
    const asks = "<open>auth — waiting on you: 60K or 80K?</open>\n60K or 80K?\n\n---\n[60K] | [80K]";
    const dotted = () => pane().querySelectorAll(".topic-tag").map((t) => t.hasAttribute("data-waiting"));
    const load = async () => {
      const topics = await import("./topics.js");
      topics.setOpenTopics([{ problem: "auth", status: "waiting on you" }]);
      chat.renderSnapshot([
        { role: "user", text: "review auth", at: 1 },
        { role: "assistant", text: asks, meta: { completedAt: 2, durationMs: 1, tokens: 1 } },
        // A callback's turn: another reply the user said nothing to.
        { role: "system", text: "done\n\nok", at: 3, origin: { kind: "task-callback", taskId: "t", runId: "r1", sourceSessionId: null, source: { taskName: "r1" }, state: "succeeded" } },
        { role: "assistant", text: "Other.", meta: { completedAt: 4, durationMs: 1, tokens: 1 } },
      ], "idle", []);
      return { topics, withQuote: (await import("../../core/identity.js")).withQuote };
    };

    it("is dotted on its tags, which name the problem alone", async () => {
      await load();
      expect(dotted()).toEqual([true, true]);
      expect(pane().querySelectorAll(".topic-tag").map((t) => t.textContent)).toEqual(["auth", "auth"]);
    });

    it("loses the dot to a pick of its option past another reply, and a live reply does not bring it back before the items do", async () => {
      const { topics, withQuote } = await load();
      doc.querySelector(".earlier-options")!.querySelectorAll("button")[1]!.onclick!();
      const [, label, quote] = send.mock.lastCall as [string, string, { role: "assistant"; at: number; text: string }];
      // What the composer renders for a pick (composer.ts send).
      chat.appendTurn("user", withQuote(quote, label), false, 5);
      expect(dotted()).toEqual([false, false]);
      // Ends while the items on hand still say `waiting on you`: not asking again yet.
      chat.completeTurn(asks, { completedAt: 6, durationMs: 1, tokens: 1 });
      expect(dotted()).toEqual([false, false, false, false]);
      topics.setOpenTopics([{ problem: "auth", status: "waiting on you" }]);
      expect(dotted()).toEqual([true, true, true, true]);
    });

    it("reads a quote whose words match no row as the first row of its minute", async () => {
      const { withQuote } = await load();
      chat.appendTurn("user", withQuote({ role: "assistant", at: 2, text: "words since edited away" }, "ok"), false, 5);
      expect(pane().children.filter((r) => r.dataset.kind === "user").at(-1)!.dataset.answers).toBe("auth");
      expect(dotted()).toEqual([false, false]);
    });
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
    expect(kinds()).toEqual(["fold", "assistant", "assistant"]);
    expect(chips()).toEqual(["activity"]);
    expect(stepsChip().textContent).toMatch(/^interrupted · 1 step/);
    expect(stepsChip().classList.contains("text-amber-700")).toBe(true);
    // A turn that ends on a failure: the turn-end carries it, then the error row is its result.
    activity.activityToolStart(2, "c2", "bash", {});
    activity.activityToolEnd("c2", true, "boom");
    chat.completeTurn("", undefined, "provider 529");
    expect("pending" in bubble().dataset).toBe(true);
    chat.appendTurn("error", "provider 529");
    expect(kinds()).toEqual(["fold", "assistant", "assistant", "error"]);
    expect(chips()).toEqual(["activity"]);
    expect(stepsChip().textContent).toMatch(/^failed · 1 step/);
    expect(stepsChip().classList.contains("text-red-600")).toBe(true);
    // Nothing pending: a turn that ends with nothing draws nothing.
    chat.completeTurn(undefined);
    expect(kinds()).toEqual(["fold", "assistant", "assistant", "error"]);
    // A chat command's answer is Pier's, never a turn's.
    chat.appendSystemInput("ok", { kind: "chat-command", command: "new" });
    chat.completeTurn("Hi.");
    expect(kinds()).toEqual(["fold", "assistant", "assistant", "error", "system", "assistant"]);
    expect(chipRow()).toBeUndefined();
  });

  it("folds consecutive silent replies under one closed grey line that its click opens and closes", () => {
    chat.renderSnapshot([
      { role: "user", text: "go", at: 1 },
      { role: "assistant", text: "<silent>progress: dispatched</silent>" },
      { role: "assistant", text: "<silent>progress: sent back</silent>" },
      { role: "assistant", text: "Done." },
    ], "idle", []);
    expect(kinds()).toEqual(["time", "user", "fold", "assistant", "assistant", "assistant"]);
    const rows = pane().children;
    const fold = rows[2]!.querySelector("button")!;
    expect(fold.textContent).toBe("· 2 background updates");
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(rows.map((r) => r.hidden)).toEqual([false, false, false, true, true, false]);
    // The final reply follows the line, not the hidden bubble it was grouped with.
    expect("grouped" in rows[5]!.dataset).toBe(false);
    fold.onclick?.();
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect(rows[3]!.hidden || rows[4]!.hidden).toBe(false);
    expect(rows[3]!.textContent).toContain("Stayed silent — progress: dispatched");
    fold.onclick?.();
    expect(rows[3]!.hidden && rows[4]!.hidden).toBe(true);
  });

  it("grows a fold live, keeps it closed after the final reply, and opens it for a jump to a folded reply", () => {
    chat.completeTurn("Started.");
    chat.completeTurn("<silent>one</silent>");
    const fold = () => pane().querySelector("[data-kind='fold']")!.querySelector("button")!;
    expect(kinds()).toEqual(["assistant", "fold", "assistant"]);
    expect(fold().textContent).toBe("· 1 background update");
    chat.completeTurn("<silent>two</silent>\n<topic>t</topic>");
    expect(kinds()).toEqual(["assistant", "fold", "assistant", "assistant"]);
    expect(fold().textContent).toBe("· 2 background updates");
    chat.completeTurn("All done.\n<topic>t</topic>");
    expect(fold().getAttribute("aria-expanded")).toBe("false");
    expect(pane().children.map((r) => r.hidden)).toEqual([false, false, true, true, false]);
    expect(chat.revealTopic("t")).toBe(true); // the newest reply of the topic: the final one, already shown
    expect(fold().getAttribute("aria-expanded")).toBe("false");
    pane().children[4]!.querySelector(".topic-tag")!.onclick?.(); // back to the silent reply before it
    expect(fold().getAttribute("aria-expanded")).toBe("true");
    expect(pane().children[3]!.hidden).toBe(false);
  });

  it("leaves a silent reply out of the fold while a cause of it failed or was cut short", () => {
    chat.renderSnapshot([
      { role: "assistant", text: "<silent>one</silent>" },
      { role: "system", text: "x\n\nboom", origin: { kind: "task-callback", taskId: "t", runId: "r1", sourceSessionId: null, state: "failed" } },
      { role: "assistant", text: "<silent>saw the failure</silent>" },
      { role: "system", text: "x\n\ncut", origin: { kind: "task-callback", taskId: "t", runId: "r2", sourceSessionId: null, state: "interrupted" } },
      { role: "assistant", text: "<silent>saw the cut</silent>" },
      { role: "assistant", text: "<silent>two</silent>" },
    ], "idle", []);
    expect(kinds()).toEqual(["fold", "assistant", "assistant", "assistant", "fold", "assistant"]);
    expect(pane().children.map((r) => r.hidden)).toEqual([false, true, false, false, false, true]);
    expect(pane().children[2]!.textContent).toContain("Stayed silent — saw the failure");
    expect(pane().children[4]!.querySelector("button")!.textContent).toBe("· 1 background update");
  });

  it("lets a folded reply go while a run it launched is in flight, and folds it again at the next reply", () => {
    chat.completeTurn("<silent>launched</silent>");
    expect(kinds()).toEqual(["fold", "assistant"]);
    activity.renderBackgroundRun(run("r1"));
    expect(kinds()).toEqual(["assistant"]);
    expect(bubble().hidden).toBe(false);
    expect(chips()).toEqual(["background-run"]);
    activity.renderBackgroundRun(run("r1", { state: "succeeded", finishedAt: 2 }));
    chat.completeTurn("<silent>it finished</silent>");
    expect(kinds()).toEqual(["fold", "assistant", "assistant"]);
    expect(pane().children[0]!.querySelector("button")!.textContent).toBe("· 2 background updates");
  });

  it("never groups a reply, streaming or final, with the folded reply above it", () => {
    chat.completeTurn("Started.");
    chat.completeTurn("<silent>quiet</silent>");
    chat.appendDelta("Here it");
    const tail = () => pane().children.at(-1)!;
    expect("grouped" in tail().dataset).toBe(false);
    chat.completeTurn("Here it is.");
    expect(kinds()).toEqual(["assistant", "fold", "assistant", "assistant"]);
    expect("grouped" in tail().dataset).toBe(false);
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
