// System rows on index.html: the `/status` card opens its runs' sessions, and
// seeds, callbacks and delegations fold to one line that opens in place.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SystemInputOrigin } from "../../core/types.js";
import { installPage, type FakeDocument } from "./dom.testkit.js";

let doc: FakeDocument;
let chat: typeof import("./chat.js");
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

it("folds a callback to state, name, model and run id, and opens and closes on its button", () => {
  chat.appendSystemInput('Task "fix it" finished with state: succeeded\nrun r1\n\nAll green.', {
    kind: "task-callback", taskId: "t1", runId: "run45678xyz", sourceSessionId: "s-run",
    source: { taskName: "fix it", model, thinking: "high" }, state: "succeeded",
  });
  expect(line()).toBe("callback · succeededfix it");
  expect(card().querySelector(".run-id")!.textContent).toBe("run45678");
  expect(card().textContent).toContain("claude-x");
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
